// node --experimental-strip-types scripts/check-memsync.mts
// Memory sync end to end with real git: local bare repositories stand in for GitHub (via
// url.<base>.insteadOf) and a fake gh answers `api user`, `repo view`, `repo create`, `auth setup-git`.
// Two "PCs" share one private memory repository; the project repository stops tracking memory.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectRepoByUrl, createRepoViaGitLogin, parseRepoInput, ensureRepo, ensureFolder, linkProject, projectState, syncNow, ghStatus, MemSyncError, type Run, type Tools } from '../src/main/memsync/core.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memsync-check-'))
const remotes = path.join(tmp, 'remotes')
fs.mkdirSync(remotes)
const fileUrl = (p: string): string => 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '')
// every git process (including those started by bash scripts) maps https://github.com/ to the bare repos
process.env.GIT_CONFIG_COUNT = '2'
process.env.GIT_CONFIG_KEY_0 = `url.${fileUrl(remotes)}/.insteadOf`
process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
process.env.GIT_CONFIG_KEY_1 = 'init.defaultBranch'
process.env.GIT_CONFIG_VALUE_1 = 'main'
process.env.GIT_TERMINAL_PROMPT = '0'

const GIT = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git'
const BASH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash'
const exec: Run = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts?.cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...(opts?.env || {}) } }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0, stdout, stderr })
    )
  })

// fake gh: repos[full] = private?
const repos = new Map<string, boolean>()
let loggedIn = true
const ghCalls: string[] = []
const run: Run = async (cmd, args, opts) => {
  if (cmd !== 'FAKE-GH') return exec(cmd, args, opts)
  ghCalls.push(args.slice(0, 2).join(' '))
  const ok = (stdout = ''): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout, stderr: '' })
  const fail = (stderr: string): { code: number; stdout: string; stderr: string } => ({ code: 1, stdout: '', stderr })
  if (args[0] === 'api' && args[1] === 'user') return loggedIn ? ok('tester\n') : fail('not logged in')
  if (args[0] === 'auth' && args[1] === 'setup-git') return ok()
  if (args[0] === 'repo' && args[1] === 'view') return repos.has(args[2]) ? ok(String(repos.get(args[2])) + '\n') : fail('not found')
  if (args[0] === 'repo' && args[1] === 'create') {
    const full = args[2]
    const priv = args.includes('--private')
    const bare = path.join(remotes, ...full.split('/')) + '.git'
    fs.mkdirSync(path.dirname(bare), { recursive: true })
    const r = await exec(GIT, ['init', '-q', '--bare', bare])
    if (r.code !== 0) return r
    repos.set(full, priv)
    return ok()
  }
  return fail('fake gh: unsupported ' + args.join(' '))
}
const tools: Tools = { git: GIT, gh: 'FAKE-GH', run }
const g = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await exec(GIT, args, { cwd })
  assert.equal(r.code, 0, `git ${args.join(' ')} in ${cwd}: ${r.stderr}`)
  return r.stdout
}
const isLink = (p: string): boolean => fs.lstatSync(p).isSymbolicLink()
// 專案的記憶腳本：這個 repo 不追蹤 .project-memory，從內建範本與 fixture 取（不依賴本機記憶）
const memScript = (f: string): string =>
  f === 'sync-entry-files.sh' ? path.join(ROOT, 'scripts', 'fixtures', f) : path.join(ROOT, 'src', 'main', 'memsync', 'templates', f)

// ── project repo on GitHub, with memory tracked the old way ─────────────
const projBare = path.join(remotes, 'someone', 'demo.git')
fs.mkdirSync(path.dirname(projBare), { recursive: true })
await g(tmp, 'init', '-q', '--bare', projBare)
const pcA = path.join(tmp, 'pcA')
const projA = path.join(pcA, 'demo')
fs.mkdirSync(pcA)
await g(pcA, 'clone', '-q', 'https://github.com/someone/demo.git', 'demo')
await g(projA, 'config', 'user.name', 'Dev')
await g(projA, 'config', 'user.email', 'dev@example.com')
fs.writeFileSync(path.join(projA, 'app.js'), 'console.log(1)\n')
fs.mkdirSync(path.join(projA, '.project-memory', 'archive'), { recursive: true })
for (const f of ['commit-handoff.sh', 'status.sh', 'sync-entry-files.sh']) fs.copyFileSync(memScript(f), path.join(projA, '.project-memory', f))
fs.writeFileSync(path.join(projA, '.project-memory', 'INDEX.md'), '# Index\n')
fs.writeFileSync(path.join(projA, '.project-memory', 'handoff.md'), '# Latest Handoff\n\n## State\n- A1\n')
fs.writeFileSync(path.join(projA, 'AGENTS.md'), '# Agents\n')
fs.mkdirSync(path.join(projA, '.agents', 'rules'), { recursive: true })
fs.writeFileSync(path.join(projA, '.agents', 'rules', 'shared-memory.md'), '# rules\n')
await g(projA, 'add', '-A')
await g(projA, 'commit', '-q', '-m', 'init with tracked memory')
await g(projA, 'push', '-q', 'origin', 'HEAD:main')

// ── refusals ────────────────────────────────────────────────────────────
loggedIn = false
await assert.rejects(ensureRepo(tools, { name: 'ai-project-memory', clonePath: path.join(pcA, 'mem') }), (e: MemSyncError) => e.code === 'gh-not-logged-in')
loggedIn = true
repos.set('tester/public-mem', false)
await assert.rejects(ensureRepo(tools, { name: 'public-mem', clonePath: path.join(pcA, 'pub') }), (e: MemSyncError) => e.code === 'repo-public')
assert.ok(!fs.existsSync(path.join(pcA, 'pub')), 'nothing cloned for a public repo')
await assert.rejects(ensureRepo(tools, { name: '../evil', clonePath: path.join(pcA, 'x') }), (e: MemSyncError) => e.code === 'bad-repo-name')
assert.deepEqual(await ghStatus({ ...tools, gh: null }), { installed: false, loggedIn: false })
console.log('refusals: not logged in / public repo / bad name / no gh ok')

// ── PC A: create the private repo and move this project's memory into it ─
const memA = path.join(pcA, 'mem')
const r1 = await ensureRepo(tools, { name: 'ai-project-memory', clonePath: memA })
assert.equal(r1.repo, 'tester/ai-project-memory')
assert.ok(r1.created && r1.cloned)
assert.equal(repos.get('tester/ai-project-memory'), true, 'created private')
const sA = await projectState(tools, { workspace: projA, clonePath: memA })
assert.equal(sA.key, 'someone/demo')
assert.ok(sA.hasLocalMemory && !sA.hasRemoteMemory && !sA.linked)
assert.ok(sA.tracked.includes('.project-memory/handoff.md') && sA.tracked.includes('AGENTS.md'))
// the user has an unrelated change staged: it must not end up in the untrack commit, and stays staged
fs.writeFileSync(path.join(projA, 'app.js'), 'console.log(2)\n')
await g(projA, 'add', 'app.js')
const l1 = await linkProject(tools, { workspace: projA, clonePath: memA, login: 'tester' })
assert.deepEqual((await g(projA, 'show', '--name-only', '--format=', 'HEAD')).split(/\r?\n/).filter((f) => f === 'app.js'), [], 'staged app.js not in the untrack commit')
assert.equal((await g(projA, 'diff', '--cached', '--name-only')).trim(), 'app.js', 'app.js still staged')
await g(projA, 'commit', '-q', '-m', 'unrelated change')
assert.equal(l1.source, 'local')
assert.ok(l1.backup && fs.existsSync(path.join(l1.backup, 'handoff.md')), 'local backup kept')
assert.ok(isLink(path.join(projA, '.project-memory')), '.project-memory is now a link')
assert.match(fs.readFileSync(path.join(projA, '.project-memory', 'handoff.md'), 'utf8'), /A1/)
// project repo: memory and entry files no longer tracked, ignored, nothing else touched
const trackedAfter = (await g(projA, 'ls-files')).split(/\r?\n/).filter(Boolean)
assert.deepEqual(trackedAfter.sort(), ['.gitignore', 'app.js'])
assert.equal((await g(projA, 'status', '--porcelain')).trim(), '', 'project working tree clean (link, entry files ignored)')
assert.match(fs.readFileSync(path.join(projA, '.gitignore'), 'utf8'), /\.project-memory\//)
assert.ok(l1.projectCommit)
assert.equal((await g(projA, 'log', '-1', '--skip=1', '--format=%s')).trim(), 'chore: move project memory to a private repository')
assert.deepEqual(
  (await g(projA, 'show', '--name-status', '--format=', 'HEAD~1')).split(/\r?\n/).filter(Boolean).map((l) => l.split('\t')[1]).sort(),
  ['.agents/rules/shared-memory.md', '.gitignore', '.project-memory/INDEX.md', '.project-memory/commit-handoff.sh', '.project-memory/handoff.md',
    '.project-memory/status.sh', '.project-memory/sync-entry-files.sh', 'AGENTS.md'].sort(),
  'untrack commit touches only memory paths and .gitignore'
)
// memory repo: pushed, backups not committed
const remoteFiles = (await g(memA, 'ls-tree', '-r', '--name-only', 'origin/main')).split(/\r?\n/)
assert.ok(remoteFiles.includes('someone/demo/handoff.md') && remoteFiles.includes('someone/demo/entry/AGENTS.md'))
assert.ok(!remoteFiles.some((f) => f.startsWith('.local-backups/')), 'backups stay local')
console.log('PC A: private repo created, memory moved + pushed, project stopped tracking memory ok')

// commit-handoff.sh on A now commits to the private repo and pushes
fs.appendFileSync(path.join(projA, '.project-memory', 'handoff.md'), '- A2\n')
const ch = await exec(BASH, ['.project-memory/commit-handoff.sh', 'docs(memory): A2'], { cwd: projA })
assert.equal(ch.code, 0, ch.stdout + ch.stderr)
assert.match(ch.stdout, /Committed memory to the private repository/)
assert.match(ch.stdout, /Pushed/)
assert.equal((await g(projA, 'log', '-1', '--format=%s')).trim(), 'unrelated change', 'project repo untouched by commit-handoff.sh')
// secret is refused
fs.appendFileSync(path.join(projA, '.project-memory', 'handoff.md'), '- api_key = sk_live_abcdefghijklmnop\n')
const sec = await exec(BASH, ['.project-memory/commit-handoff.sh', 'leak'], { cwd: projA })
assert.notEqual(sec.code, 0)
assert.match(sec.stdout, /Possible secret/)
const hA = path.join(projA, '.project-memory', 'handoff.md')
fs.writeFileSync(hA, fs.readFileSync(hA, 'utf8').replace(/- api_key.*\n/, ''))
console.log('commit-handoff.sh: commits/pushes to the private repo, refuses secrets ok')

// ── PC B: fresh project clone (no memory), link from the private repo ───
const pcB = path.join(tmp, 'pcB')
fs.mkdirSync(pcB)
await g(pcB, 'clone', '-q', 'https://github.com/someone/demo.git', 'demo')
const projB = path.join(pcB, 'demo')
await g(projB, 'config', 'user.name', 'Dev')
await g(projB, 'config', 'user.email', 'dev@example.com')
assert.ok(fs.existsSync(path.join(projB, '.project-memory', 'handoff.md')), 'B cloned before A pushed: old tracked memory present')
// A pushes the untrack commit; pulling it removes the tracked memory files from B's working tree
await g(projA, 'push', '-q', 'origin', 'HEAD:main')
await g(projB, 'pull', '-q', 'origin', 'main')
assert.ok(!fs.existsSync(path.join(projB, '.project-memory', 'handoff.md')), 'pull removed the old tracked memory on B')
const memB = path.join(pcB, 'mem')
const r2 = await ensureRepo(tools, { name: 'ai-project-memory', clonePath: memB })
assert.ok(!r2.created && r2.cloned)
const l2 = await linkProject(tools, { workspace: projB, clonePath: memB, login: 'tester' })
assert.equal(l2.source, 'repo')
assert.ok(!l2.projectCommit, 'no project commit needed on PC B')
assert.match(fs.readFileSync(path.join(projB, '.project-memory', 'handoff.md'), 'utf8'), /A2/)
assert.ok(fs.existsSync(path.join(projB, 'AGENTS.md')), 'entry files restored from the memory repo')
assert.match(fs.readFileSync(path.join(projB, 'AGENTS.md'), 'utf8'), /BEGIN AUTO-MEMORY/)
assert.equal((await g(projB, 'status', '--porcelain')).trim(), '')
console.log('PC B: linked from the private repo, entry files restored ok')

// B writes, A syncs
fs.appendFileSync(path.join(projB, '.project-memory', 'handoff.md'), '- B1\n')
const chB = await exec(BASH, ['.project-memory/commit-handoff.sh', 'docs(memory): B1'], { cwd: projB })
assert.equal(chB.code, 0, chB.stdout + chB.stderr)
const sync = await syncNow(tools, { clonePath: memA, workspace: projA, login: 'tester' })
assert.ok(sync.pulled && !sync.error, JSON.stringify(sync))
assert.match(fs.readFileSync(path.join(projA, '.project-memory', 'handoff.md'), 'utf8'), /B1/)
assert.match(fs.readFileSync(path.join(projA, 'AGENTS.md'), 'utf8'), /B1/, 'A entry files refreshed after sync')
console.log('sync: B -> private repo -> A, entry files refreshed ok')

// uncommitted edit on A + new commit on B → syncNow commits, rebases, pushes
fs.appendFileSync(path.join(projA, '.project-memory', 'STATE.md'), 'A state\n')
fs.appendFileSync(path.join(projB, '.project-memory', 'DECISIONS.md'), 'B decision\n')
assert.equal((await exec(BASH, ['.project-memory/commit-handoff.sh', 'B2'], { cwd: projB })).code, 0)
const s2 = await syncNow(tools, { clonePath: memA, workspace: projA, login: 'tester' })
assert.ok(s2.committed && s2.pulled && s2.pushed && !s2.error, JSON.stringify(s2))
const s3 = await syncNow(tools, { clonePath: memB, workspace: projB, pullOnly: true })
assert.ok(s3.pulled && !s3.pushed)
assert.match(fs.readFileSync(path.join(projB, '.project-memory', 'STATE.md'), 'utf8'), /A state/)
console.log('sync: concurrent edits on both PCs merged ok')

// a real conflict (both PCs rewrite the same line): sync reports it and leaves no rebase in progress
await syncNow(tools, { clonePath: memB, workspace: projB, login: 'tester' })
const hB = path.join(projB, '.project-memory', 'handoff.md')
fs.writeFileSync(hB, fs.readFileSync(hB, 'utf8').replace('- A1', '- A1 (edited on B)'))
assert.equal((await exec(BASH, ['.project-memory/commit-handoff.sh', 'B edit'], { cwd: projB })).code, 0)
fs.writeFileSync(hA, fs.readFileSync(hA, 'utf8').replace('- A1', '- A1 (edited on A)'))
const conflict = await syncNow(tools, { clonePath: memA, workspace: projA, login: 'tester' })
assert.ok(conflict.committed && !conflict.pulled && conflict.error, JSON.stringify(conflict))
assert.ok(!fs.existsSync(path.join(memA, '.git', 'rebase-merge')) && !fs.existsSync(path.join(memA, '.git', 'rebase-apply')), 'rebase aborted')
assert.match(fs.readFileSync(hA, 'utf8'), /edited on A/, "A's edit kept locally")
const cs = await (await import('../src/main/memsync/core.ts')).cloneState(tools, memA)
assert.ok(cs.ahead === 1 && cs.behind === 1 && !cs.dirty, JSON.stringify(cs))
console.log('sync: conflicting edits reported, rebase aborted, local commit kept ok')

// linking again is idempotent
const l3 = await linkProject(tools, { workspace: projA, clonePath: memA, login: 'tester' })
assert.equal(l3.source, 'already-linked')
assert.ok(!l3.projectCommit)

// ── cloud-drive folder mode (OneDrive / Google Drive): no git, no network in Workbench ──
const cloud = path.join(tmp, 'OneDrive') // stands in for the drive root; both PCs see the same synced folder
fs.mkdirSync(cloud)
assert.throws(() => ensureFolder({ root: cloud, provider: 'onedrive', cloudRoots: [cloud] }), (e: MemSyncError) => e.code === 'pick-subfolder')
assert.throws(() => ensureFolder({ root: path.join(tmp, 'elsewhere'), provider: 'onedrive', cloudRoots: [cloud] }), (e: MemSyncError) => e.code === 'folder-outside-cloud')
assert.throws(() => ensureFolder({ root: path.join(cloud, 'm'), provider: 'onedrive', cloudRoots: [] }), (e: MemSyncError) => e.code === 'onedrive-missing')
fs.mkdirSync(path.join(cloud, 'repo', '.git'), { recursive: true })
assert.throws(() => ensureFolder({ root: path.join(cloud, 'repo'), provider: 'onedrive', cloudRoots: [cloud] }), (e: MemSyncError) => e.code === 'folder-is-git-repo')
const folder = path.join(cloud, 'ai-project-memory')
ensureFolder({ root: folder, provider: 'onedrive', cloudRoots: [cloud] })
assert.ok(fs.existsSync(path.join(folder, '.workbench-memory.json')))

// PC C: a project with local memory moves into the folder
const projC = path.join(tmp, 'pcC', 'demo2')
fs.mkdirSync(projC, { recursive: true })
await g(projC, 'init', '-q')
await g(projC, 'config', 'user.name', 'Dev')
await g(projC, 'config', 'user.email', 'dev@example.com')
await g(projC, 'remote', 'add', 'origin', 'https://github.com/someone/demo2.git')
fs.mkdirSync(path.join(projC, '.project-memory'))
for (const f of ['commit-handoff.sh', 'status.sh', 'sync-entry-files.sh']) fs.copyFileSync(memScript(f), path.join(projC, '.project-memory', f))
fs.writeFileSync(path.join(projC, '.project-memory', 'handoff.md'), '# Latest Handoff\n\n## State\n- C1\n')
fs.writeFileSync(path.join(projC, '.project-memory', 'INDEX.md'), '# Index\n')
fs.writeFileSync(path.join(projC, 'AGENTS.md'), '# Agents\n')
fs.writeFileSync(path.join(projC, 'main.js'), '1\n')
await g(projC, 'add', '-A')
await g(projC, 'commit', '-q', '-m', 'init')

// memory sync OFF: commit-handoff.sh keeps the handoff local, makes no commit, touches no network
const gitTrace = path.join(tmp, 'git-trace.txt')
const off = await exec(BASH, ['.project-memory/commit-handoff.sh', 'off'], { cwd: projC, env: { GIT_TRACE: gitTrace } })
assert.equal(off.code, 0, off.stdout + off.stderr)
assert.match(off.stdout, /Memory sync is off/)
assert.equal((await g(projC, 'log', '--oneline')).trim().split('\n').length, 1, 'nothing committed when off')
const st0 = await exec(BASH, ['.project-memory/status.sh'], { cwd: projC, env: { GIT_TRACE: gitTrace } })
assert.equal(st0.code, 0)
const traced = fs.existsSync(gitTrace) ? fs.readFileSync(gitTrace, 'utf8') : ''
assert.ok(!/\b(fetch|push|pull|ls-remote|remote-https)\b/.test(traced), 'no network git commands while memory sync is off')
console.log('memory sync off: handoff local only, no commit, no network git calls ok')

const lc = await linkProject(tools, { workspace: projC, clonePath: folder })
assert.equal(lc.source, 'local')
assert.ok(isLink(path.join(projC, '.project-memory')))
assert.ok(fs.existsSync(path.join(folder, 'someone', 'demo2', 'handoff.md')))
assert.ok(!fs.existsSync(path.join(folder, '.git')), 'folder mode never creates a git repository')
assert.ok(lc.projectCommit, 'project stopped tracking memory')
assert.deepEqual((await g(projC, 'ls-files')).split(/\r?\n/).filter(Boolean).sort(), ['.gitignore', 'main.js'])
fs.appendFileSync(path.join(projC, '.project-memory', 'handoff.md'), '- C2\n')
const chC = await exec(BASH, ['.project-memory/commit-handoff.sh', 'C2'], { cwd: projC })
assert.equal(chC.code, 0, chC.stdout + chC.stderr)
assert.match(chC.stdout, /Saved in the synced folder/)
assert.ok(fs.existsSync(path.join(folder, 'someone', 'demo2', 'entry', 'AGENTS.md')), 'entry template stored in the folder')
assert.deepEqual(await syncNow(tools, { clonePath: folder, workspace: projC }), { committed: false, pulled: false, pushed: false })

// PC D: the cloud client delivered the same folder; a fresh clone links to it
const projD = path.join(tmp, 'pcD', 'demo2')
fs.mkdirSync(path.dirname(projD), { recursive: true })
fs.cpSync(projC, projD, { recursive: true, filter: (src) => !src.includes(`${path.sep}.project-memory`) && path.basename(src) !== 'AGENTS.md' })
// a stale upstream-style script in the shared storage (it would `git add -f` memory into the
// project repo) is replaced by the bundled version when a project links
const storedScript = path.join(folder, 'someone', 'demo2', 'commit-handoff.sh')
fs.writeFileSync(storedScript, '#!/usr/bin/env bash\ngit add -f -- .project-memory\n')
const bundled = {
  'commit-handoff.sh': fs.readFileSync(path.join(ROOT, 'src', 'main', 'memsync', 'templates', 'commit-handoff.sh'), 'utf8'),
  'status.sh': fs.readFileSync(path.join(ROOT, 'src', 'main', 'memsync', 'templates', 'status.sh'), 'utf8')
}
const ld = await linkProject(tools, { workspace: projD, clonePath: folder, scripts: bundled })
assert.equal(ld.source, 'repo')
assert.equal(fs.readFileSync(storedScript, 'utf8'), bundled['commit-handoff.sh'].replace(/\r\n/g, '\n'), 'stale script replaced')
assert.match(fs.readFileSync(path.join(projD, '.project-memory', 'handoff.md'), 'utf8'), /C2/)
assert.match(fs.readFileSync(path.join(projD, 'AGENTS.md'), 'utf8'), /C2/, 'entry file restored and regenerated from the shared handoff')
console.log('folder mode: refusals, move + untrack, commit-handoff saves only, second PC links ok')

// switching storage: projA is linked to the GitHub clone; move it to the cloud folder
const sMig = await projectState(tools, { workspace: projA, clonePath: folder })
assert.ok(sMig.linkedElsewhere && sMig.linkedToOldStore, JSON.stringify(sMig))
await assert.rejects(linkProject(tools, { workspace: projA, clonePath: folder }), (e: MemSyncError) => e.code === 'linked-elsewhere', 'no migration without migrate')
const oldHandoff = fs.readFileSync(path.join(memA, 'someone', 'demo', 'handoff.md'), 'utf8')
const lm = await linkProject(tools, { workspace: projA, clonePath: folder, migrate: true, scripts: bundled })
assert.equal(lm.source, 'local')
assert.ok((await projectState(tools, { workspace: projA, clonePath: folder })).linked, 'now linked to the folder')
assert.equal(fs.readFileSync(path.join(folder, 'someone', 'demo', 'handoff.md'), 'utf8'), oldHandoff, 'memory copied to the new storage')
assert.equal(fs.readFileSync(path.join(memA, 'someone', 'demo', 'handoff.md'), 'utf8'), oldHandoff, 'old storage untouched (only the link was removed)')
assert.match(fs.readFileSync(path.join(folder, 'someone', 'demo', 'commit-handoff.sh'), 'utf8'), /Memory sync is off/, 'bundled scripts installed')
const chMig = await exec(BASH, ['.project-memory/commit-handoff.sh', 'after move'], { cwd: projA })
assert.match(chMig.stdout, /Saved in the synced folder/)
console.log('switch storage: GitHub clone -> cloud folder migration, old copy kept ok')

// ── PC N without gh: user-created private repo by URL, public check via the (fake) unauthenticated API ──
assert.equal(parseRepoInput('https://github.com/tester/ai-project-memory'), 'tester/ai-project-memory')
assert.equal(parseRepoInput('https://github.com/tester/ai-project-memory.git/'), 'tester/ai-project-memory')
assert.equal(parseRepoInput('git@github.com:tester/my.mem.git'), 'tester/my.mem')
assert.equal(parseRepoInput(' tester/ai-project-memory '), 'tester/ai-project-memory')
assert.equal(parseRepoInput('https://gitlab.com/tester/x'), null)
assert.equal(parseRepoInput('https://github.com/tester/../x'), null)
const apiCalls: string[] = []
const noGh = (status: number | Error): Tools => ({
  git: GIT,
  gh: null,
  run,
  httpStatus: async (url) => {
    apiCalls.push(url)
    if (status instanceof Error) throw status
    if (status !== 0) return status
    const full = url.replace('https://api.github.com/repos/', '')
    return repos.get(full) === false ? 200 : 404 // unauthenticated: public repos visible, private/missing 404
  }
})
const pcN = path.join(tmp, 'pcN')
fs.mkdirSync(pcN)
const memN = path.join(pcN, 'mem')
const ghBefore = ghCalls.length
await assert.rejects(connectRepoByUrl(noGh(0), { input: 'not a url', clonePath: memN }), (e: MemSyncError) => e.code === 'bad-repo-url')
await assert.rejects(connectRepoByUrl(noGh(0), { input: 'https://github.com/tester/public-mem', clonePath: memN }), (e: MemSyncError) => e.code === 'repo-public')
await assert.rejects(connectRepoByUrl(noGh(403), { input: 'tester/ai-project-memory', clonePath: memN }), (e: MemSyncError) => e.code === 'privacy-check-failed', 'rate limit: refuse, do not guess')
await assert.rejects(connectRepoByUrl(noGh(new Error('offline')), { input: 'tester/ai-project-memory', clonePath: memN }), (e: MemSyncError) => e.code === 'privacy-check-failed')
await assert.rejects(connectRepoByUrl(noGh(0), { input: 'tester/does-not-exist', clonePath: memN }), (e: MemSyncError) => e.code === 'repo-unreachable')
assert.ok(!fs.existsSync(memN), 'nothing cloned on refusal')
const rc = await connectRepoByUrl(noGh(0), { input: 'https://github.com/tester/ai-project-memory.git', clonePath: memN })
assert.deepEqual([rc.repo, rc.created, rc.cloned], ['tester/ai-project-memory', false, true])
assert.equal(apiCalls.at(-1), 'https://api.github.com/repos/tester/ai-project-memory')
await g(pcN, 'clone', '-q', 'https://github.com/someone/demo.git', 'demo')
const projN = path.join(pcN, 'demo')
const lcN = await linkProject(noGh(0), { workspace: projN, clonePath: memN, login: 'tester' })
assert.equal(lcN.source, 'repo')
assert.ok(fs.existsSync(path.join(projN, '.project-memory', 'handoff.md')), 'PC N reads the shared memory')
assert.equal(ghCalls.length, ghBefore, 'gh never called on the no-gh route')
console.log('no gh: URL parsing, public/rate-limit/unreachable refusals, private repo connected and linked ok')

// ── one-click create without gh: token from (fake) Git Credential Manager, (fake) GitHub API ──
const rejected: string[] = []
const posts: unknown[] = []
const lazyTools = (cred: 'ok' | 'cancel', opts: { expired?: boolean; createPublic?: boolean } = {}): Tools => ({
  git: GIT,
  gh: null,
  run: async (cmd, args, o) => {
    if (cmd === GIT && args[0] === 'credential') {
      assert.equal(o?.input?.includes('host=github.com'), true, 'credential query names github.com')
      if (args[1] === 'reject') {
        rejected.push(o?.input || '')
        return { code: 0, stdout: '', stderr: '' }
      }
      return cred === 'ok' ? { code: 0, stdout: 'protocol=https\nhost=github.com\nusername=tester\npassword=TOKEN-1\n', stderr: '' } : { code: 1, stdout: '', stderr: 'user cancelled' }
    }
    return run(cmd, args, o)
  },
  githubApi: async (method, apiPath, token, body) => {
    assert.equal(token, 'TOKEN-1', 'API called with the token from git credential fill')
    if (opts.expired) return { status: 401, json: { message: 'Bad credentials' } }
    if (method === 'GET' && apiPath === '/user') return { status: 200, json: { login: 'tester' } }
    if (method === 'GET' && apiPath.startsWith('/repos/')) {
      const full = apiPath.slice('/repos/'.length)
      return repos.has(full) ? { status: 200, json: { private: repos.get(full) } } : { status: 404, json: { message: 'Not Found' } }
    }
    if (method === 'POST' && apiPath === '/user/repos') {
      posts.push(body)
      const name = (body as { name: string }).name
      const bare = path.join(remotes, 'tester', name) + '.git'
      fs.mkdirSync(path.dirname(bare), { recursive: true })
      await exec(GIT, ['init', '-q', '--bare', bare])
      repos.set(`tester/${name}`, opts.createPublic ? false : (body as { private: boolean }).private)
      return { status: 201, json: { full_name: `tester/${name}` } }
    }
    return { status: 500, json: null }
  }
})
const memL = path.join(tmp, 'pcL', 'mem')
await assert.rejects(createRepoViaGitLogin(lazyTools('ok'), { name: '../x', clonePath: memL }), (e: MemSyncError) => e.code === 'bad-repo-name')
await assert.rejects(createRepoViaGitLogin(lazyTools('cancel'), { name: 'lazy-mem', clonePath: memL }), (e: MemSyncError) => e.code === 'git-login-failed')
await assert.rejects(createRepoViaGitLogin(lazyTools('ok', { expired: true }), { name: 'lazy-mem', clonePath: memL }), (e: MemSyncError) => e.code === 'git-login-failed')
assert.equal(rejected.length, 1, 'expired login handed back to git credential reject')
assert.match(rejected[0], /password=TOKEN-1/)
await assert.rejects(createRepoViaGitLogin(lazyTools('ok'), { name: 'public-mem', clonePath: memL }), (e: MemSyncError) => e.code === 'repo-public')
await assert.rejects(createRepoViaGitLogin(lazyTools('ok', { createPublic: true }), { name: 'oops-mem', clonePath: memL }), (e: MemSyncError) => e.code === 'repo-public', 'created repo re-checked')
assert.ok(!fs.existsSync(memL), 'nothing cloned on refusal')
const lz = await createRepoViaGitLogin(lazyTools('ok'), { name: 'lazy-mem', clonePath: memL })
assert.deepEqual([lz.repo, lz.created, lz.cloned], ['tester/lazy-mem', true, true])
assert.deepEqual(posts.at(-1), { name: 'lazy-mem', private: true, description: 'Agent Workbench project memory (private)' })
assert.match(await g(memL, 'log', '--oneline', 'origin/main'), /memory: initialize/, 'first commit pushed to the new repo')
const lz2 = await createRepoViaGitLogin(lazyTools('ok'), { name: 'ai-project-memory', clonePath: path.join(tmp, 'pcL', 'mem2') })
assert.deepEqual([lz2.repo, lz2.created], ['tester/ai-project-memory', false], 'existing private repo reused')
assert.equal(ghCalls.length, ghBefore, 'gh never called on the one-click route')
console.log('one-click create: login cancel/expired, public refusals, created private + initialized, existing reused ok')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('memsync ok')
