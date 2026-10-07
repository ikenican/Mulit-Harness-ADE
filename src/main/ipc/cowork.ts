// Cowork 的 Electron 接線：能力檢查、IPC、把 run 的變化廣播給所有視窗。
// 會議本身在 ../cowork/orchestrator.ts；這裡只負責「跟 app 有關的部分」。
import { app, ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync, execFile } from 'child_process'
import { CoworkService, CoworkError, type ResolvedCli } from '../cowork/orchestrator'
import { readBaseline } from '../cowork/git'
import { launchPlan } from '../cowork/runner'
import { findAgentCli } from '../ext/paths'
import { loadSettings, saveSettings } from './settings'
import { getWorkspaceForEvent } from '../index'
import {
  COWORK_AGENTS,
  agyIsolationSettings,
  sanitizeCoworkSettings,
  sanitizeModelChoice,
  sanitizeModelChoices,
  AGY_DEFAULT_EFFORT,
  groupAgyModels,
  type CoworkModelCatalog,
  type CoworkModelOption,
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

const CLAUDE_ALIASES: CoworkModelOption[] = [
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' }
]

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
    return {
      agent,
      options: CLAUDE_ALIASES,
      fallback: { model: user, effort: '', source: user ? 'user-config' : 'cli-default' }
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
const CATALOG_TTL_MS = 10 * 60 * 1000

function modelCatalog(agent: CoworkAgent, force: boolean): Promise<CoworkModelCatalog> {
  const hit = catalogCache.get(agent)
  if (!force && hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value
  const value = loadCatalog(agent)
  catalogCache.set(agent, { at: Date.now(), value })
  // 失敗的結果不要快取太久
  value.then((c) => c.error && catalogCache.delete(agent)).catch(() => catalogCache.delete(agent))
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
  if (agent === 'antigravity') {
    try {
      return { command: cap.path, env: prepareAgyHome() }
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
      defaultEffort: user.effort
    }
  }
  return { command: cap.path }
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

function broadcast(run: CoworkRun): void {
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

export function registerCoworkHandlers(): void {
  service = new CoworkService({ dataDir: path.join(app.getPath('userData'), 'cowork'), resolveCli, emit: broadcast })
  try {
    service.init()
  } catch (e) {
    console.error('[cowork] failed to load runs', e)
  }

  ipcMain.handle('cowork:capabilities', async (event, force?: boolean) =>
    wrap(async () => ({ agents: capabilities(!!force), baseline: await baselineInfo(getWorkspaceForEvent(event)) }))
  )
  ipcMain.handle('cowork:models', async (_e, force?: boolean) =>
    wrap(() => Promise.all(COWORK_AGENTS.map((a) => modelCatalog(a, !!force))))
  )
  ipcMain.handle('cowork:list', async (event) => wrap(() => svc().list(getWorkspaceForEvent(event))))
  ipcMain.handle('cowork:get', async (_e, runId: string) => wrap(() => svc().get(String(runId))))
  ipcMain.handle(
    'cowork:start',
    async (
      event,
      req: { prompt: string; chair: CoworkAgent; participants: CoworkAgent[]; language: 'en' | 'zh-TW'; models?: unknown }
    ) =>
      wrap(async () => {
        const settings = loadSettings()
        const cw = sanitizeCoworkSettings(settings.cowork)
        const participants = Array.isArray(req?.participants) ? req.participants.filter((a) => COWORK_AGENTS.includes(a)) : []
        const run = await svc().start({
          workspace: getWorkspaceForEvent(event),
          prompt: req?.prompt,
          chair: req?.chair,
          participants,
          chairExecutes: cw.chairExecutes,
          language: req?.language === 'zh-TW' ? 'zh-TW' : 'en',
          limits: cw.limits,
          models: sanitizeModelChoices(req?.models)
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
          JSON.stringify(cw.models) !== JSON.stringify(models)
        ) {
          saveSettings({ ...loadSettings(), cowork: { ...cw, chair: run.chair, participants: run.participants, models } })
        }
        return run
      })
  )
  ipcMain.handle('cowork:cancel', async (_e, runId: string) => wrap(() => svc().cancel(String(runId))))
  ipcMain.handle('cowork:retry', async (_e, runId: string) => wrap(() => svc().retry(String(runId))))
  ipcMain.handle('cowork:drop', async (_e, runId: string) => wrap(() => svc().dropFailedReviewers(String(runId))))
  ipcMain.handle('cowork:note', async (_e, runId: string, text: string) => wrap(() => svc().addNote(String(runId), String(text ?? ''))))
  ipcMain.handle('cowork:feedback', async (_e, runId: string, text: string) =>
    wrap(() => svc().feedback(String(runId), String(text ?? '')))
  )
  ipcMain.handle('cowork:editBoard', async (_e, runId: string, basePlanRevision: number, tasks: unknown) =>
    wrap(() => svc().editBoard(String(runId), Number(basePlanRevision), tasks))
  )
  ipcMain.handle('cowork:dismiss', async (_e, runId: string) => wrap(() => svc().dismissUnresolved(String(runId))))
  ipcMain.handle('cowork:approve', async (_e, runId: string, planRevision: number) =>
    wrap(() => svc().approve(String(runId), Number(planRevision)))
  )
  ipcMain.handle('cowork:raiseLimits', async (_e, runId: string, limits: { maxPlanningCalls?: number; maxPlanningMinutes?: number }) =>
    wrap(() =>
      svc().raiseLimits(String(runId), {
        maxPlanningCalls: Number(limits?.maxPlanningCalls) || 0,
        maxPlanningMinutes: Number(limits?.maxPlanningMinutes) || 0
      })
    )
  )
  ipcMain.handle('cowork:logDispatch', async (_e, runId: string, taskId: string, target: string) =>
    wrap(() => svc().logDispatch(String(runId), String(taskId), String(target ?? '')))
  )
  ipcMain.handle('cowork:delete', async (_e, runId: string) => wrap(() => svc().delete(String(runId))))
}
