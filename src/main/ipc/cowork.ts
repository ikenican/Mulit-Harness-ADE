// Cowork 的 Electron 接線：能力檢查、IPC、把 run 的變化廣播給所有視窗。
// 會議本身在 ../cowork/orchestrator.ts；這裡只負責「跟 app 有關的部分」。
import { app, ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { CoworkService, CoworkError, type ResolvedCli } from '../cowork/orchestrator'
import { readBaseline } from '../cowork/git'
import { launchPlan } from '../cowork/runner'
import { findAgentCli } from '../ext/paths'
import { loadSettings, saveSettings } from './settings'
import { getWorkspaceForEvent } from '../index'
import {
  COWORK_AGENTS,
  sanitizeCoworkSettings,
  type CoworkAgent,
  type CoworkCapability,
  type CoworkBaselineInfo,
  type CoworkResult,
  type CoworkRun
} from '../../shared/cowork'

/** 每家 CLI 規劃時必須支援的 flag；舊版沒有就不能保證唯讀（cowork.md §3） */
const REQUIRED_FLAGS: Partial<Record<CoworkAgent, { args: string[]; flags: string[] }>> = {
  claude: { args: ['--help'], flags: ['--json-schema', '--restricted', '--safe-mode', '--strict-mcp-config', '--permission-prompts', '--no-session-persistence'] },
  codex: { args: ['exec', '--help'], flags: ['--output-schema', '--ignore-user-config', '--ephemeral', '--sandbox'] }
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

let capCache: { at: number; caps: CoworkCapability[] } | null = null
const CAP_TTL_MS = 15000

function capabilities(force = false): CoworkCapability[] {
  if (!force && capCache && Date.now() - capCache.at < CAP_TTL_MS) return capCache.caps
  const settings = loadSettings()
  const caps = COWORK_AGENTS.map((agent): CoworkCapability => {
    const enabled = settings.cliEnabled?.[agent] !== false
    if (agent === 'antigravity') {
      // agy 沒有 flag 能在單次執行停用全域 MCP，唯讀規劃無法保證（cowork.md §3.1）
      return { agent, enabled, path: findAgentCli(agent), planning: false, reason: 'antigravity-unsupported' }
    }
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
  return { command: cap.path, windowsSandbox: agent === 'codex' && process.platform === 'win32' ? readCodexWindowsSandbox() : null }
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
  ipcMain.handle('cowork:list', async (event) => wrap(() => svc().list(getWorkspaceForEvent(event))))
  ipcMain.handle('cowork:get', async (_e, runId: string) => wrap(() => svc().get(String(runId))))
  ipcMain.handle(
    'cowork:start',
    async (event, req: { prompt: string; chair: CoworkAgent; participants: CoworkAgent[]; language: 'en' | 'zh-TW' }) =>
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
          limits: cw.limits
        })
        // 主席與與會者第一次明確選擇之後記住（cowork.md §8）
        if (cw.chair !== run.chair || cw.participants.join() !== run.participants.join()) {
          saveSettings({ ...loadSettings(), cowork: { ...cw, chair: run.chair, participants: run.participants } })
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
