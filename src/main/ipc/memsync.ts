// 記憶同步的 Electron 接線：設定檔、gh／git 的位置、IPC。流程本身在 ../memsync/core.ts。
// 設定存在 userData/memory-sync.json，每台電腦各自一份；這一頁的動作立即生效，不經過設定頁的「儲存」。
import { app, ipcMain, shell } from 'electron'
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { findCliAsync } from '../ext/paths'
import { getWorkspaceForEvent } from '../index'
import {
  DEFAULT_REPO_NAME,
  MemSyncError,
  cloneState,
  defaultClonePath,
  ensureRepo,
  ghStatus,
  linkProject,
  projectState,
  syncNow,
  type Run,
  type Tools
} from '../memsync/core'
import type { MemSyncConfig, MemSyncState, MemSyncResult } from '../../preload/index'

const configFile = (): string => path.join(app.getPath('userData'), 'memory-sync.json')

function defaults(): MemSyncConfig {
  return { consentAt: null, repo: DEFAULT_REPO_NAME, clonePath: defaultClonePath(), autoPull: true, repoFull: null, login: null }
}

export function loadMemSyncConfig(): MemSyncConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    const d = defaults()
    return {
      consentAt: typeof raw.consentAt === 'number' ? raw.consentAt : null,
      repo: typeof raw.repo === 'string' && raw.repo.trim() ? raw.repo.trim() : d.repo,
      clonePath: typeof raw.clonePath === 'string' && path.isAbsolute(raw.clonePath) ? raw.clonePath : d.clonePath,
      autoPull: raw.autoPull !== false,
      repoFull: typeof raw.repoFull === 'string' ? raw.repoFull : null,
      login: typeof raw.login === 'string' ? raw.login : null
    }
  } catch {
    return defaults()
  }
}

function saveConfig(c: MemSyncConfig): void {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2))
}

// git／gh 一律關掉互動提示：背景執行時沒人能回答，寧可失敗回報也不要卡住
const run: Run = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts?.cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: opts?.timeoutMs ?? 120_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', ...(opts?.env || {}) }
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0
        // 執行檔起不來（ENOENT 等）時 stderr 是空的，改用錯誤訊息
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err ? err.message : '') })
      }
    )
  })

async function tools(): Promise<Tools> {
  const git = await findCliAsync('git')
  if (!git) throw new MemSyncError('git-missing', 'Git is not installed')
  return { git, gh: await findCliAsync('gh'), run }
}

const isWin = process.platform === 'win32'

/** 貼進看得見的終端讓使用者自己按 Enter 的指令；gh 剛裝好時 App 的 PATH 還沒有它，所以用完整路徑 */
function commands(gh: string | null): MemSyncState['commands'] {
  const ghCmd = gh ? (isWin ? `& "${gh}"` : `"${gh}"`) : 'gh'
  return {
    shell: isWin ? 'powershell' : 'bash',
    installGh: isWin ? 'winget install --id GitHub.cli -e --source winget' : 'brew install gh  # or see https://cli.github.com',
    loginGh: `${ghCmd} auth login --hostname github.com --git-protocol https --web; ${ghCmd} auth setup-git`
  }
}

async function isGitRepo(t: Tools, dir: string): Promise<boolean> {
  if (!dir || !fs.existsSync(dir)) return false
  return (await t.run(t.git, ['rev-parse', '--is-inside-work-tree'], { cwd: dir })).stdout.trim() === 'true'
}

async function state(workspace: string): Promise<MemSyncState> {
  const config = loadMemSyncConfig()
  let t: Tools
  try {
    t = await tools()
  } catch (e) {
    return { config, gitMissing: true, gh: { installed: false, loggedIn: false }, clone: { exists: false }, project: null, commands: commands(null) }
  }
  const [gh, clone] = await Promise.all([ghStatus(t), cloneState(t, config.clonePath)])
  const project = (await isGitRepo(t, workspace)) ? await projectState(t, { workspace, clonePath: config.clonePath }) : null
  return { config, gitMissing: false, gh, clone, project, commands: commands(t.gh) }
}

async function wrap<T>(fn: () => Promise<T>): Promise<MemSyncResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    const code = e instanceof MemSyncError ? e.code : 'internal'
    if (!(e instanceof MemSyncError)) console.error('[memsync]', e)
    return { ok: false, code, message: (e as Error).message }
  }
}

function requireConsent(c: MemSyncConfig): void {
  if (!c.consentAt) throw new MemSyncError('no-consent', 'Memory sync has not been enabled')
}

export function registerMemSyncHandlers(): void {
  ipcMain.handle('memsync:state', (event) => wrap(() => state(getWorkspaceForEvent(event))))

  ipcMain.handle('memsync:setConfig', (event, patch: Partial<{ consent: boolean; repo: string; clonePath: string; autoPull: boolean }>) =>
    wrap(async () => {
      const c = loadMemSyncConfig()
      if (typeof patch?.consent === 'boolean') c.consentAt = patch.consent ? Date.now() : null
      if (typeof patch?.repo === 'string') {
        const r = patch.repo.trim()
        if (r && !/^([A-Za-z0-9-]{1,39}\/)?[A-Za-z0-9._-]{1,100}$/.test(r)) throw new MemSyncError('bad-repo-name', r)
        c.repo = r || DEFAULT_REPO_NAME
      }
      if (typeof patch?.clonePath === 'string') {
        if (!path.isAbsolute(patch.clonePath)) throw new MemSyncError('bad-clone-path', patch.clonePath)
        c.clonePath = patch.clonePath
      }
      if (typeof patch?.autoPull === 'boolean') c.autoPull = patch.autoPull
      saveConfig(c)
      return state(getWorkspaceForEvent(event))
    })
  )

  ipcMain.handle('memsync:setupRepo', (event) =>
    wrap(async () => {
      const c = loadMemSyncConfig()
      requireConsent(c)
      const t = await tools()
      const r = await ensureRepo(t, { name: c.repo, clonePath: c.clonePath })
      const gh = await ghStatus(t)
      saveConfig({ ...c, repoFull: r.repo, login: gh.login || null })
      return { result: r, state: await state(getWorkspaceForEvent(event)) }
    })
  )

  ipcMain.handle('memsync:linkProject', (event) =>
    wrap(async () => {
      const c = loadMemSyncConfig()
      requireConsent(c)
      const workspace = getWorkspaceForEvent(event)
      const t = await tools()
      if (!(await isGitRepo(t, workspace))) throw new MemSyncError('not-a-git-repo', workspace)
      const r = await linkProject(t, { workspace, clonePath: c.clonePath, login: c.login || undefined })
      return { result: r, state: await state(workspace) }
    })
  )

  ipcMain.handle('memsync:sync', (event, pullOnly?: boolean) =>
    wrap(async () => {
      const c = loadMemSyncConfig()
      requireConsent(c)
      const workspace = getWorkspaceForEvent(event)
      const t = await tools()
      const r = await syncNow(t, { clonePath: c.clonePath, workspace: (await isGitRepo(t, workspace)) ? workspace : undefined, pullOnly: !!pullOnly, login: c.login || undefined })
      return { result: r, state: await state(workspace) }
    })
  )

  // 開專案時自動拉取：只在已同意、開啟自動拉取、這個專案已連結時進行；其餘情況安靜略過
  ipcMain.handle('memsync:autoPull', (event) =>
    wrap(async () => {
      const c = loadMemSyncConfig()
      if (!c.consentAt || !c.autoPull || !fs.existsSync(path.join(c.clonePath, '.git'))) return null
      const workspace = getWorkspaceForEvent(event)
      const t = await tools()
      if (!(await isGitRepo(t, workspace))) return null
      const p = await projectState(t, { workspace, clonePath: c.clonePath })
      if (!p.linked) return null
      return syncNow(t, { clonePath: c.clonePath, workspace, pullOnly: true })
    })
  )

  ipcMain.handle('memsync:openClone', async () => {
    const c = loadMemSyncConfig()
    if (fs.existsSync(c.clonePath)) await shell.openPath(c.clonePath)
  })
}
