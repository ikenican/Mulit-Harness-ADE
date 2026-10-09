// Cowork 的 Electron 接線：能力檢查、IPC、把 run 的變化廣播給所有視窗。
// 會議本身在 ../cowork/orchestrator.ts；這裡只負責「跟 app 有關的部分」。
import { app, ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync, execFile } from 'child_process'
import { EventEmitter } from 'events'
import { CoworkService, CoworkError, type ResolvedCli } from '../cowork/orchestrator'
import { readBaseline } from '../cowork/git'
import { launchPlan, runProcess } from '../cowork/runner'
import { findAgentCli } from '../ext/paths'
import { loadSettings, saveSettings, isCliBypassPermissions } from './settings'
import { buildInventory } from '../ext/inventory'
import type { ExecCli } from '../cowork/executor'
import { getWorkspaceForEvent } from '../index'
import {
  COWORK_AGENTS,
  agyIsolationSettings,
  sanitizeCoworkSettings,
  sanitizeModelChoice,
  sanitizeModelChoices,
  AGY_DEFAULT_EFFORT,
  groupAgyModels,
  parseClaudeModelCatalog,
  type CoworkModelCatalog,
  type CoworkAgent,
  type CoworkCapability,
  type CoworkBaselineInfo,
  type CoworkResult,
  type CoworkRun
} from '../../shared/cowork'

/** 每家 CLI 規劃時必須支援的 flag；舊版沒有就不能保證唯讀（cowork.md §3） */
const REQUIRED_FLAGS: Partial<Record<CoworkAgent, { args: string[]; flags: string[] }>> = {
  claude: { args: ['--help'], flags: ['--json-schema', '--restricted', '--safe-mode', '--strict-mcp-config', '--permission-prompts', '--no-session-persistence'] },
  codex: { args: ['exec', '--help'], flags: ['--output-schema', '--ignore-user-config', '--ephemeral', '--sandbox'] },
  antigravity: { args: ['--help'], flags: ['--input-format', '--json-schema', '--sandbox', '--effort'] }
}

const helpCache = new Map<string, boolean>()

function supportsFlags(cliPath: string, agent: CoworkAgent): boolean {
  const req = REQUIRED_FLAGS[agent]
  if (!req) return false
  let key = cliPath
  try {
    key += `:${fs.statSync(cliPath).mtimeMs}`
  } catch {
    /* 純指令名稱 */
  }
  const hit = helpCache.get(key)
  if (hit !== undefined) return hit
  let ok = false
  try {
    const plan = launchPlan(cliPath, req.args)
    if (!('error' in plan)) {
      const r = spawnSync(plan.file, plan.args, {
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
        windowsVerbatimArguments: plan.verbatim,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      ok = r.status === 0 && req.flags.every((f) => `${r.stdout}${r.stderr}`.includes(f))
    }
  } catch {
    ok = false
  }
  helpCache.set(key, ok)
  return ok
}

/**
 * codex 規劃時用 --ignore-user-config 排除使用者的 MCP 與外掛，但 Windows sandbox 設定也會一起丟掉，
 * 少了它 read-only 模式連讀檔都會被擋（2026-10-07 實測）。從使用者設定讀出這一項補回去。
 */
export function readCodexWindowsSandbox(): string | null {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  let text: string
  try {
    text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8')
  } catch {
    return null
  }
  let inWindows = false
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (section) {
      inWindows = section[1].trim() === 'windows'
      continue
    }
    if (!inWindows) continue
    const m = line.match(/^\s*sandbox\s*=\s*"([^"]*)"/)
    // 這個值會接進 -c windows.sandbox="..."：只收安全字元
    if (m && /^[a-z][a-z0-9_-]{0,31}$/i.test(m[1])) return m[1]
  }
  return null
}

/** codex 使用者 config.toml 最上層的 model 與 model_reasoning_effort（規劃時忽略整份設定，所以要自己補回來） */
export function readCodexUserModel(): { model: string; effort: string } {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  let text = ''
  try {
    text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8')
  } catch {
    return { model: '', effort: '' }
  }
  let model = ''
  let effort = ''
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break // 只看最上層，不看 [profiles.x] 之類的區段
    const m = line.match(/^\s*(model|model_reasoning_effort)\s*=\s*"([^"]*)"/)
    if (m && m[1] === 'model') model = m[2]
    if (m && m[1] === 'model_reasoning_effort') effort = m[2]
  }
  return sanitizeModelChoice({ model, effort })
}

// ── 模型清單：給設定頁與開會表單選 ─────────────────────────────────

/** 跑一個列清單的 CLI 子命令；.cmd 一樣經 launchPlan 安全處理 */
function runList(cmd: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const plan = launchPlan(cmd, args)
    if ('error' in plan) return reject(new Error(plan.error))
    execFile(
      plan.file,
      plan.args,
      {
        encoding: 'utf8',
        timeout: 45000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: plan.verbatim,
        env: env ? { ...process.env, ...env } : process.env
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
  })
}

/** ~/.claude/settings.json 的 model（claude 規劃時仍會套用，只是拿來顯示「預設」是什麼） */
function readClaudeUserModel(): string {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'))
    return sanitizeModelChoice({ model: j?.model, effort: '' }).model
  } catch {
    return ''
  }
}

async function loadCatalog(agent: CoworkAgent): Promise<CoworkModelCatalog> {
  const cap = capabilities().find((c) => c.agent === agent)
  if (agent === 'claude') {
    const user = readClaudeUserModel()
    const fallback = { model: user, effort: '', source: user ? ('user-config' as const) : ('cli-default' as const) }
    if (!cap?.path) return { agent, options: [], fallback, error: 'not-installed' }
    try {
      const result = await runProcess({
        command: cap.path,
        args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--safe-mode', '--strict-mcp-config'],
        cwd: os.homedir(),
        stdin: JSON.stringify({ type: 'control_request', request_id: 'cowork-models', request: { subtype: 'initialize' } }) + '\n',
        timeoutMs: 20000, maxBytes: 1024 * 1024
      })
      if (result.spawnError || result.timedOut || result.code !== 0) throw new Error(result.spawnError || 'Could not read Claude models')
      return parseClaudeModelCatalog(result.stdout, user)
    } catch (e) {
      return { agent, options: [], fallback, error: (e as Error).message.slice(0, 200) }
    }
  }
  if (agent === 'codex') {
    const user = readCodexUserModel()
    const fallback = { model: user.model, effort: user.effort, source: user.model ? ('user-config' as const) : ('cli-default' as const) }
    if (!cap?.path) return { agent, options: [], fallback, error: 'not-installed' }
    try {
      // codex debug models 輸出模型目錄，含每個模型支援的強度（2026-10-08 實測）
      const j = JSON.parse(await runList(cap.path, ['debug', 'models']))
      const models: any[] = Array.isArray(j?.models) ? j.models : []
      const options = models
        .filter((m) => m?.visibility === 'list' && typeof m.slug === 'string')
        .map((m) => ({
          id: m.slug as string,
          label: typeof m.display_name === 'string' ? m.display_name : m.slug,
          efforts: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
            .map((x: any) => (typeof x === 'string' ? x : x?.effort))
            .filter((x: unknown): x is string => typeof x === 'string'),
          defaultEffort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : undefined
        }))
      return { agent, options, fallback }
    } catch (e) {
      return { agent, options: [], fallback, error: (e as Error).message.slice(0, 200) }
    }
  }
  const fallback = { model: '', effort: AGY_DEFAULT_EFFORT, source: 'cli-default' as const }
  if (!cap?.path) return { agent, options: [], fallback, error: 'not-installed' }
  try {
    // agy models：每行「id<TAB>名稱」；用隔離家目錄跑，不碰使用者自己的 agy 狀態
    const out = await runList(cap.path, ['models'], prepareAgyHome())
    const list = out
      .split(/\r?\n/)
      .map((l) => l.split('\t'))
      .filter((p) => p.length >= 2 && sanitizeModelChoice({ model: p[0].trim(), effort: '' }).model)
      .map((p) => ({ id: p[0].trim(), label: p[1].trim() }))
    // gemini-3.8-flash-high／-medium／-low 合併成一個模型＋三種強度（agy 的 ID 本身就帶強度）
    return { agent, options: groupAgyModels(list), fallback }
  } catch (e) {
    return { agent, options: [], fallback, error: (e as Error).message.slice(0, 200) }
  }
}

const catalogCache = new Map<CoworkAgent, { at: number; value: Promise<CoworkModelCatalog> }>()
const knownCatalogs = new Map<CoworkAgent, CoworkModelCatalog>()
const CATALOG_TTL_MS = 10 * 60 * 1000

function modelCatalog(agent: CoworkAgent, force: boolean): Promise<CoworkModelCatalog> {
  const hit = catalogCache.get(agent)
  if (!force && hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value
  const value = loadCatalog(agent)
  catalogCache.set(agent, { at: Date.now(), value })
  // 失敗的結果不要快取太久
  value.then((c) => { knownCatalogs.set(agent, c); if (c.error) catalogCache.delete(agent) }).catch(() => catalogCache.delete(agent))
  return value
}

let capCache: { at: number; caps: CoworkCapability[] } | null = null
const CAP_TTL_MS = 15000

function capabilities(force = false): CoworkCapability[] {
  if (!force && capCache && Date.now() - capCache.at < CAP_TTL_MS) return capCache.caps
  const settings = loadSettings()
  const caps = COWORK_AGENTS.map((agent): CoworkCapability => {
    const enabled = settings.cliEnabled?.[agent] !== false
    const cliPath = findAgentCli(agent)
    if (!cliPath) return { agent, enabled, path: null, planning: false, reason: 'not-installed' }
    if (!supportsFlags(cliPath, agent)) return { agent, enabled, path: cliPath, planning: false, reason: 'cli-too-old' }
    if (agent === 'codex' && process.platform === 'win32' && !readCodexWindowsSandbox()) {
      return { agent, enabled, path: cliPath, planning: false, reason: 'codex-no-windows-sandbox' }
    }
    return { agent, enabled, path: cliPath, planning: true }
  })
  capCache = { at: Date.now(), caps }
  return caps
}

function resolveCli(agent: CoworkAgent): ResolvedCli | { error: string } {
  const cap = capabilities().find((c) => c.agent === agent)
  if (!cap) return { error: 'unknown agent' }
  if (!cap.enabled) return { error: 'disabled in Settings' }
  if (!cap.planning || !cap.path) return { error: cap.reason || 'not available' }
  const modelEfforts = Object.fromEntries((knownCatalogs.get(agent)?.options || []).filter((o) => o.efforts !== undefined).flatMap((o) => [o.id, o.resolvedModel].filter(Boolean).map((id) => [id!, o.efforts!])))
  if (agent === 'antigravity') {
    try {
      return { command: cap.path, env: prepareAgyHome(), modelEfforts }
    } catch (e) {
      return { error: `could not prepare the isolated Antigravity home: ${(e as Error).message}` }
    }
  }
  if (agent === 'codex') {
    // 使用者沒選模型時沿用他 config.toml 的值，不讓 --ignore-user-config 悄悄換掉模型
    const user = readCodexUserModel()
    return {
      command: cap.path,
      windowsSandbox: process.platform === 'win32' ? readCodexWindowsSandbox() : null,
      defaultModel: user.model,
      defaultEffort: user.effort,
      modelEfforts
    }
  }
  return { command: cap.path, modelEfforts, defaultModel: readClaudeUserModel() || knownCatalogs.get(agent)?.fallback.model || '' }
}

/** 背景執行：使用者平常的 CLI 與完整設定（MCP／skill／外掛／hook 照常載入），不用規劃時的隔離家目錄 */
function resolveExecCli(agent: CoworkAgent): ExecCli | { error: string } {
  const cap = capabilities().find((c) => c.agent === agent)
  if (!cap) return { error: 'unknown agent' }
  if (!cap.enabled) return { error: 'disabled in Settings' }
  if (!cap.path) return { error: cap.reason || 'not installed' }
  return { command: cap.path }
}

const MAX_SKILL_BYTES = 24 * 1024

/**
 * 設定裡勾選的 skill → SKILL.md 內容。路徑一律由這裡從盤點結果找，不信任 renderer 傳來的路徑；
 * 同一個 skill 裝在多家時取第一個讀得到的。
 */
function readSelectedSkills(workspace: string, keys: string[]): { key: string; name: string; content: string }[] {
  if (!keys.length) return []
  let items
  try {
    items = buildInventory(workspace, new Set())
  } catch {
    return []
  }
  const out: { key: string; name: string; content: string }[] = []
  for (const key of keys) {
    const item = items.find((i) => i.kind === 'skill' && i.id === key)
    if (!item) continue
    for (const a of item.agents) {
      if (!a.detail || path.basename(a.detail) !== 'SKILL.md') continue
      try {
        out.push({ key, name: item.name, content: fs.readFileSync(a.detail, 'utf8').slice(0, MAX_SKILL_BYTES) })
        break
      } catch {
        /* 換下一家 */
      }
    }
  }
  return out
}

/**
 * agy 沒有 flag 能在單次執行停用使用者的全域 MCP／外掛／hooks，所以規劃時給它一個隔離的家目錄
 * （Go 在 Windows 以 USERPROFILE 找家目錄）。登入憑證在 OS 認證管理員，不受影響（2026-10-08 實測）。
 * 所有會議共用這一份；權限規則每次都重寫，確保沒被改過。
 */
function prepareAgyHome(): Record<string, string> {
  const home = path.join(app.getPath('userData'), 'cowork', 'agy-home')
  const settingsFile = path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  // 外掛、MCP 設定與 hooks 都不該出現在這裡；有就清掉
  for (const stale of [path.join(home, '.gemini', 'config'), path.join(home, '.gemini', 'antigravity-cli', 'mcp')]) {
    fs.rmSync(stale, { recursive: true, force: true })
  }
  fs.writeFileSync(settingsFile, JSON.stringify(agyIsolationSettings(home), null, 2))
  return { USERPROFILE: home, HOME: home }
}

/** codex 的 Windows sandbox 讀不到使用者目錄（實測）；repo 在那底下時先提醒，執行時也會偵測 */
function repoWarnings(commonDir: string): string[] {
  if (process.platform !== 'win32') return []
  const home = os.homedir().toLowerCase()
  return commonDir.toLowerCase().startsWith(home + path.sep) ? ['codex-repo-in-profile'] : []
}

async function baselineInfo(workspace: string): Promise<CoworkBaselineInfo> {
  try {
    const b = await readBaseline(workspace)
    return {
      ok: true,
      root: b.root,
      branch: b.branch,
      head: b.head,
      dirty: b.dirty.slice(0, 200),
      dirtyCount: b.dirty.length,
      warnings: [...b.warnings, ...repoWarnings(b.commonDir)]
    }
  } catch (e) {
    return { ok: false, code: (e as Error).message }
  }
}

let service: CoworkService | null = null

/** run 有變化就發 'update'（Remote Bridge 轉給手機） */
export const coworkEvents = new EventEmitter()

function broadcast(run: CoworkRun): void {
  coworkEvents.emit('update', run)
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send('cowork:update', run)
    } catch {
      /* 視窗正在關 */
    }
  }
}

/** 包成 {ok, data} / {ok:false, code}：Electron 跨 IPC 丟例外只會剩一串字 */
async function wrap<T>(fn: () => T | Promise<T>): Promise<CoworkResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    if (e instanceof CoworkError) return { ok: false, code: e.code, message: e.message, data: e.data }
    console.error('[cowork]', e)
    return { ok: false, code: 'internal', message: (e as Error).message }
  }
}

function svc(): CoworkService {
  if (!service) throw new CoworkError('not-ready')
  return service
}

export function shutdownCowork(): void {
  service?.shutdown()
}

type StartRequest = { prompt: string; chair: CoworkAgent; participants: CoworkAgent[]; language: 'en' | 'zh-TW'; models?: unknown; mode?: 'discussion' | 'project'; autoEffort?: boolean; summarizer?: CoworkAgent; summarizeEachRound?: boolean }

async function startRun(workspace: string, req: StartRequest): Promise<CoworkRun> {
  const settings = loadSettings()
  const cw = sanitizeCoworkSettings(settings.cowork)
  const participants = Array.isArray(req?.participants) ? req.participants.filter((a) => COWORK_AGENTS.includes(a)) : []
  const run = await svc().start({
    mode: req?.mode === 'discussion' ? 'discussion' : 'project',
    autoEffort: req?.autoEffort !== false,
    summarizer: req?.summarizer || (cw.summarizer && participants.includes(cw.summarizer) ? cw.summarizer : undefined),
    summarizeEachRound: req?.summarizeEachRound ?? cw.summarizeEachRound,
    workspace,
    skills: req?.mode === 'discussion' ? [] : readSelectedSkills(workspace, cw.skills),
    projectInstructions: cw.projectInstructions,
    prompt: req?.prompt,
    chair: req?.chair,
    participants,
    chairExecutes: cw.chairExecutes,
    language: req?.language === 'zh-TW' ? 'zh-TW' : 'en',
    limits: cw.limits,
    // 手機不帶模型：沿用設定裡記住的，免得下面「記住選擇」把它清掉
    models: sanitizeModelChoices(req?.models ?? cw.models)
  })
  // 主席、與會者與各家模型：開會時的選擇記住，下次預設帶出來（cowork.md §8）
  // 這場與會者的選擇覆蓋舊值；選回「預設」就把舊值清掉
  const models = { ...cw.models }
  for (const a of run.participants) {
    if (run.models[a]) models[a] = run.models[a]
    else delete models[a]
  }
  if (
    cw.chair !== run.chair ||
    cw.participants.join() !== run.participants.join() ||
    JSON.stringify(cw.models) !== JSON.stringify(models) ||
    (run.discussion && (cw.summarizer !== run.discussion.summarizer || cw.summarizeEachRound !== run.discussion.summarizeEachRound))
  ) {
    saveSettings({ ...loadSettings(), cowork: { ...cw, chair: run.chair, participants: run.participants, models, ...(run.discussion ? { summarizer: run.discussion.summarizer || null, summarizeEachRound: run.discussion.summarizeEachRound === true } : {}) } })
  }
  return run
}

/**
 * 每個 Cowork 操作：第一個參數是呼叫端的工作區，其餘照 preload 傳的順序。
 * 桌面走 ipcMain（cowork:<key>），手機走 Remote Bridge（invokeCowork）；兩邊同一份。
 */
const ops: Record<string, (workspace: string, ...args: any[]) => unknown> = {
  capabilities: async (workspace, force?: boolean) => {
    const cw = sanitizeCoworkSettings(loadSettings().cowork)
    return { agents: capabilities(!!force), baseline: await baselineInfo(workspace), defaults: { chair: cw.chair, participants: cw.participants } }
  },
  models: (_w, force?: boolean) => Promise.all(COWORK_AGENTS.map((a) => modelCatalog(a, !!force))),
  list: (workspace) => svc().list(workspace),
  get: (_w, runId: string) => svc().get(String(runId)),
  start: (workspace, req: StartRequest) => startRun(workspace, req),
  cancel: (_w, runId: string) => svc().cancel(String(runId)),
  discuss: (_w, runId: string, text: string) => svc().discuss(String(runId), String(text ?? '')),
  summarizer: (_w, runId: string, agent: CoworkAgent) => svc().setSummarizer(String(runId), agent),
  summarize: (_w, runId: string, conclude?: boolean) => svc().summarizeDiscussion(String(runId), conclude === true),
  retry: (_w, runId: string) => svc().retry(String(runId)),
  drop: (_w, runId: string) => svc().dropFailedReviewers(String(runId)),
  note: (_w, runId: string, text: string) => svc().addNote(String(runId), String(text ?? '')),
  feedback: (_w, runId: string, text: string) => svc().feedback(String(runId), String(text ?? '')),
  editBoard: (_w, runId: string, basePlanRevision: number, tasks: unknown) => svc().editBoard(String(runId), Number(basePlanRevision), tasks),
  dismiss: (_w, runId: string) => svc().dismissUnresolved(String(runId)),
  approve: (_w, runId: string, planRevision: number) => svc().approve(String(runId), Number(planRevision)),
  raiseLimits: (_w, runId: string, limits: { maxPlanningCalls?: number; maxPlanningMinutes?: number }) =>
    svc().raiseLimits(String(runId), {
      maxPlanningCalls: Number(limits?.maxPlanningCalls) || 0,
      maxPlanningMinutes: Number(limits?.maxPlanningMinutes) || 0
    }),
  logDispatch: (_w, runId: string, taskId: string, target: string) => svc().logDispatch(String(runId), String(taskId), String(target ?? '')),
  delete: (_w, runId: string) => svc().delete(String(runId)),
  // 背景執行：權限照使用者目前的 Bypass 設定（開始時記下來，整場沿用）
  execStart: (_w, runId: string, opts: { mode?: string; linkDeps?: boolean }) =>
    svc().execStart(String(runId), {
      mode: opts?.mode === 'parallel' ? 'parallel' : 'sequential',
      linkDeps: opts?.linkDeps !== false,
      bypass: isCliBypassPermissions()
    }),
  execMessage: (_w, runId: string, taskId: string, text: string) => svc().execMessage(String(runId), String(taskId), String(text ?? '')),
  execRetry: (_w, runId: string, taskId: string) => svc().execRetry(String(runId), String(taskId)),
  execPause: (_w, runId: string) => svc().execPause(String(runId)),
  execResume: (_w, runId: string) => svc().execResume(String(runId)),
  execMerge: (_w, runId: string) => svc().execMerge(String(runId)),
  execCleanup: (_w, runId: string) => svc().execCleanup(String(runId)),
  bypass: () => isCliBypassPermissions()
}

/** 手機（Remote Bridge）呼叫 Cowork：workspace 由桌面依視窗決定，不信任手機傳路徑 */
export function invokeCowork(op: string, workspace: string, args: unknown[]): Promise<CoworkResult<unknown>> {
  const fn = Object.hasOwn(ops, op) ? ops[op] : null
  if (!fn || !Array.isArray(args)) return Promise.resolve({ ok: false, code: 'unknown-op' })
  return wrap(() => fn(workspace, ...args))
}

export function registerCoworkHandlers(): void {
  service = new CoworkService({ dataDir: path.join(app.getPath('userData'), 'cowork'), resolveCli, resolveExecCli, emit: broadcast })
  try {
    service.init()
  } catch (e) {
    console.error('[cowork] failed to load runs', e)
  }
  for (const [op, fn] of Object.entries(ops)) {
    ipcMain.handle(`cowork:${op}`, async (event, ...args) => wrap(() => fn(getWorkspaceForEvent(event), ...args)))
  }
}
