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

// ── 背景執行用的 worktree（放在 repo 內的 .cowork/<runId>/，git worktree list 與分支清單都看得到） ──

/** 把 .cowork/ 加進本機的 .git/info/exclude：主工作區的 git status 保持乾淨，也不動 repo 追蹤的 .gitignore */
export function excludeCoworkDir(commonDir: string): void {
  const file = path.join(commonDir, 'info', 'exclude')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    /* 還沒有這個檔 */
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === '.cowork/')) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# Agent Workbench Linux Cowork worktrees\n.cowork/\n`)
}

export async function addWorktree(repoRoot: string, dir: string, branch: string, base: string): Promise<void> {
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  // 分支已存在就失敗（不覆寫使用者或上一場會議的分支）
  await git(repoRoot, ['worktree', 'add', '-b', branch, dir, base])
}

/** 主工作區有 node_modules、且 worktree 會忽略它時，用 junction 連過去（不用再安裝；也不會被 commit） */
export async function linkNodeModules(repoRoot: string, worktree: string): Promise<boolean> {
  const src = path.join(repoRoot, 'node_modules')
  const dst = path.join(worktree, 'node_modules')
  if (!fs.existsSync(src) || fs.existsSync(dst)) return false
  try {
    await git(worktree, ['check-ignore', '-q', 'node_modules'])
  } catch {
    return false // 沒被忽略：連過去會被 git add -A 收進 commit
  }
  fs.symlinkSync(src, dst, 'junction')
  return true
}

/** repo 沒設 user.name／user.email 時（commit、cherry-pick、merge 都需要）用的身分；有設就用使用者的 */
async function identity(dir: string): Promise<string[]> {
  const has = async (k: string): Promise<boolean> => !!(await git(dir, ['config', k]).catch(() => '')).trim()
  if ((await has('user.name')) && (await has('user.email'))) return []
  return ['-c', 'user.name=Agent Workbench Linux Cowork', '-c', 'user.email=cowork@agent-workbench-linux.invalid']
}

/** 把 worktree 的所有變動 commit；沒有變動回 null */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(dir, ['add', '-A'])
  try {
    await git(dir, ['diff', '--cached', '--quiet'])
    return null
  } catch {
    /* 有變動 */
  }
  await git(dir, [...(await identity(dir)), 'commit', '-q', '-m', message])
  return (await git(dir, ['rev-parse', 'HEAD'])).trim()
}

export async function hasChanges(dir: string): Promise<boolean> {
  return (await git(dir, ['status', '--porcelain', '--untracked-files=all'])).trim().length > 0
}

/** cherry-pick 一串 commit；衝突就還原並回報是哪一個 */
export async function cherryPickAll(dir: string, commits: string[]): Promise<{ ok: true } | { ok: false; commit: string; message: string }> {
  const id = await identity(dir)
  for (const c of commits) {
    try {
      // 已經在這條線上的 commit 不重複套用
      await git(dir, ['merge-base', '--is-ancestor', c, 'HEAD'])
      continue
    } catch {
      /* 還沒有 */
    }
    try {
      await git(dir, [...id, 'cherry-pick', '--allow-empty', '--keep-redundant-commits', c])
    } catch (e) {
      try {
        await git(dir, ['cherry-pick', '--abort'])
      } catch {
        /* 沒有進行中的 cherry-pick */
      }
      return { ok: false, commit: c, message: (e as Error).message.slice(0, 500) }
    }
  }
  return { ok: true }
}

export async function diffStat(dir: string, base: string, head: string): Promise<string> {
  return (await git(dir, ['diff', '--stat', `${base}..${head}`])).trim().slice(0, 8000)
}

/**
 * 把分支合併回使用者的分支：主工作區必須乾淨、而且目前就在原本的來源分支上；
 * 衝突就 merge --abort 還原，不自動選邊。
 */
export async function mergeBranch(
  repoRoot: string,
  expectBranch: string,
  branch: string,
  message: string
): Promise<{ ok: true; commit: string } | { ok: false; reason: 'wrong-branch' | 'dirty' | 'conflict'; message: string }> {
  const current = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  if (current !== expectBranch) return { ok: false, reason: 'wrong-branch', message: current }
  // 只看已追蹤檔案：未追蹤的檔案（例如 app 自己的 .workbench-linux/）不擋；真的會被覆寫時 git merge 自己會拒絕
  const dirty = (await git(repoRoot, ['status', '--porcelain', '--untracked-files=no'])).trim()
  if (dirty) return { ok: false, reason: 'dirty', message: dirty.split(/\r?\n/).slice(0, 20).join('\n') }
  try {
    await git(repoRoot, [...(await identity(repoRoot)), 'merge', '--no-ff', '-m', message, branch])
  } catch (e) {
    try {
      await git(repoRoot, ['merge', '--abort'])
    } catch {
      /* 沒有進行中的 merge */
    }
    return { ok: false, reason: 'conflict', message: (e as Error).message.slice(0, 500) }
  }
  return { ok: true, commit: (await git(repoRoot, ['rev-parse', 'HEAD'])).trim() }
}

/** 移除這場會議的 worktree（分支保留，git 紀錄還在）；只動 .cowork/ 底下的路徑 */
export async function removeWorktrees(repoRoot: string, root: string, dirs: string[]): Promise<void> {
  const base = path.resolve(repoRoot, '.cowork')
  for (const d of dirs) {
    const rel = path.relative(base, path.resolve(d))
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
    // junction 先拆掉，免得 worktree remove 跟著進到主工作區的 node_modules
    const nm = path.join(d, 'node_modules')
    try {
      if (fs.lstatSync(nm).isSymbolicLink()) fs.unlinkSync(nm)
    } catch {
      /* 沒有 */
    }
    try {
      await git(repoRoot, ['worktree', 'remove', '--force', d])
    } catch {
      /* 已不在；下面的 prune 會清紀錄 */
    }
  }
  await git(repoRoot, ['worktree', 'prune']).catch(() => '')
  const relRoot = path.relative(base, path.resolve(root))
  if (relRoot && !relRoot.startsWith('..') && !path.isAbsolute(relRoot)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  try {
    fs.rmdirSync(base)
  } catch {
    /* 還有別場會議的 worktree */
  }
}
