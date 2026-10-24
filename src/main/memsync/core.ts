// 記憶同步：把各專案的 .project-memory/ 放進使用者自己的「私人」GitHub repo（所有專案共用一個），
// 專案 repo 不再追蹤記憶檔。每台電腦有一份記憶 repo 的本機 clone，專案的 .project-memory 是指向
// clone 內 <owner>/<repo>/ 子資料夾的目錄連結（Windows 用 junction，不需要系統管理員權限），
// 所以 status.sh、commit-handoff.sh 與三家 agent 讀取的路徑都不用改。
//
// 不依賴 Electron：gh／git 由呼叫端注入（ipc/memsync.ts），scripts/check-memsync.mts 用本機 bare
// repo 與假的 gh 驗證整個流程。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}
export type Run = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }
) => Promise<RunResult>

export interface Tools {
  git: string
  /** gh 執行檔；沒裝時為 null */
  gh: string | null
  run: Run
  /** 不登入查詢網址的 HTTP 狀態碼（免 gh 路線判斷 repo 是否公開）；測試時注入假的 */
  httpStatus?: (url: string) => Promise<number>
}

export class MemSyncError extends Error {
  code: string
  constructor(code: string, message?: string) {
    super(message || code)
    this.code = code
  }
}

export const DEFAULT_REPO_NAME = 'ai-project-memory'
export const MEMORY_DIR = '.project-memory'
/** 專案裡由 handoff 產生、含記憶內容的入口檔（Codex／Antigravity 開機會讀）：不能進專案 repo */
export const ENTRY_FILES: { project: string; stored: string }[] = [
  { project: 'AGENTS.md', stored: 'AGENTS.md' },
  { project: '.agents/rules/shared-memory.md', stored: 'shared-memory.md' }
]
const BACKUP_DIR = '.local-backups'

export function defaultClonePath(home = os.homedir()): string {
  return path.join(home, '.ai-project-memory')
}

// ── 雲端硬碟資料夾模式（OneDrive／Google Drive） ─────────────────────────
// 記憶放在使用者選的資料夾（由雲端硬碟程式同步），Workbench 不做任何網路動作。
// 資料夾根目錄放一個標記檔，commit-handoff.sh 靠它知道「存好就好，不用提交」。
export const FOLDER_MARKER = '.workbench-memory.json'
export type CloudProvider = 'onedrive' | 'gdrive'

/** 這台電腦上偵測到的雲端硬碟根目錄（不存在的不列） */
export function detectCloudRoots(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Record<CloudProvider, string[]> {
  const uniq = (list: string[]): string[] => [...new Set(list.filter((p) => p && exists(p)).map((p) => path.resolve(p)))]
  const onedrive = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((p): p is string => !!p)
  const gdrive = [path.join(home, 'Google Drive'), path.join(home, 'My Drive')]
  if (process.platform === 'win32') {
    for (let c = 68; c <= 90; c++) {
      const d = `${String.fromCharCode(c)}:\\`
      for (const n of ['My Drive', '我的雲端硬碟']) gdrive.push(path.join(d, n))
    }
  }
  const cloudStorage = path.join(home, 'Library', 'CloudStorage') // macOS
  if (exists(cloudStorage)) {
    for (const n of fs.readdirSync(cloudStorage)) {
      if (n.startsWith('OneDrive')) onedrive.push(path.join(cloudStorage, n))
      if (n.startsWith('GoogleDrive')) gdrive.push(path.join(cloudStorage, n, 'My Drive'))
    }
  }
  return { onedrive: uniq(onedrive), gdrive: uniq(gdrive) }
}

/**
 * 雲端硬碟程式有沒有裝（不等於有登入：登入並建立同步資料夾後 detectCloudRoots 才找得到）。
 * exe 是用來「開啟並登入」的程式。
 */
export function detectCloudApps(env: NodeJS.ProcessEnv = process.env): Record<CloudProvider, { installed: boolean; exe?: string }> {
  const first = (list: string[]): string | undefined => list.find((p) => p && exists(p))
  const pf = env.ProgramFiles || 'C:\\Program Files'
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  let onedrive: string | undefined
  let gdrive: string | undefined
  if (process.platform === 'win32') {
    onedrive = first([path.join(local, 'Microsoft', 'OneDrive', 'OneDrive.exe'), path.join(pf, 'Microsoft OneDrive', 'OneDrive.exe'), path.join(pf86, 'Microsoft OneDrive', 'OneDrive.exe')])
    // Google 雲端硬碟電腦版：<Program Files>\Google\Drive File Stream\launch.bat（或版本資料夾裡的 GoogleDriveFS.exe）
    const dfs = path.join(pf, 'Google', 'Drive File Stream')
    gdrive = first([path.join(dfs, 'launch.bat')])
    if (!gdrive && exists(dfs)) {
      for (const v of fs.readdirSync(dfs).sort().reverse()) {
        const exe = path.join(dfs, v, 'GoogleDriveFS.exe')
        if (exists(exe)) {
          gdrive = exe
          break
        }
      }
    }
  } else if (process.platform === 'darwin') {
    onedrive = first(['/Applications/OneDrive.app'])
    gdrive = first(['/Applications/Google Drive.app'])
  }
  return { onedrive: { installed: !!onedrive, ...(onedrive ? { exe: onedrive } : {}) }, gdrive: { installed: !!gdrive, ...(gdrive ? { exe: gdrive } : {}) } }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function isFolderRoot(root: string): boolean {
  return exists(path.join(root, FOLDER_MARKER))
}

/**
 * 準備雲端資料夾：必須在偵測到的雲端硬碟根目錄「底下」（不能是根目錄本身），
 * 之後所有記憶與備份都只寫在這個資料夾裡。
 */
export function ensureFolder(opts: { root: string; provider: CloudProvider; cloudRoots: string[] }): { root: string } {
  if (!path.isAbsolute(opts.root)) throw new MemSyncError('bad-folder', opts.root)
  if (!opts.cloudRoots.length) throw new MemSyncError(opts.provider === 'onedrive' ? 'onedrive-missing' : 'gdrive-missing')
  if (opts.cloudRoots.some((r) => path.relative(path.resolve(r), path.resolve(opts.root)) === '')) throw new MemSyncError('pick-subfolder', opts.root)
  if (!opts.cloudRoots.some((r) => isInside(opts.root, r))) throw new MemSyncError('folder-outside-cloud', opts.root)
  if (exists(path.join(opts.root, '.git'))) throw new MemSyncError('folder-is-git-repo', opts.root)
  fs.mkdirSync(opts.root, { recursive: true })
  const marker = path.join(opts.root, FOLDER_MARKER)
  if (!exists(marker)) fs.writeFileSync(marker, JSON.stringify({ backend: 'folder', provider: opts.provider, createdAt: new Date().toISOString() }, null, 2) + '\n')
  const readme = path.join(opts.root, 'README.md')
  if (!exists(readme)) {
    fs.writeFileSync(
      readme,
      '# Project memory (synced folder)\n\nShared `.project-memory/` folders for Agent Workbench projects, one folder per project ' +
        '(`<owner>/<repo>/`), synced by your cloud drive. Each project links its `.project-memory` here.\n'
    )
  }
  return { root: opts.root }
}

/** 記憶根目錄是否可用：GitHub 模式是 clone，資料夾模式是有標記檔的資料夾 */
export function rootReady(root: string): boolean {
  return exists(path.join(root, '.git')) || isFolderRoot(root)
}

const exists = (p: string): boolean => fs.existsSync(p)

async function must(tools: Tools, cmd: string, args: string[], cwd?: string, code = 'command-failed'): Promise<string> {
  const r = await tools.run(cmd, args, { cwd })
  if (r.code !== 0) throw new MemSyncError(code, `${path.basename(cmd)} ${args.join(' ')}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`)
  return r.stdout
}

const git = (tools: Tools, cwd: string, ...args: string[]): Promise<RunResult> => tools.run(tools.git, args, { cwd })
const gitMust = (tools: Tools, cwd: string, ...args: string[]): Promise<string> => must(tools, tools.git, args, cwd, 'git-failed')

function needGh(tools: Tools): string {
  if (!tools.gh) throw new MemSyncError('gh-missing', 'GitHub CLI (gh) is not installed')
  return tools.gh
}

/** 路徑片段只留安全字元，避免 origin URL 造出 .. 或奇怪的資料夾名稱 */
function safeSegment(s: string): string {
  const v = s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return v || '_'
}

/** 專案在記憶 repo 裡的位置：origin 是 GitHub 時為 owner/repo，否則 local/<資料夾名稱> */
export async function projectKey(tools: Tools, workspace: string): Promise<string> {
  // 讀設定裡的原始網址：`remote get-url` 會套用 url.<base>.insteadOf 改寫，得到的不一定是 GitHub 網址
  const r = await git(tools, workspace, 'config', '--get', 'remote.origin.url')
  const url = r.code === 0 ? r.stdout.trim() : ''
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url)
  if (m) return `${safeSegment(m[1])}/${safeSegment(m[2])}`
  return `local/${safeSegment(path.basename(path.resolve(workspace)))}`
}

export function memoryTarget(clonePath: string, key: string): string {
  return path.join(clonePath, ...key.split('/'))
}

// ── GitHub CLI ─────────────────────────────────────────────────────────

export interface GhStatus {
  installed: boolean
  loggedIn: boolean
  login?: string
}

export async function ghStatus(tools: Tools): Promise<GhStatus> {
  if (!tools.gh) return { installed: false, loggedIn: false }
  const r = await tools.run(tools.gh, ['api', 'user', '--jq', '.login'])
  const login = r.code === 0 ? r.stdout.trim() : ''
  return { installed: true, loggedIn: !!login, ...(login ? { login } : {}) }
}

async function repoPrivacy(tools: Tools, full: string): Promise<'private' | 'public' | 'missing'> {
  const r = await tools.run(needGh(tools), ['repo', 'view', full, '--json', 'isPrivate', '--jq', '.isPrivate'])
  if (r.code !== 0) return 'missing'
  return r.stdout.trim() === 'true' ? 'private' : 'public'
}

// ── 記憶 repo（每台電腦一份 clone） ────────────────────────────────────

/** 記憶 repo 內的提交身分：沒設定時用 GitHub 的 noreply 位址，只寫在記憶 repo 自己的設定 */
async function ensureIdentity(tools: Tools, repoDir: string, login: string | undefined): Promise<void> {
  const name = (await git(tools, repoDir, 'config', 'user.name')).stdout.trim()
  const email = (await git(tools, repoDir, 'config', 'user.email')).stdout.trim()
  const who = login || 'workbench'
  if (!name) await gitMust(tools, repoDir, 'config', 'user.name', who)
  if (!email) await gitMust(tools, repoDir, 'config', 'user.email', `${who}@users.noreply.github.com`)
}

export interface EnsureRepoResult {
  repo: string
  created: boolean
  cloned: boolean
  clonePath: string
}

/**
 * 確保私人記憶 repo 存在並有本機 clone。repo 已存在但是公開的 → 拒絕（記憶不能公開）。
 * name 可以是 "repo" 或 "owner/repo"。
 */
export async function ensureRepo(tools: Tools, opts: { name: string; clonePath: string }): Promise<EnsureRepoResult> {
  const gh = needGh(tools)
  const st = await ghStatus(tools)
  if (!st.loggedIn) throw new MemSyncError('gh-not-logged-in', 'Log in to GitHub first (gh auth login)')
  const name = opts.name.trim() || DEFAULT_REPO_NAME
  if (!/^([A-Za-z0-9-]{1,39}\/)?[A-Za-z0-9._-]{1,100}$/.test(name)) throw new MemSyncError('bad-repo-name', name)
  const full = name.includes('/') ? name : `${st.login}/${name}`

  let created = false
  const privacy = await repoPrivacy(tools, full)
  if (privacy === 'public') throw new MemSyncError('repo-public', `${full} is public; memory must go to a private repository`)
  if (privacy === 'missing') {
    await must(tools, gh, ['repo', 'create', full, '--private', '--description', 'Agent Workbench project memory (private)'], undefined, 'repo-create-failed')
    created = true
    if ((await repoPrivacy(tools, full)) !== 'private') throw new MemSyncError('repo-public', `${full} was not created as private`)
  }
  // git 透過 gh 取得 GitHub 憑證（推送私人 repo 用）
  await tools.run(gh, ['auth', 'setup-git'])
  return { repo: full, created, ...(await prepareClone(tools, { full, clonePath: opts.clonePath, login: st.login })) }
}

/** 把 GitHub 網址（https 或 git@）或 owner/repo 正規化成 owner/repo；看不懂就回 null */
export function parseRepoInput(input: string): string | null {
  const m = input
    .trim()
    .match(/^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i)
  return m ? `${m[1]}/${m[2]}` : null
}

const defaultHttpStatus = async (url: string): Promise<number> =>
  (await fetch(url, { headers: { 'User-Agent': 'agent-workbench', Accept: 'application/vnd.github+json' } })).status

/**
 * 免 gh 路線：使用者自己在 github.com 建好私人 repo，貼上網址。
 * 不登入查 GitHub API：查得到（200）= 公開 → 拒絕；404 = 私人或不存在，再用 git 確認連得上
 * （Git Credential Manager 第一次會開 GitHub 登入）。其他狀態（限流、斷網）一律拒絕，不猜。
 */
export async function connectRepoByUrl(tools: Tools, opts: { input: string; clonePath: string }): Promise<EnsureRepoResult> {
  const full = parseRepoInput(opts.input)
  if (!full) throw new MemSyncError('bad-repo-url', opts.input)
  let status: number
  try {
    status = await (tools.httpStatus || defaultHttpStatus)(`https://api.github.com/repos/${full}`)
  } catch (e) {
    throw new MemSyncError('privacy-check-failed', (e as Error).message)
  }
  if (status === 200) throw new MemSyncError('repo-public', `${full} is public; memory must go to a private repository`)
  if (status !== 404) throw new MemSyncError('privacy-check-failed', `GitHub API answered ${status}`)
  const ls = await tools.run(tools.git, ['ls-remote', '--heads', `https://github.com/${full}.git`], {
    timeoutMs: 5 * 60_000,
    env: { GCM_INTERACTIVE: 'always' }
  })
  if (ls.code !== 0) throw new MemSyncError('repo-unreachable', (ls.stderr || ls.stdout).trim().slice(0, 400))
  return { repo: full, created: false, ...(await prepareClone(tools, { full, clonePath: opts.clonePath, login: full.split('/')[0] })) }
}

/** 確保本機 clone 指向 full；新 repo 時放說明與 .gitignore 並推出第一個提交 */
async function prepareClone(
  tools: Tools,
  opts: { full: string; clonePath: string; login: string | undefined }
): Promise<{ cloned: boolean; clonePath: string }> {
  const { full, login } = opts
  let cloned = false
  if (exists(path.join(opts.clonePath, '.git'))) {
    const origin = (await git(tools, opts.clonePath, 'config', '--get', 'remote.origin.url')).stdout.trim()
    if (!new RegExp(`[/:]${full.replace(/[.]/g, '\\.')}(\\.git)?/?$`, 'i').test(origin)) {
      throw new MemSyncError('clone-other-repo', `${opts.clonePath} is a clone of ${origin}, not ${full}`)
    }
  } else {
    if (exists(opts.clonePath) && fs.readdirSync(opts.clonePath).length > 0) {
      throw new MemSyncError('clone-path-not-empty', `${opts.clonePath} exists and is not empty`)
    }
    fs.mkdirSync(path.dirname(opts.clonePath), { recursive: true })
    await must(tools, tools.git, ['clone', '-q', `https://github.com/${full}.git`, opts.clonePath], undefined, 'clone-failed')
    cloned = true
  }
  await ensureIdentity(tools, opts.clonePath, login)

  // 新 repo 沒有任何提交：放一份說明與 .gitignore，推出第一個提交
  const ignore = path.join(opts.clonePath, '.gitignore')
  if (!exists(ignore) || !fs.readFileSync(ignore, 'utf8').includes(`${BACKUP_DIR}/`)) {
    fs.appendFileSync(ignore, `# 本機搬移前的備份，只留在這台電腦\n${BACKUP_DIR}/\n`)
  }
  const readme = path.join(opts.clonePath, 'README.md')
  if (!exists(readme)) {
    fs.writeFileSync(
      readme,
      '# Project memory (private)\n\nShared `.project-memory/` folders for Agent Workbench projects, one folder per project ' +
        '(`<owner>/<repo>/`). Each project links its `.project-memory` here; do not make this repository public.\n'
    )
  }
  if ((await git(tools, opts.clonePath, 'status', '--porcelain')).stdout.trim()) {
    await gitMust(tools, opts.clonePath, 'add', '-A')
    await gitMust(tools, opts.clonePath, 'commit', '-q', '-m', 'memory: initialize')
    await gitMust(tools, opts.clonePath, 'push', '-q', '-u', 'origin', 'HEAD')
  }
  return { cloned, clonePath: opts.clonePath }
}

// ── 專案連結 ───────────────────────────────────────────────────────────

export interface ProjectState {
  key: string
  target: string
  /** .project-memory 已是指向 target 的連結 */
  linked: boolean
  /** .project-memory 是連結但指向別處 */
  linkedElsewhere: boolean
  /** linkedElsewhere 時連結實際指向的位置 */
  linkedTo?: string
  /** 指向的是另一個（舊的）記憶存放位置裡的同一個專案資料夾 */
  linkedToOldStore?: boolean
  /** 專案裡有實體的 .project-memory 資料夾（尚未搬移） */
  hasLocalMemory: boolean
  /** 記憶 repo 裡已有這個專案的記憶（另一台電腦已經搬過） */
  hasRemoteMemory: boolean
  /** 專案 repo 仍在追蹤的記憶檔 */
  tracked: string[]
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

function sameDir(a: string, b: string): boolean {
  const ra = realOrNull(a)
  const rb = realOrNull(b)
  return !!ra && !!rb && path.relative(ra, rb) === ''
}

export async function projectState(tools: Tools, opts: { workspace: string; clonePath: string }): Promise<ProjectState> {
  const key = await projectKey(tools, opts.workspace)
  const target = memoryTarget(opts.clonePath, key)
  const memPath = path.join(opts.workspace, MEMORY_DIR)
  let isLink = false
  let isDir = false
  try {
    const st = fs.lstatSync(memPath)
    isLink = st.isSymbolicLink()
    isDir = !isLink && st.isDirectory()
  } catch {
    /* 沒有 .project-memory */
  }
  const linked = isLink && sameDir(memPath, target)
  const linkedTo = isLink && !linked ? realOrNull(memPath) || undefined : undefined
  const r = await git(tools, opts.workspace, 'ls-files', '--', MEMORY_DIR, ...ENTRY_FILES.map((e) => e.project))
  return {
    key,
    target,
    linked,
    linkedElsewhere: isLink && !linked,
    ...(linkedTo ? { linkedTo } : {}),
    // Workbench 自己建的連結（另一個存放位置的 <owner>/<repo>）：換存放方式後可以自動搬
    ...(linkedTo ? { linkedToOldStore: linkedTo.replace(/\\/g, '/').toLowerCase().endsWith('/' + key.toLowerCase()) && exists(path.join(linkedTo, 'handoff.md')) } : {}),
    hasLocalMemory: isDir && exists(path.join(memPath, 'handoff.md')),
    hasRemoteMemory: exists(path.join(target, 'handoff.md')),
    tracked: r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : []
  }
}

/** 專案 .gitignore 要有的條目；回傳是否有改動 */
function ensureProjectIgnore(workspace: string): boolean {
  const file = path.join(workspace, '.gitignore')
  const text = exists(file) ? fs.readFileSync(file, 'utf8') : ''
  const lines = new Set(text.split(/\r?\n/).map((l) => l.trim()))
  const missing: string[] = []
  if (!lines.has('.project-memory') && !lines.has('.project-memory/')) missing.push('.project-memory/')
  if (!lines.has('AGENTS.md')) missing.push('AGENTS.md')
  if (!lines.has('.agents/') && !lines.has('.agents') && !lines.has('.agents/rules/shared-memory.md')) missing.push('.agents/rules/shared-memory.md')
  if (!missing.length) return false
  const sep = text && !text.endsWith('\n') ? '\n' : ''
  fs.writeFileSync(file, `${text}${sep}\n# 專案記憶放在私人記憶 repo（Agent Workbench：設定 → 記憶同步），不進這個 repo\n${missing.join('\n')}\n`)
  return true
}

function bashFor(gitPath: string): string | null {
  if (process.platform !== 'win32') return 'bash'
  // ...\Git\cmd\git.exe → ...\Git\bin\bash.exe
  const root = path.dirname(path.dirname(gitPath))
  for (const rel of ['bin/bash.exe', 'usr/bin/bash.exe']) {
    const p = path.join(root, rel)
    if (exists(p)) return p
  }
  return null
}

/**
 * 入口檔的範本：拿掉由 handoff 產生的 AUTO-MEMORY 區塊。每台電腦都從自己的 handoff 重新產生，
 * 存進記憶 repo 的話兩台每次交接都會在這裡衝突（commit-handoff.sh 用同樣的規則）。
 */
export function entryTemplate(text: string): string {
  const out: string[] = []
  let skip = false
  for (const line of text.split(/\r?\n/)) {
    if (line.includes('<!-- BEGIN AUTO-MEMORY')) skip = true
    if (!skip) out.push(line)
    if (line.includes('<!-- END AUTO-MEMORY -->')) skip = false
  }
  return out.join('\n')
}

/** 從記憶資料夾的 entry/ 補回入口檔，再用 handoff 重新產生其中的記憶區塊 */
async function restoreEntryFiles(tools: Tools, workspace: string, target: string): Promise<void> {
  for (const e of ENTRY_FILES) {
    const dst = path.join(workspace, e.project)
    const stored = path.join(target, 'entry', e.stored)
    if (!exists(dst) && exists(stored)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(stored, dst)
    } else if (exists(dst) && !exists(stored)) {
      fs.mkdirSync(path.dirname(stored), { recursive: true })
      fs.writeFileSync(stored, entryTemplate(fs.readFileSync(dst, 'utf8')))
    }
  }
  const sync = path.join(workspace, MEMORY_DIR, 'sync-entry-files.sh')
  const bash = bashFor(tools.git)
  if (bash && exists(sync)) await tools.run(bash, [sync], { cwd: workspace })
}

/**
 * 把記憶資料夾裡的 commit-handoff.sh／status.sh 換成 Workbench 附的版本（依記憶同步設定決定
 * 存本機、存雲端資料夾或推到私人 repo；舊版會用 `git add -f` 把記憶強制提交進專案 repo）。
 * 內容一樣就不寫。回傳有更新的檔名。
 */
export function ensureMemoryScripts(target: string, scripts: Record<string, string>): string[] {
  const updated: string[] = []
  for (const [name, content] of Object.entries(scripts)) {
    if (!/^[A-Za-z0-9._-]+\.sh$/.test(name)) continue
    const file = path.join(target, name)
    const want = content.replace(/\r\n/g, '\n')
    const have = exists(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null
    if (have === want) continue
    fs.writeFileSync(file, want)
    updated.push(name)
  }
  return updated
}

export interface LinkResult {
  key: string
  target: string
  /** 記憶來自本機（第一台）或記憶 repo（其他電腦） */
  source: 'local' | 'repo' | 'already-linked'
  /** 搬移前的本機備份位置 */
  backup?: string
  /** 專案 repo 是否產生了「停止追蹤記憶檔」的提交 */
  projectCommit?: string
}

/**
 * 把專案接到記憶 repo：
 * - 第一台：專案的 .project-memory 搬進 clone/<owner>/<repo>/ 並推上私人 repo；
 * - 其他電腦：記憶 repo 已有這個專案 → 直接連結（本機若有舊的 .project-memory 先備份）。
 * 最後專案 repo 停止追蹤記憶檔與入口檔（一個只動這些路徑與 .gitignore 的提交）。
 */
export async function linkProject(
  tools: Tools,
  opts: { workspace: string; clonePath: string; login?: string; scripts?: Record<string, string>; migrate?: boolean }
): Promise<LinkResult> {
  // clonePath 是記憶根目錄：GitHub 模式的 clone，或雲端硬碟模式的資料夾
  if (!rootReady(opts.clonePath)) throw new MemSyncError('no-clone', 'Set up the memory storage first')
  const st = await projectState(tools, opts)
  const memPath = path.join(opts.workspace, MEMORY_DIR)
  let source: LinkResult['source'] = 'already-linked'
  let backup: string | undefined

  if (st.linkedElsewhere) {
    // 換了存放方式：把舊位置的記憶搬到新位置，連結改指過去（舊位置的檔案不刪）
    if (!opts.migrate) throw new MemSyncError('linked-elsewhere', `${MEMORY_DIR} already links somewhere else`)
    const from = st.linkedTo
    if (!from || !exists(path.join(from, 'handoff.md'))) throw new MemSyncError('linked-elsewhere', `${MEMORY_DIR} links to a folder without memory`)
    backup = path.join(opts.clonePath, BACKUP_DIR, st.key.replace('/', '__'), new Date().toISOString().replace(/[:.]/g, '-'))
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    fs.cpSync(from, backup, { recursive: true })
    if (!st.hasRemoteMemory) {
      fs.mkdirSync(path.dirname(st.target), { recursive: true })
      fs.cpSync(from, st.target, { recursive: true })
      source = 'local'
    } else {
      source = 'repo'
    }
    fs.unlinkSync(memPath) // 只移除連結本身
    fs.symlinkSync(st.target, memPath, process.platform === 'win32' ? 'junction' : 'dir')
  } else if (!st.linked) {
    if (!st.hasLocalMemory && !st.hasRemoteMemory) throw new MemSyncError('no-memory', 'This project has no .project-memory yet')
    if (st.hasLocalMemory) {
      backup = path.join(opts.clonePath, BACKUP_DIR, st.key.replace('/', '__'), new Date().toISOString().replace(/[:.]/g, '-'))
      fs.mkdirSync(path.dirname(backup), { recursive: true })
      fs.cpSync(memPath, backup, { recursive: true })
      if (!st.hasRemoteMemory) {
        fs.mkdirSync(path.dirname(st.target), { recursive: true })
        fs.cpSync(memPath, st.target, { recursive: true })
        source = 'local'
      } else {
        source = 'repo'
      }
      fs.rmSync(memPath, { recursive: true, force: true })
    } else {
      source = 'repo'
      if (exists(memPath)) fs.rmSync(memPath, { recursive: true, force: true }) // 空的或沒有 handoff 的殘留資料夾
    }
    fs.symlinkSync(st.target, memPath, process.platform === 'win32' ? 'junction' : 'dir')
  }

  if (opts.scripts) ensureMemoryScripts(st.target, opts.scripts)
  await restoreEntryFiles(tools, opts.workspace, st.target)

  // 記憶 repo：把這個專案的記憶推上去（雲端硬碟模式由同步程式上傳，這裡不做事）
  const rel = st.key
  if (exists(path.join(opts.clonePath, '.git')) && (await git(tools, opts.clonePath, 'status', '--porcelain', '--', rel)).stdout.trim()) {
    await ensureIdentity(tools, opts.clonePath, opts.login)
    await gitMust(tools, opts.clonePath, 'add', '-A', '--', rel)
    await gitMust(tools, opts.clonePath, 'commit', '-q', '-m', `memory: link ${st.key}`, '--', rel)
    await gitMust(tools, opts.clonePath, 'push', '-q', '-u', 'origin', 'HEAD')
  }

  // 專案 repo：停止追蹤記憶檔，補 .gitignore
  const ignoreChanged = ensureProjectIgnore(opts.workspace)
  let projectCommit: string | undefined
  if (st.tracked.length || ignoreChanged) projectCommit = await commitUntrack(tools, opts.workspace, st.tracked, opts.login)
  return { key: st.key, target: st.target, source, ...(backup ? { backup } : {}), ...(projectCommit ? { projectCommit } : {}) }
}

/**
 * 在專案 repo 提交「停止追蹤記憶檔＋新的 .gitignore」，用暫時的 index 組出 commit：
 * .project-memory 已經是連結，`git rm`／`git commit -- <path>` 會拒絕穿過連結的路徑；
 * 而且使用者 index 裡原本暫存的其他改動不能被一起提交。之後再把同樣的改動套到真正的 index。
 */
async function commitUntrack(tools: Tools, workspace: string, tracked: string[], login: string | undefined): Promise<string> {
  const gitDir = path.resolve(workspace, (await gitMust(tools, workspace, 'rev-parse', '--git-dir')).trim())
  const tmpIndex = path.join(gitDir, `memsync-index-${process.pid}`)
  const env = { GIT_INDEX_FILE: tmpIndex }
  const run = async (...args: string[]): Promise<string> => {
    const r = await tools.run(tools.git, args, { cwd: workspace, env })
    if (r.code !== 0) throw new MemSyncError('project-commit-failed', `git ${args.join(' ')}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`)
    return r.stdout.trim()
  }
  try {
    const parent = (await gitMust(tools, workspace, 'rev-parse', 'HEAD')).trim()
    await run('read-tree', parent)
    if (tracked.length) await run('update-index', '--force-remove', '--', ...tracked)
    const blob = await run('hash-object', '-w', '--', '.gitignore')
    await run('update-index', '--add', '--cacheinfo', `100644,${blob},.gitignore`)
    const tree = await run('write-tree')
    const name = (await git(tools, workspace, 'config', 'user.name')).stdout.trim()
    const email = (await git(tools, workspace, 'config', 'user.email')).stdout.trim()
    const who = login || 'workbench'
    const identity = [...(name ? [] : ['-c', `user.name=${who}`]), ...(email ? [] : ['-c', `user.email=${who}@users.noreply.github.com`])]
    const commit = await run(...identity, 'commit-tree', tree, '-p', parent, '-m', 'chore: move project memory to a private repository')
    await gitMust(tools, workspace, 'update-ref', '-m', 'memsync: untrack project memory', 'HEAD', commit, parent)
    // 真正的 index：同樣移除那些路徑、放入新的 .gitignore，其他暫存內容不動
    if (tracked.length) await gitMust(tools, workspace, 'update-index', '--force-remove', '--', ...tracked)
    await gitMust(tools, workspace, 'update-index', '--add', '--cacheinfo', `100644,${blob},.gitignore`)
    return commit.slice(0, 7)
  } finally {
    fs.rmSync(tmpIndex, { force: true })
  }
}

// ── 同步 ───────────────────────────────────────────────────────────────

export interface CloneState {
  exists: boolean
  origin?: string
  ahead?: number
  behind?: number
  dirty?: boolean
}

export async function cloneState(tools: Tools, clonePath: string, fetch = false): Promise<CloneState> {
  if (!exists(path.join(clonePath, '.git'))) return { exists: false }
  const origin = (await git(tools, clonePath, 'config', '--get', 'remote.origin.url')).stdout.trim()
  if (fetch) await git(tools, clonePath, 'fetch', '-q')
  const counts = (await git(tools, clonePath, 'rev-list', '--left-right', '--count', 'HEAD...@{u}')).stdout.trim().split(/\s+/)
  const dirty = !!(await git(tools, clonePath, 'status', '--porcelain')).stdout.trim()
  return { exists: true, origin, ahead: Number(counts[0]) || 0, behind: Number(counts[1]) || 0, dirty }
}

export interface SyncResult {
  committed: boolean
  pulled: boolean
  pushed: boolean
  /** 拉取或推送失敗時的訊息（例如兩台改了同一段文字） */
  error?: string
}

/**
 * 立即同步：先提交這台電腦尚未提交的記憶改動，再拉取（rebase）、推送。pullOnly 只拉取。
 * 有連結的專案會重新產生入口檔的記憶區塊。
 */
export async function syncNow(
  tools: Tools,
  opts: { clonePath: string; workspace?: string; pullOnly?: boolean; login?: string }
): Promise<SyncResult> {
  const res: SyncResult = { committed: false, pulled: false, pushed: false }
  // 雲端硬碟模式：同步交給 OneDrive／Google Drive，只重新產生入口檔
  if (isFolderRoot(opts.clonePath)) {
    if (opts.workspace) {
      const st = await projectState(tools, { workspace: opts.workspace, clonePath: opts.clonePath })
      if (st.linked) await restoreEntryFiles(tools, opts.workspace, st.target)
    }
    return res
  }
  if (!exists(path.join(opts.clonePath, '.git'))) throw new MemSyncError('no-clone', 'Set up the private memory repository first')
  if (!opts.pullOnly && (await git(tools, opts.clonePath, 'status', '--porcelain')).stdout.trim()) {
    await ensureIdentity(tools, opts.clonePath, opts.login)
    await gitMust(tools, opts.clonePath, 'add', '-A')
    await gitMust(tools, opts.clonePath, 'commit', '-q', '-m', `memory: sync from ${os.hostname()}`)
    res.committed = true
  }
  const pull = await git(tools, opts.clonePath, 'pull', '-q', '--rebase', '--autostash')
  if (pull.code !== 0) {
    await git(tools, opts.clonePath, 'rebase', '--abort')
    return { ...res, error: (pull.stderr || pull.stdout).trim().slice(0, 400) || 'pull failed' }
  }
  res.pulled = true
  if (!opts.pullOnly) {
    const ahead = (await git(tools, opts.clonePath, 'rev-list', '--count', '@{u}..HEAD')).stdout.trim()
    if (ahead && ahead !== '0') {
      const push = await git(tools, opts.clonePath, 'push', '-q')
      if (push.code !== 0) return { ...res, error: (push.stderr || push.stdout).trim().slice(0, 400) || 'push failed' }
      res.pushed = true
    }
  }
  if (opts.workspace) {
    const st = await projectState(tools, { workspace: opts.workspace, clonePath: opts.clonePath })
    if (st.linked) await restoreEntryFiles(tools, opts.workspace, st.target)
  }
  return res
}
