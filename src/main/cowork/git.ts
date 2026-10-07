// Cowork 的 git 操作：讀基線、建立唯讀規劃用的快照、偵測副作用、清掉快照。
// 只用 node 內建模組，scripts/check-cowork.mts 可以直接在暫存 repo 上測。
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout)
    })
  })
}

export interface Baseline {
  root: string
  commonDir: string
  branch: string
  head: string
  /** 未提交的檔案（含 untracked）；規劃以 head 快照進行，這些不會被看到 */
  dirty: string[]
  /** merge／rebase 進行中之類的狀態提醒 */
  warnings: string[]
}

/** 讀工作區的 git 基線。不是 git repo、還沒有 commit 都會丟出可讀的錯誤 */
export async function readBaseline(dir: string): Promise<Baseline> {
  let root: string
  try {
    root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    throw new Error('not-a-git-repo')
  }
  let head: string
  try {
    head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim()
  } catch {
    throw new Error('no-commits')
  }
  const commonDir = path.resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).trim())
  const gitDir = path.resolve(root, (await git(root, ['rev-parse', '--git-dir'])).trim())
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const dirty: string[] = []
  const parts = status.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    dirty.push(entry.slice(3))
    // rename／copy 後面多一段原路徑
    if (entry[0] === 'R' || entry[0] === 'C') i++
  }
  const warnings: string[] = []
  for (const [file, label] of [
    ['MERGE_HEAD', 'merge-in-progress'],
    ['rebase-merge', 'rebase-in-progress'],
    ['rebase-apply', 'rebase-in-progress'],
    ['CHERRY_PICK_HEAD', 'cherry-pick-in-progress']
  ] as const) {
    if (fs.existsSync(path.join(gitDir, file)) && !warnings.includes(label)) warnings.push(label)
  }
  return { root: path.resolve(root), commonDir, branch, head, dirty, warnings }
}

/**
 * 快照放在 repo 的 git common dir 底下（<commonDir>/cowork/<runId>/snapshot）。
 * 不放 userData 的原因：codex 的 Windows sandbox 讀不到使用者目錄（2026-10-07 實測），
 * 放在 repo 旁邊才跟 repo 本身同一套權限。.git 底下也不會被專案檔案樹監看。
 */
export function snapshotDirFor(commonDir: string, runId: string): string {
  return path.join(commonDir, 'cowork', runId, 'snapshot')
}

/** 以 --shared 複製（物件走 alternates，不實際複製），再 checkout 到基線 commit */
export async function createSnapshot(root: string, dir: string, commit: string): Promise<void> {
  if (fs.existsSync(dir)) removeTree(dir)
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  await git(path.dirname(dir), ['clone', '--quiet', '--shared', '--no-checkout', '--', root, dir])
  await git(dir, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit])
}

/**
 * 回傳快照相對基線的所有變動；空陣列代表乾淨。
 * --ignored 也要看：新快照沒有被忽略的檔，寫進 out/ 之類的目錄一樣算副作用。
 */
export async function snapshotChanges(dir: string, commit: string): Promise<string[]> {
  const changes: string[] = []
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim()
  if (head !== commit) changes.push(`HEAD moved: ${commit.slice(0, 12)} -> ${head.slice(0, 12)}`)
  const status = await git(dir, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'])
  for (const line of status.split(/\r?\n/)) if (line.trim()) changes.push(line)
  return changes
}

/** 只刪 mustBeUnder 底下的路徑，絕不遞迴刪到 repo 本身或外部連結指向的位置 */
export function removeSnapshot(dir: string, mustBeUnder: string): void {
  if (!fs.existsSync(dir)) return
  const real = fs.realpathSync(dir)
  const base = fs.realpathSync(mustBeUnder)
  const rel = path.relative(base, real)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to delete ${real}: not under ${base}`)
  }
  removeTree(real)
  // 順手把空掉的 run 目錄與 cowork 目錄收掉
  for (let p = path.dirname(real); p !== base && p.startsWith(base); p = path.dirname(p)) {
    try {
      fs.rmdirSync(p)
    } catch {
      break
    }
  }
  try {
    fs.rmdirSync(base)
  } catch {
    /* 還有其他 run 的快照 */
  }
}

/** Windows 上 git 會把部分檔案設成唯讀，直接 rm 會 EPERM：先解除唯讀再刪 */
function removeTree(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    const walk = (p: string): void => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name)
        if (e.isDirectory() && !e.isSymbolicLink()) walk(full)
        else
          try {
            fs.chmodSync(full, 0o666)
          } catch {
            /* 盡力而為 */
          }
      }
    }
    walk(dir)
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

/**
 * scope 路徑若經由 symlink／junction 跨出工作樹就回傳說明，否則 null。
 * 路徑本身還不存在（任務要新建的檔）時，檢查已存在的最長前綴。
 */
export function scopeEscapes(treeRoot: string, relPath: string): string | null {
  const base = fs.realpathSync(treeRoot)
  let probe = path.resolve(treeRoot, relPath)
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
  const real = fs.realpathSync(probe)
  const rel = path.relative(base, real)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return `${relPath} resolves outside the repository (${real})`
  return null
}
