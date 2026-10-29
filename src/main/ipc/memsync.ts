// 記憶同步的 Electron 接線：設定檔、gh／git 的位置、IPC、背景同步。流程本身在 ../memsync/core.ts。
// 設定存在 userData/memory-sync.json，每台電腦各自一份；這一頁的動作立即生效，不經過設定頁的「儲存」。
//
// 存放方式：GitHub 私人 repo（git 同步）、OneDrive／Google Drive 資料夾（雲端硬碟程式同步，
// Workbench 不做網路動作）。沒有同意開啟時，這裡不做任何同步，也不碰網路。
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { findCliAsync } from '../ext/paths'
import { getWorkspaceForEvent } from '../index'
import {
  DEFAULT_REPO_NAME,
  MEMORY_DIR,
  autoLinkBlock,
  ensureLocalExclude,
  MemSyncError,
  cloneState,
  defaultClonePath,
  detectCloudApps,
  detectCloudRoots,
  ensureFolder,
  ensureMemoryScripts,
  connectRepoByUrl,
  createRepoViaGitLogin,
  ensureRepo,
  ghStatus,
  linkProject,
  projectState,
  rootReady,
  syncNow,
  type CloudProvider,
  type Run,
  type Tools
} from '../memsync/core'
import type { MemSyncBackend, MemSyncConfig, MemSyncState, MemSyncResult } from '../../preload/index'
import commitHandoffScript from '../memsync/templates/commit-handoff.sh?raw'
import statusScript from '../memsync/templates/status.sh?raw'
import syncEntryFilesScript from '../memsync/templates/sync-entry-files.sh?raw'

/** 有記憶的專案一律用這些腳本（依設定存本機／雲端資料夾／私人 repo，絕不寫進專案 repo） */
const MEMORY_SCRIPTS = { 'commit-handoff.sh': commitHandoffScript, 'status.sh': statusScript, 'sync-entry-files.sh': syncEntryFilesScript }

const configFile = (): string => path.join(app.getPath('userData'), 'memory-sync.json')
const SYNC_INTERVAL_MS = 10 * 60 * 1000

function defaults(): MemSyncConfig {
  return {
    consentAt: null,
    backend: null,
    repo: DEFAULT_REPO_NAME,
    clonePath: defaultClonePath(),
    repoFull: null,
    login: null,
    folderPath: null,
    autoSync: true,
    autoLink: true
  }
}

const BACKENDS: MemSyncBackend[] = ['github', 'onedrive', 'gdrive']

export function loadMemSyncConfig(): MemSyncConfig {
  const d = defaults()
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    return {
      consentAt: typeof raw.consentAt === 'number' ? raw.consentAt : null,
      backend: BACKENDS.includes(raw.backend) ? raw.backend : null,
      repo: typeof raw.repo === 'string' && raw.repo.trim() ? raw.repo.trim() : d.repo,
      clonePath: typeof raw.clonePath === 'string' && path.isAbsolute(raw.clonePath) ? raw.clonePath : d.clonePath,
      repoFull: typeof raw.repoFull === 'string' ? raw.repoFull : null,
      login: typeof raw.login === 'string' ? raw.login : null,
      folderPath: typeof raw.folderPath === 'string' && path.isAbsolute(raw.folderPath) ? raw.folderPath : null,
      // 舊版設定叫 autoPull
      autoSync: (raw.autoSync ?? raw.autoPull) !== false,
      autoLink: raw.autoLink !== false
    }
  } catch {
    return d
  }
}

function saveConfig(c: MemSyncConfig): void {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2))
}

/** 記憶根目錄：GitHub 模式是 clone，雲端硬碟模式是使用者選的資料夾 */
function memoryRoot(c: MemSyncConfig): string | null {
  if (c.backend === 'github') return c.clonePath
  if (c.backend === 'onedrive' || c.backend === 'gdrive') return c.folderPath
  return null
}

/** 已同意、選好存放方式、根目錄也準備好了 */
function activeRoot(c: MemSyncConfig): string | null {
  const root = memoryRoot(c)
  return c.consentAt && root && rootReady(root) ? root : null
}

// git／gh 一律關掉互動提示：背景執行時沒人能回答，寧可失敗回報也不要卡住
const run: Run = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
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
    // git credential 等指令從 stdin 讀查詢；沒有輸入時直接關掉，避免等待
    child.stdin?.on('error', () => {})
    child.stdin?.end(opts?.input ?? '')
  })

async function tools(): Promise<Tools> {
  const git = await findCliAsync('git')
  if (!git) throw new MemSyncError('git-missing', 'Git is not installed')
  return { git, gh: await findCliAsync('gh'), run }
}

// 同一時間只跑一個會動到記憶根目錄的動作（背景同步、手動同步、連結）
let chain: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

const isWin = process.platform === 'win32'

/** 貼進看得見的終端讓使用者自己按 Enter 的指令；gh 剛裝好時 App 的 PATH 還沒有它，所以用完整路徑 */
function commands(gh: string | null): MemSyncState['commands'] {
  const ghCmd = gh ? (isWin ? `& "${gh}"` : `"${gh}"`) : 'gh'
  return {
    shell: isWin ? 'powershell' : 'bash',
    installGh: isWin ? 'winget install --id GitHub.cli -e --source winget' : 'brew install gh  # or see https://cli.github.com',
    loginGh: `${ghCmd} auth login --hostname github.com --git-protocol https --web; ${ghCmd} auth setup-git`,
    // 雲端硬碟程式：winget 官方套件（Microsoft／Google LLC）；macOS 用 Homebrew cask
    installOneDrive: isWin ? 'winget install --id Microsoft.OneDrive -e --source winget' : 'brew install --cask onedrive',
    installGDrive: isWin ? 'winget install --id Google.GoogleDrive -e --source winget' : 'brew install --cask google-drive'
  }
}

async function isGitRepo(t: Tools, dir: string): Promise<boolean> {
  if (!dir || !fs.existsSync(dir)) return false
  return (await t.run(t.git, ['rev-parse', '--is-inside-work-tree'], { cwd: dir })).stdout.trim() === 'true'
}

async function state(workspace: string): Promise<MemSyncState> {
  const config = loadMemSyncConfig()
  const cloudRoots = detectCloudRoots()
  const cloudApps = detectCloudApps()
  const root = memoryRoot(config)
  const ready = !!root && rootReady(root)
  let t: Tools
  try {
    t = await tools()
  } catch {
    return {
      config,
      cloudRoots,
      cloudApps,
      root,
      rootReady: ready,
      gitMissing: true,
      gh: { installed: false, loggedIn: false },
      clone: { exists: false },
      project: null,
      commands: commands(null)
    }
  }
  // gh 狀態只在 GitHub 模式需要（會連網路），其他模式不查
  const [gh, clone] = await Promise.all([
    config.backend === 'github' ? ghStatus(t) : Promise.resolve({ installed: !!t.gh, loggedIn: false }),
    cloneState(t, config.clonePath)
  ])
  const project = root && (await isGitRepo(t, workspace)) ? await projectState(t, { workspace, clonePath: root }) : null
  return { config, cloudRoots, cloudApps, root, rootReady: ready, gitMissing: false, gh, clone, project, commands: commands(t.gh) }
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

function requireRoot(c: MemSyncConfig): string {
  requireConsent(c)
  const root = activeRoot(c)
  if (!root) throw new MemSyncError('no-clone', 'Set up the memory storage first')
  return root
}

/** 背景同步（只有 GitHub 模式；雲端硬碟模式由它自己的程式同步） */
async function backgroundSync(): Promise<void> {
  const c = loadMemSyncConfig()
  const root = activeRoot(c)
  if (!root || c.backend !== 'github' || !c.autoSync) return
  try {
    const t = await tools()
    const r = await exclusive(() => syncNow(t, { clonePath: root, login: c.login || undefined }))
    if (r.error) console.warn('[memsync] background sync:', r.error)
  } catch (e) {
    console.warn('[memsync] background sync failed:', (e as Error).message)
  }
}

export function registerMemSyncHandlers(): void {
  ipcMain.handle('memsync:state', (event) => wrap(() => state(getWorkspaceForEvent(event))))

  ipcMain.handle(
    'memsync:setConfig',
    (event, patch: Partial<{ consent: boolean; backend: MemSyncBackend; repo: string; autoSync: boolean; autoLink: boolean }>) =>
      wrap(async () => {
        const c = loadMemSyncConfig()
        if (typeof patch?.consent === 'boolean') c.consentAt = patch.consent ? Date.now() : null
        if (patch?.backend !== undefined) {
          if (!BACKENDS.includes(patch.backend)) throw new MemSyncError('bad-backend', String(patch.backend))
          // 換存放方式：已接上的專案在下次開啟時（或按「搬到新的存放位置」）從舊位置搬過來
          c.backend = patch.backend
        }
        if (typeof patch?.repo === 'string') {
          const r = patch.repo.trim()
          if (r && !/^([A-Za-z0-9-]{1,39}\/)?[A-Za-z0-9._-]{1,100}$/.test(r)) throw new MemSyncError('bad-repo-name', r)
          c.repo = r || DEFAULT_REPO_NAME
        }
        if (typeof patch?.autoSync === 'boolean') c.autoSync = patch.autoSync
        if (typeof patch?.autoLink === 'boolean') c.autoLink = patch.autoLink
        saveConfig(c)
        return state(getWorkspaceForEvent(event))
      })
  )

  // 雲端硬碟模式：選資料夾。只接受偵測到的 OneDrive／Google Drive 底下的資料夾
  ipcMain.handle('memsync:pickFolder', (event) =>
    wrap(async () => {
      const c = loadMemSyncConfig()
      requireConsent(c)
      if (c.backend !== 'onedrive' && c.backend !== 'gdrive') throw new MemSyncError('bad-backend', String(c.backend))
      const provider: CloudProvider = c.backend
      const roots = detectCloudRoots()[provider]
      if (!roots.length) throw new MemSyncError(provider === 'onedrive' ? 'onedrive-missing' : 'gdrive-missing')
      const suggested = path.join(roots[0], DEFAULT_REPO_NAME)
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts: Electron.OpenDialogOptions = {
        title: provider === 'onedrive' ? 'OneDrive' : 'Google Drive',
        defaultPath: c.folderPath || (fs.existsSync(suggested) ? suggested : roots[0]),
        properties: ['openDirectory', 'createDirectory']
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return { picked: false, state: await state(getWorkspaceForEvent(event)) }
      ensureFolder({ root: r.filePaths[0], provider, cloudRoots: roots })
      saveConfig({ ...c, folderPath: r.filePaths[0] })
      return { picked: true, state: await state(getWorkspaceForEvent(event)) }
    })
  )

  ipcMain.handle('memsync:setupRepo', (event) =>
    wrap(async () => {
      const c = loadMemSyncConfig()
      requireConsent(c)
      if (c.backend !== 'github') throw new MemSyncError('bad-backend', String(c.backend))
      const t = await tools()
      const r = await exclusive(() => ensureRepo(t, { name: c.repo, clonePath: c.clonePath }))
      const gh = await ghStatus(t)
      saveConfig({ ...c, repoFull: r.repo, login: gh.login || null })
      return { result: r, state: await state(getWorkspaceForEvent(event)) }
    })
  )

  // 免 gh 一鍵建立：用 Git Credential Manager 的 GitHub 登入建立私人 repo
  ipcMain.handle('memsync:createRepoViaGit', (event, name: string) =>
    wrap(async () => {
      const c = loadMemSyncConfig()
      requireConsent(c)
      if (c.backend !== 'github') throw new MemSyncError('bad-backend', String(c.backend))
      const t = await tools()
      const r = await exclusive(() => createRepoViaGitLogin(t, { name: String(name || c.repo.split('/').pop() || ''), clonePath: c.clonePath }))
      saveConfig({ ...c, repo: r.repo.split('/')[1], repoFull: r.repo, login: r.repo.split('/')[0] })
      return { result: r, state: await state(getWorkspaceForEvent(event)) }
    })
  )

  // 免 gh：使用者自己建好的私人 repo 網址；登入交給 Git Credential Manager
  ipcMain.handle('memsync:connectRepo', (event, input: string) =>
    wrap(async () => {
      const c = loadMemSyncConfig()
      requireConsent(c)
      if (c.backend !== 'github') throw new MemSyncError('bad-backend', String(c.backend))
      const t = await tools()
      const r = await exclusive(() => connectRepoByUrl(t, { input: String(input || ''), clonePath: c.clonePath }))
      saveConfig({ ...c, repo: r.repo, repoFull: r.repo, login: r.repo.split('/')[0] })
      return { result: r, state: await state(getWorkspaceForEvent(event)) }
    })
  )

  // 使用者在設定頁按下（已確認）：可以提交「停止追蹤」；記憶內容不同時由使用者選用哪一份
  ipcMain.handle('memsync:linkProject', (event, prefer?: 'shared' | 'local') =>
    wrap(async () => {
      const c = loadMemSyncConfig()
      const root = requireRoot(c)
      const workspace = getWorkspaceForEvent(event)
      const t = await tools()
      if (!(await isGitRepo(t, workspace))) throw new MemSyncError('not-a-git-repo', workspace)
      const pick = prefer === 'shared' || prefer === 'local' ? prefer : undefined
      const r = await exclusive(() =>
        linkProject(t, { workspace, clonePath: root, login: c.login || undefined, scripts: MEMORY_SCRIPTS, migrate: true, allowCommit: true, prefer: pick })
      )
      return { result: r, state: await state(workspace) }
    })
  )

  ipcMain.handle('memsync:sync', (event, pullOnly?: boolean) =>
    wrap(async () => {
      const c = loadMemSyncConfig()
      const root = requireRoot(c)
      const workspace = getWorkspaceForEvent(event)
      const t = await tools()
      const ws = (await isGitRepo(t, workspace)) ? workspace : undefined
      const r = await exclusive(() => syncNow(t, { clonePath: root, workspace: ws, pullOnly: !!pullOnly, login: c.login || undefined }))
      return { result: r, state: await state(workspace) }
    })
  )

  /**
   * 開啟／切換專案時：未開啟記憶同步只換掉舊版腳本（本機檔案，不碰網路）後回 null。
   * GitHub 模式先拉取（另一台電腦的最新記憶），再把有記憶的專案自動接上。
   */
  ipcMain.handle('memsync:onProjectOpen', (event) =>
    wrap(async () => {
      const c = loadMemSyncConfig()
      const root = activeRoot(c)
      const workspace = getWorkspaceForEvent(event)
      if (!root) {
        // 舊版 commit-handoff.sh 會用 `git add -f` 把記憶強制提交進專案 repo；同步關閉時也要換成不提交的版本
        const mem = path.join(workspace, MEMORY_DIR)
        if (fs.existsSync(path.join(mem, 'commit-handoff.sh'))) ensureMemoryScripts(mem, MEMORY_SCRIPTS)
        return null
      }
      const t = await tools()
      if (!(await isGitRepo(t, workspace))) return null
      return exclusive(async () => {
        // GitHub：拉取（已連結的專案順便更新入口檔）；雲端硬碟：只更新入口檔，不碰網路
        const pulled = c.backend === 'github' && !c.autoSync ? null : await syncNow(t, { clonePath: root, workspace, pullOnly: true })
        const p = await projectState(t, { workspace, clonePath: root })
        let linked: Awaited<ReturnType<typeof linkProject>> | null = null
        let needsReview: ReturnType<typeof autoLinkBlock> = null
        // 換過存放方式（Workbench 自己建的舊連結搬到新位置），或有記憶但還沒接上
        const auto = c.autoLink && ((p.linkedElsewhere && p.linkedToOldStore) || (!p.linked && !p.linkedElsewhere && (p.hasLocalMemory || p.hasRemoteMemory)))
        if (auto) {
          // 自動接上不動專案 repo、不蓋掉內容不同的記憶；需要確認的留在 設定 → 記憶同步 → 這個專案
          needsReview = autoLinkBlock(p)
          if (!needsReview) linked = await linkProject(t, { workspace, clonePath: root, login: c.login || undefined, scripts: MEMORY_SCRIPTS, migrate: true })
        } else if (p.linked) {
          // 已連結的專案：腳本跟著 Workbench 更新（另一台電腦連結時寫進共用位置的可能是舊版）
          ensureMemoryScripts(p.target, MEMORY_SCRIPTS)
          await ensureLocalExclude(t, workspace)
          needsReview = autoLinkBlock(p)
        }
        return { pulled, linked, needsReview }
      })
    })
  )

  // 開啟雲端硬碟程式讓使用者登入（只開偵測到的官方程式路徑，不接受 renderer 傳路徑）
  ipcMain.handle('memsync:launchCloudApp', (_event, provider: CloudProvider) =>
    wrap(async () => {
      if (provider !== 'onedrive' && provider !== 'gdrive') throw new MemSyncError('bad-backend', String(provider))
      const cloud = detectCloudApps()[provider]
      if (!cloud.exe) throw new MemSyncError(provider === 'onedrive' ? 'onedrive-missing' : 'gdrive-missing')
      const err = await shell.openPath(cloud.exe)
      if (err) throw new MemSyncError('launch-failed', err)
      return true
    })
  )

  ipcMain.handle('memsync:openClone', async () => {
    const root = memoryRoot(loadMemSyncConfig())
    if (root && fs.existsSync(root)) await shell.openPath(root)
  })

  const timer = setInterval(() => void backgroundSync(), SYNC_INTERVAL_MS)
  timer.unref()
}
