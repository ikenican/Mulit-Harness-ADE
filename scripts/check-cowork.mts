// 自我檢查：node --experimental-strip-types scripts/check-cowork.mts
// Cowork P1：純邏輯、runner、原子寫入、git 快照，以及用假 CLI 在暫存 repo 上跑完整的會議流程。
// 對應 cowork.md §10 的測試重點：假 JSON、無效 DAG／越界路徑、單一覆核者的反對不能被繞過、
// 失敗／預算／取消時不能假裝完成、舊版本不能核准、重啟後暫停。
import './ts-resolve.mjs'
import assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const shared = await import('../src/shared/cowork.ts')
const { runProcess, launchPlan } = await import('../src/main/cowork/runner.ts')
const { writeJsonAtomic, readJsonWithFallback, prevPath } = await import('../src/main/cowork/store.ts')
const gitm = await import('../src/main/cowork/git.ts')
const { CoworkService, CoworkError } = await import('../src/main/cowork/orchestrator.ts')

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-check-')))
const cleanup: string[] = [tmp]

// ── 純邏輯 ─────────────────────────────────────────────────────────

{
  const n = shared.normalizeScopePath
  assert.deepEqual(n('src\\main\\a.ts'), { ok: true, path: 'src/main/a.ts' })
  assert.deepEqual(n('./src//b.ts'), { ok: true, path: 'src/b.ts' })
  assert.deepEqual(n('src/dir/'), { ok: true, path: 'src/dir/' })
  for (const bad of ['', '/etc/passwd', 'C:/x', '..\\x', 'a/../../b', '.git/config', '.GIT/hooks', 'src/*.ts', 'a:stream']) {
    assert.equal(n(bad).ok, false, `should reject ${JSON.stringify(bad)}`)
  }

  const ctx = { assignable: ['claude', 'codex'] as const, maxTasks: 3 }
  const t = (o: Record<string, unknown>) => ({ id: 't1', title: 'x', detail: 'd', scope: ['a.ts'], dependsOn: [], assignee: 'claude', acceptance: [], resources: [], ...o })
  const ok = shared.checkTasks([t({}), t({ id: 't2', dependsOn: ['t1'], scope: ['b\\c.ts'] })], { ...ctx, assignable: [...ctx.assignable] })
  assert.ok(ok.ok)
  if (ok.ok) assert.deepEqual(ok.value[1].scope, ['b/c.ts'])
  const errs = (raw: unknown) => {
    const r = shared.checkTasks(raw, { ...ctx, assignable: [...ctx.assignable] })
    return r.ok ? [] : r.errors.join('\n')
  }
  assert.match(String(errs([t({ assignee: 'antigravity' })])), /assignee/)
  assert.match(String(errs([t({}), t({})])), /duplicate task id/)
  assert.match(String(errs([t({ dependsOn: ['t9'] })])), /unknown task/)
  assert.match(String(errs([t({ dependsOn: ['t2'] }), t({ id: 't2', dependsOn: ['t1'] })])), /cycle/)
  assert.match(String(errs([t({ scope: ['../x'] })])), /not allowed/)
  assert.match(String(errs([t({}), t({ id: 't2' }), t({ id: 't3' }), t({ id: 't4' })])), /too many tasks/)
  assert.match(String(errs([])), /must not be empty/)

  const res = shared.checkResolution(
    { tasks: [t({})], decisions: [{ issueId: 'codex.o1', verdict: 'accept', reason: 'ok' }], unresolved: [] },
    { assignable: ['claude'], maxTasks: 5, requiredIssues: ['codex.o1', 'claude.q1'] }
  )
  assert.ok(!res.ok && res.errors.some((e) => e.includes('claude.q1')), 'every issue must be handled')
  const res2 = shared.checkResolution(
    { tasks: [t({})], decisions: [{ issueId: 'codex.o1', verdict: 'accept', reason: 'ok' }], unresolved: [{ issueId: 'claude.q1', text: '?' }] },
    { assignable: ['claude'], maxTasks: 5, requiredIssues: ['codex.o1', 'claude.q1'] }
  )
  assert.ok(res2.ok, 'unresolved counts as handled')

  const r1 = shared.checkR1(
    { summary: 's', framing: 'f', tasks: [t({})], questions: [{ id: 'zz', text: 'q?' }, { id: 'zz', text: 'q2?' }], risks: [] },
    { assignable: ['claude'], maxTasks: 5 }
  )
  assert.ok(r1.ok)
  if (r1.ok) assert.deepEqual(r1.value.questions.map((q) => q.id), ['q1', 'q2'], 'question ids are renumbered')
  const r2 = shared.checkR2({ agree: [], objections: [{ id: 'o1', target: '', reason: 'r', alternative: 'a' }, { id: 'o1', target: 't1', reason: 'r2', alternative: '' }], missing: [], claims: [], answers: [] })
  assert.ok(r2.ok)
  if (r2.ok) assert.deepEqual(r2.value.objections.map((o) => [o.id, o.target]), [['o1', 'framing'], ['o2', 't1']])
  assert.equal(shared.checkR2('not json').ok, false)

  // claude 外層格式
  const env = (o: Record<string, unknown>) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { a: 1 }, total_cost_usd: 0.5, usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 }, ...o })
  const pc = shared.parseClaudeOutput(env({}))
  assert.ok(pc.ok)
  if (pc.ok) assert.deepEqual(pc.value, { a: 1 })
  assert.equal(pc.usage?.costUsd, 0.5)
  assert.equal(shared.parseClaudeOutput(env({ is_error: true, result: 'auth failed' })).ok, false)
  assert.equal(shared.parseClaudeOutput(env({ structured_output: undefined })).ok, false)
  assert.equal(shared.parseClaudeOutput('nope').ok, false)

  // codex 事件 + -o 檔
  const ev = (...e: unknown[]) => e.map((x) => JSON.stringify(x)).join('\n')
  const usageEv = { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7 } }
  const okCmd = { type: 'item.completed', item: { type: 'command_execution', status: 'completed', exit_code: 0, aggregated_output: '' } }
  const denied = { type: 'item.completed', item: { type: 'command_execution', status: 'failed', exit_code: 1, aggregated_output: "Access to the path 'C:\\x' is denied." } }
  const px = shared.parseCodexOutput(ev(okCmd, usageEv), '{"b":2}')
  assert.ok(px.ok)
  if (px.ok) assert.deepEqual(px.value, { b: 2 })
  assert.deepEqual(px.usage, { inputTokens: 40, cachedInputTokens: 60, outputTokens: 7 })
  assert.equal(shared.parseCodexOutput(ev(denied, usageEv), '{"b":2}').ok, false, 'sandbox could not read anything')
  assert.ok(shared.parseCodexOutput(ev(denied, okCmd, usageEv), '{"b":2}').ok, 'one denial among successes is fine')
  assert.equal(shared.parseCodexOutput(ev({ type: 'turn.failed', error: { message: 'boom' } }), '{"b":2}').ok, false)
  assert.equal(shared.parseCodexOutput(ev(usageEv), null).ok, false)
  assert.equal(shared.parseCodexOutput(ev(usageEv), 'not json').ok, false)

  // 規劃用參數：唯讀設定不能被改掉
  const inv = shared.plannerInvocation('claude', { cwd: '.', schema: {}, schemaFile: 's', outFile: 'o' })
  assert.ok(inv.args.join(' ').includes('--tools Read,Grep,Glob') && inv.args.includes('--restricted') && inv.args.includes('--strict-mcp-config'))
  assert.ok(!inv.args.some((a) => /bypass|dangerously/i.test(a)))
  const cx = shared.plannerInvocation('codex', { cwd: 'C:/snap', schema: {}, schemaFile: 's.json', outFile: 'o.txt', windowsSandbox: 'elevated' })
  assert.ok(cx.args.includes('read-only') && cx.args.includes('--ignore-user-config') && cx.args.includes('windows.sandbox="elevated"'))
  assert.equal(cx.args[cx.args.length - 1], '-', 'prompt goes through stdin')
  // antigravity：prompt 走 stream-json stdin（-p 一定要接值，所以是 -p=）、即時工具白名單、較長逾時
  const ag = shared.plannerInvocation('antigravity', { cwd: '.', schema: {}, schemaFile: 's.json', outFile: 'o' })
  assert.ok(ag.args.includes('stream-json') && ag.args.includes('--sandbox') && ag.args.includes('s.json'))
  assert.equal(ag.args[ag.args.length - 1], '-p=')
  assert.ok(!ag.args.some((a) => /dangerously|skip-permissions/i.test(a)))
  assert.deepEqual(JSON.parse(ag.stdin!('中文 "q"\nline')), { event: 'user', message: { role: 'user', content: '中文 "q"\nline' } })
  assert.ok((ag.minTimeoutSec || 0) >= 600)
  const step = (tool: string, state = 'ACTIVE') => JSON.stringify({ event: 'step_update', step_update: { state, step_type: 'tool', tool_name: tool } })
  assert.equal(ag.guard!(step('view_file')), null)
  assert.equal(ag.guard!(step('grep_search')), null)
  assert.equal(ag.guard!(step('run_command')), null, 'run_command is refused by the deny rule, not killed')
  for (const bad of ['schedule', 'invoke_subagent', 'open_browser_url', 'write_to_file', 'search_web', 'send_message']) {
    assert.match(String(ag.guard!(step(bad))), new RegExp(bad), `${bad} must be stopped`)
  }
  assert.equal(ag.guard!(step('schedule', 'DONE')), null, 'only the ACTIVE event triggers')
  assert.equal(ag.guard!('not json "tool_name"'), null)
  const deny = (shared.agyIsolationSettings('C:\\iso\\home') as any).permissions
  for (const d of ['command(*)', 'write_file(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)']) assert.ok(deny.deny.includes(d), d)
  assert.deepEqual(deny.allow, ['read_file(C:/iso/home/.gemini/antigravity-cli/builtin/**)'])
  const agEv = (r: Record<string, unknown>) =>
    [JSON.stringify({ event: 'init' }), JSON.stringify({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 5 }, ...r } })].join('\n')
  const pa = shared.parseAgyOutput(agEv({ structured_output: { c: 3 } }))
  assert.ok(pa.ok)
  if (pa.ok) assert.deepEqual(pa.value, { c: 3 })
  assert.deepEqual(pa.usage, { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 })
  const noOut = shared.parseAgyOutput(agEv({ denied_actions: [{ action: 'read_file' }] }))
  assert.ok(!noOut.ok && /read_file/.test(noOut.error))
  assert.equal(shared.parseAgyOutput(agEv({ status: 'ERROR', error: 'boom' })).ok, false)
  assert.equal(shared.parseAgyOutput('garbage').ok, false)
  // 工具說明插在步驟標記之後，假 CLI 與真 CLI 都還認得步驟
  const tn = shared.withToolNote('Cowork step: R1 (chair opening)\nrest', 'antigravity')
  assert.ok(tn.startsWith('Cowork step: R1') && tn.includes('list_dir') && tn.endsWith('\nrest'))

  // schema 相容 codex strict：每個 object 都 additionalProperties:false 且 required 列全
  const walk = (s: any): void => {
    if (s && typeof s === 'object') {
      if (s.type === 'object') {
        assert.equal(s.additionalProperties, false)
        assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort())
      }
      Object.values(s).forEach(walk)
    }
  }
  for (const st of ['r1', 'r2', 'r34', 'revise'] as const) walk(shared.schemaFor(st, ['claude', 'codex']))

  assert.equal(shared.sanitizeCoworkSettings({ chair: 'nope', participants: ['codex', 'codex', 'x'], limits: { maxPlanningCalls: 9999 } }).limits.maxPlanningCalls, 30)
  assert.deepEqual(shared.sanitizeCoworkSettings({ participants: ['codex', 'codex', 'x'] }).participants, ['codex'])
  console.log('cowork pure ok')
}

// ── runner ─────────────────────────────────────────────────────────

{
  const echo = path.join(tmp, 'echo.mjs')
  fs.writeFileSync(echo, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('['+s+']')})`)
  const r = await runProcess({ command: process.execPath, args: [echo], cwd: tmp, stdin: '中文 "quotes" %PATH%\nline2', timeoutMs: 10000, maxBytes: 1e6 })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '[中文 "quotes" %PATH%\nline2]', 'stdin passes through untouched')

  const sleeper = path.join(tmp, 'sleep.mjs')
  fs.writeFileSync(sleeper, `setTimeout(()=>{},60000)`)
  const t0 = Date.now()
  const to = await runProcess({ command: process.execPath, args: [sleeper], cwd: tmp, stdin: '', timeoutMs: 300, maxBytes: 1e6 })
  assert.ok(to.timedOut && Date.now() - t0 < 8000, 'timeout kills the process')

  const ac = new AbortController()
  setTimeout(() => ac.abort(), 200)
  const ca = await runProcess({ command: process.execPath, args: [sleeper], cwd: tmp, stdin: '', timeoutMs: 30000, maxBytes: 1e6 }, ac.signal)
  assert.ok(ca.cancelled, 'abort kills the process')

  const flood = path.join(tmp, 'flood.mjs')
  fs.writeFileSync(flood, `const b='x'.repeat(65536);const f=()=>{process.stdout.write(b,f)};f()`)
  const tr = await runProcess({ command: process.execPath, args: [flood], cwd: tmp, stdin: '', timeoutMs: 10000, maxBytes: 200000 })
  assert.ok(tr.truncated && tr.stdout.length <= 200000, 'output is capped')

  const missing = await runProcess({ command: path.join(tmp, 'no-such.exe'), args: [], cwd: tmp, stdin: '', timeoutMs: 1000, maxBytes: 1000 })
  assert.ok(missing.spawnError, 'missing executable is reported')

  if (process.platform === 'win32') {
    assert.ok('error' in launchPlan('C:/x/codex.cmd', ['--x', '100%']), 'cmd.exe never sees % or quotes')
    assert.ok('error' in launchPlan('C:/x/codex.cmd', ['say "hi"']))
    const plan = launchPlan('C:/Program Files/x/codex.cmd', ['-C', 'C:/Users/Kyle Zhang/snap'])
    assert.ok(!('error' in plan) && plan.verbatim && plan.args[3] === '""C:/Program Files/x/codex.cmd" "-C" "C:/Users/Kyle Zhang/snap""')
  }
  console.log('cowork runner ok')
}

// ── 原子寫入 ───────────────────────────────────────────────────────

{
  const f = path.join(tmp, 'store', 'run.json')
  const isV = (v: unknown): v is { v: number } => !!v && typeof (v as any).v === 'number'
  writeJsonAtomic(f, { v: 1 })
  writeJsonAtomic(f, { v: 2 })
  assert.deepEqual(readJsonWithFallback(f, isV), { value: { v: 2 }, fromBackup: false })
  assert.deepEqual(JSON.parse(fs.readFileSync(prevPath(f), 'utf8')), { v: 1 })
  fs.writeFileSync(f, '{"v": 3, half-writ')
  assert.deepEqual(readJsonWithFallback(f, isV), { value: { v: 1 }, fromBackup: true }, 'corrupt main falls back to previous')
  assert.equal(fs.readdirSync(path.dirname(f)).filter((x) => x.endsWith('.tmp')).length, 0, 'no temp files left')
  console.log('cowork store ok')
}

// ── git：基線、快照、副作用、刪除守衛、symlink 逃逸 ──────────────────

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })

function makeRepo(name: string): string {
  const repo = path.join(tmp, name)
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  g(repo, 'init', '-q')
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(repo, '.gitignore'), 'out/\n')
  g(repo, 'add', '-A')
  g(repo, 'commit', '-qm', 'init')
  return repo
}

{
  const repo = makeRepo('repo-git')
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x')
  const base = await gitm.readBaseline(path.join(repo, 'src'))
  assert.equal(path.resolve(base.root), path.resolve(repo))
  assert.deepEqual(base.dirty, ['dirty.txt'])
  assert.match(base.head, /^[0-9a-f]{40}$/)

  const snap = gitm.snapshotDirFor(base.commonDir, 'rtest')
  await gitm.createSnapshot(base.root, snap, base.head)
  assert.ok(fs.existsSync(path.join(snap, 'src', 'a.ts')))
  assert.ok(!fs.existsSync(path.join(snap, 'dirty.txt')), 'uncommitted files are not in the snapshot')
  assert.deepEqual(await gitm.snapshotChanges(snap, base.head), [])
  fs.mkdirSync(path.join(snap, 'out'))
  fs.writeFileSync(path.join(snap, 'out', 'gen.js'), 'x')
  assert.ok((await gitm.snapshotChanges(snap, base.head)).some((l) => l.includes('out/')), 'ignored writes count as side effects')

  if (process.platform === 'win32') {
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(snap, 'link'), 'junction')
    assert.ok(gitm.scopeEscapes(snap, 'link/new.ts'), 'junction escaping the tree is caught')
  }
  assert.equal(gitm.scopeEscapes(snap, 'src/new/deep/file.ts'), null)

  assert.throws(() => gitm.removeSnapshot(repo, path.join(base.commonDir, 'cowork')), /refusing/)
  gitm.removeSnapshot(snap, path.join(base.commonDir, 'cowork'))
  assert.ok(!fs.existsSync(path.join(base.commonDir, 'cowork')), 'empty cowork dir is removed too')
  assert.ok(fs.existsSync(path.join(repo, 'src', 'a.ts')), 'repo untouched')

  await assert.rejects(gitm.readBaseline(tmp), /not-a-git-repo/)
  console.log('cowork git ok')
}

// ── orchestrator：假 CLI 跑完整會議 ──────────────────────────────────

const fake = path.join(here, 'fixtures', 'cowork-fake-cli.mjs')
const repo = makeRepo('repo-e2e')
const dataDir = path.join(tmp, 'data')
const emitted: string[] = []
const agyHome = path.join(tmp, 'agy-home')
const ineligible = new Set<string>()
const deps = {
  dataDir,
  resolveCli: (agent: string) =>
    ineligible.has(agent)
      ? { error: 'not available' }
      : agent === 'antigravity'
        ? { command: process.execPath, prefixArgs: [fake], env: { USERPROFILE: agyHome, HOME: agyHome } }
        : { command: process.execPath, prefixArgs: [fake] },
  emit: (run: { id: string; phase: string }) => emitted.push(`${run.id}:${run.phase}`)
}
const behave = (cfg: Record<string, unknown>): void => {
  process.env.FAKE_COWORK = JSON.stringify(cfg)
}
const svc = new CoworkService(deps)
svc.init()

const base = {
  workspace: repo,
  prompt: 'Add a helper and use it',
  chair: 'claude' as const,
  participants: ['claude', 'codex'] as ('claude' | 'codex')[],
  chairExecutes: true,
  language: 'en' as const,
  limits: { maxPlanningCalls: 6, maxPlanningMinutes: 10, maxExecutionMinutes: 60 }
}

async function waitFor(id: string, cond: (r: any) => boolean, ms = 30000): Promise<any> {
  const t0 = Date.now()
  for (;;) {
    const r = svc.get(id)
    if (r && cond(r)) return r
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting; phase=${r?.phase} block=${JSON.stringify(r?.block)}`)
    await new Promise((res) => setTimeout(res, 50))
  }
}
const settled = (r: any) => r.phase !== 'meeting'
const code = async (p: Promise<unknown> | (() => unknown), c: string): Promise<void> => {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    assert.ok(e instanceof CoworkError, String(e))
    assert.equal((e as InstanceType<typeof CoworkError>).code, c)
    return
  }
  assert.fail(`expected CoworkError ${c}`)
}

// 1. 正常流程：主席 claude、覆核 codex，有反對與補充 → 全部處置 → 待核准 → 核准
{
  behave({ r2Objection: true })
  const run0 = await svc.start(base)
  assert.equal(run0.phase, 'meeting')
  await code(svc.start(base), 'active-run-exists')
  const r = await waitFor(run0.id, settled)
  assert.equal(r.phase, 'awaiting-approval', JSON.stringify(r.block))
  const board = shared.currentBoard(r)!
  assert.deepEqual(board.decisions.map((d: any) => d.issueId).sort(), ['claude.q1', 'codex.m1', 'codex.o1'])
  assert.deepEqual(board.tasks[1].scope, ['src/b.ts'], 'scope normalized')
  assert.equal(r.budget.planningCallsUsed, 3, 'N+1 calls for two agents')
  assert.ok(r.budget.costUsd > 0 && r.budget.tokens > 0)
  assert.equal(r.budget.activeSince, null)
  assert.ok(r.log.some((e: any) => e.t === 'round' && e.round === 3))
  assert.ok(fs.existsSync(r.snapshotDir))
  assert.equal(g(repo, 'status', '--porcelain'), '', 'the real repo was never touched')

  await code(() => svc.approve(r.id, r.planRevision + 1), 'stale-revision')
  svc.approve(r.id, r.planRevision)
  const a = svc.get(r.id)!
  assert.equal(a.phase, 'approved')
  assert.equal(a.approvedPlanRevision, 1)
  assert.ok(!fs.existsSync(a.snapshotDir), 'snapshot removed after approval')
  svc.logDispatch(r.id, 't1', 'Codex #1')
  const text = shared.taskDispatchText(a, shared.currentBoard(a)!.tasks[1])
  assert.ok(text.includes('src/b.ts') && text.includes('t1') && text.includes('b uses the helper'))
  assert.ok(fs.readdirSync(path.join(dataDir)).length === 1)
  // 磁碟上的 manifest 與記憶體一致
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, fs.readdirSync(dataDir)[0], r.id, 'run.json'), 'utf8'))
  assert.equal(onDisk.phase, 'approved')
  console.log('e2e happy path ok')
}

// 2. 單一覆核者的反對不能被繞過：主席沒處置 → 修正一次仍不處置 → blocked，不能核准
{
  behave({ r2Objection: true, r34OmitDecisions: true })
  const run0 = await svc.start(base)
  const r = await waitFor(run0.id, settled)
  assert.equal(r.phase, 'blocked')
  assert.equal(r.block.kind, 'step-failed')
  assert.match(r.block.message, /still invalid/)
  assert.equal(r.budget.planningCallsUsed, 4, 'R1 + R2 + R34 + one repair')
  assert.equal(r.boards.length, 0)
  await code(() => svc.approve(r.id, r.planRevision), 'not-allowed')
  // 改好之後重試：通過
  behave({ r2Objection: true })
  await svc.retry(r.id)
  const r2 = await waitFor(r.id, settled)
  assert.equal(r2.phase, 'awaiting-approval')
  await svc.cancel(r.id)
  console.log('e2e objection cannot be bypassed ok')
}

// 3. 輸出不合格 → 一次修正就過
{
  behave({ invalidOnce: true })
  const run0 = await svc.start(base)
  const r = await waitFor(run0.id, settled)
  assert.equal(r.phase, 'awaiting-approval', JSON.stringify(r.block))
  assert.ok(r.calls.some((c: any) => c.repair && c.step === 'r1' && c.status === 'ok'))
  await svc.cancel(r.id)
  console.log('e2e repair ok')
}

// 4. 覆核者失敗：不能當成同意；唯一的覆核者失敗時不能「少一位繼續」
{
  behave({ failAgent: 'codex' })
  const run0 = await svc.start(base)
  const r = await waitFor(run0.id, settled)
  assert.equal(r.phase, 'blocked')
  assert.equal(r.block.kind, 'reviewers-failed')
  assert.equal(r.reviewers.codex.status, 'failed')
  await code(svc.dropFailedReviewers(r.id), 'no-reviewer-left')
  behave({})
  await svc.retry(r.id)
  const r2 = await waitFor(r.id, settled)
  assert.equal(r2.phase, 'awaiting-approval')
  await svc.cancel(r.id)
  console.log('e2e reviewer failure ok')
}

// 5. 主席換成 codex、唯一的覆核者 claude 失敗：一樣不能「少一位繼續」把會議變成主席一人說了算
{
  behave({ failAgent: 'claude', failStep: 'R2' })
  const run0 = await svc.start({ ...base, chair: 'codex' })
  const r = await waitFor(run0.id, settled)
  assert.equal(r.block.kind, 'reviewers-failed')
  await code(svc.dropFailedReviewers(r.id), 'no-reviewer-left')
  await svc.cancel(r.id)
  console.log('e2e drop guard ok')
}

// 6. 副作用：CLI 在規劃時寫檔 → 這次規劃作廢、保留 diff；重試時重建乾淨快照
{
  behave({ writeFile: 'claude' })
  const run0 = await svc.start(base)
  const r = await waitFor(run0.id, settled)
  assert.equal(r.phase, 'blocked')
  assert.equal(r.block.kind, 'side-effects')
  assert.ok(r.block.details.some((l: string) => l.includes('pwned.txt')))
  assert.equal(r.r1, null, 'the tainted R1 is not used')
  behave({})
  await svc.retry(r.id)
  const r2 = await waitFor(r.id, settled)
  assert.equal(r2.phase, 'awaiting-approval', JSON.stringify(r2.block))
  assert.ok(!fs.existsSync(path.join(r2.snapshotDir, 'pwned.txt')))
  await svc.cancel(r.id)
  console.log('e2e side effects ok')
}

// 7. 預算：呼叫數用完就停在 blocked(budget)；使用者明確提高上限後重試
{
  behave({})
  const run0 = await svc.start({ ...base, limits: { ...base.limits, maxPlanningCalls: 2 } })
  const r = await waitFor(run0.id, settled)
  assert.equal(r.phase, 'blocked')
  assert.equal(r.block.kind, 'budget')
  assert.equal(r.budget.planningCallsUsed, 2)
  svc.raiseLimits(r.id, { maxPlanningCalls: 1 })
  assert.equal(svc.get(r.id)!.limits.maxPlanningCalls, 2, 'limits never shrink')
  svc.raiseLimits(r.id, { maxPlanningCalls: 3 })
  await svc.retry(r.id)
  const r2 = await waitFor(r.id, settled)
  assert.equal(r2.phase, 'awaiting-approval')
  await svc.cancel(r.id)
  console.log('e2e budget ok')
}

// 8. 取消：行程被終止、狀態 cancelled、快照收掉
{
  behave({ slowMs: 20000 })
  const run0 = await svc.start(base)
  await waitFor(run0.id, (r) => r.calls.some((c: any) => c.status === 'running'))
  const t0 = Date.now()
  await svc.cancel(run0.id)
  const r = svc.get(run0.id)!
  assert.equal(r.phase, 'cancelled')
  assert.ok(Date.now() - t0 < 10000, 'cancel does not wait for the slow call')
  await new Promise((res) => setTimeout(res, 300))
  assert.equal(r.calls[0].status, 'cancelled')
  assert.ok(!fs.existsSync(r.snapshotDir))
  assert.equal(r.phase, 'cancelled', 'a late result cannot revive a cancelled run')
  console.log('e2e cancel ok')
}

// 9. 改板：舊版本拒絕、無效 DAG 拒絕、成功則 revision 加一；核准綁定版本
{
  behave({})
  const run0 = await svc.start(base)
  const r = await waitFor(run0.id, settled)
  assert.equal(r.phase, 'awaiting-approval')
  const tasks = shared.currentBoard(r)!.tasks
  await code(() => svc.editBoard(r.id, 99, tasks), 'stale-revision')
  const bad = svc.editBoard(r.id, 1, [{ ...tasks[0], dependsOn: ['t2'] }, tasks[1]])
  assert.ok(!bad.ok && bad.errors.some((e) => /cycle/.test(e)))
  const evil = svc.editBoard(r.id, 1, [{ ...tasks[0], scope: ['../../etc'] }])
  assert.ok(!evil.ok)
  assert.equal(svc.get(r.id)!.planRevision, 1, 'rejected edits change nothing')
  const good = svc.editBoard(r.id, 1, [{ ...tasks[0], title: 'Renamed' }])
  assert.ok(good.ok)
  const r2 = svc.get(r.id)!
  assert.equal(r2.planRevision, 2)
  assert.equal(shared.currentBoard(r2)!.source, 'user')
  await code(() => svc.approve(r.id, 1), 'stale-revision')
  svc.approve(r.id, 2)
  // 核准後回饋：重開一版要重新核准（快照自動重建）
  behave({})
  await svc.feedback(r.id, 'please drop t2')
  const r3 = await waitFor(r.id, (x) => x.phase !== 'meeting')
  assert.equal(r3.phase, 'awaiting-approval')
  assert.equal(r3.planRevision, 3)
  assert.equal(r3.approvedPlanRevision, 2, 'the old approval stays on record')
  svc.approve(r.id, 3)
  console.log('e2e edit & revisions ok')
}

// 10. 待定項目：不能核准；回饋讓主席處置後才進入待核准；或使用者明確放下
{
  behave({ r2Objection: true, r34Unresolved: true })
  const run0 = await svc.start(base)
  const r = await waitFor(run0.id, settled)
  assert.equal(r.phase, 'blocked')
  assert.equal(r.block.kind, 'unresolved')
  await code(() => svc.approve(r.id, r.planRevision), 'not-allowed')
  await code(svc.retry(r.id), 'not-retryable')
  behave({})
  await svc.feedback(r.id, 'go with a.ts')
  const r2 = await waitFor(r.id, settled)
  assert.equal(r2.phase, 'awaiting-approval', JSON.stringify(r2.block))
  assert.equal(shared.currentBoard(r2)!.unresolved.length, 0)
  assert.ok(shared.currentBoard(r2)!.decisions.some((d: any) => d.reason === 'user said so'))
  await svc.cancel(r.id)

  behave({ r2Objection: true, r34Unresolved: true })
  const run1 = await svc.start(base)
  const s = await waitFor(run1.id, settled)
  assert.equal(s.block.kind, 'unresolved')
  svc.dismissUnresolved(s.id)
  const s2 = svc.get(s.id)!
  assert.equal(s2.phase, 'awaiting-approval')
  assert.equal(s2.planRevision, 2)
  await svc.cancel(s.id)
  console.log('e2e unresolved ok')
}

// 11. 重啟：會議進行中 app 結束 → 下次載入是 paused，可以續跑
{
  behave({ slowMs: 20000 })
  const run0 = await svc.start(base)
  await waitFor(run0.id, (r) => r.calls.some((c: any) => c.status === 'running'))
  svc.shutdown()
  await new Promise((res) => setTimeout(res, 800))
  const svc2 = new CoworkService(deps)
  svc2.init()
  const r = svc2.get(run0.id)!
  assert.equal(r.phase, 'paused')
  assert.equal(r.block?.kind, 'restart')
  assert.ok(r.calls.every((c) => c.status !== 'running'))
  behave({})
  await svc2.retry(r.id)
  const t0 = Date.now()
  while (svc2.get(r.id)!.phase === 'meeting' && Date.now() - t0 < 30000) await new Promise((res) => setTimeout(res, 50))
  assert.equal(svc2.get(r.id)!.phase, 'awaiting-approval')
  await svc2.cancel(r.id)
  console.log('e2e restart ok')
}

// 12. 輸入檢查與語言
{
  await code(svc.start({ ...base, prompt: '   ' } as any), 'empty-prompt')
  await code(svc.start({ ...base, participants: ['claude'] } as any), 'need-two-participants')
  await code(svc.start({ ...base, chair: 'codex', participants: ['claude', 'antigravity'] } as any), 'chair-not-participant')
  ineligible.add('codex')
  await code(svc.start(base), 'agent-not-eligible')
  ineligible.clear()
  await code(svc.start({ ...base, prompt: 'x', workspace: tmp } as any), 'not-a-git-repo')
}

// 13–15 用新的 service（11 把 svc 關了）
const svc3 = new CoworkService(deps)
svc3.init()
async function settle3(id: string): Promise<any> {
  const t0 = Date.now()
  while (svc3.get(id)!.phase === 'meeting' && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 50))
  return svc3.get(id)!
}
const three = { ...base, participants: ['claude', 'codex', 'antigravity'] as any }

// 13. 三位與會者：agy 以隔離家目錄執行、prompt 走 stream-json，反對意見照樣要處置
{
  behave({ r2Objection: true, expectHome: agyHome })
  const run0 = await svc3.start(three)
  const r = await settle3(run0.id)
  assert.equal(r.phase, 'awaiting-approval', JSON.stringify(r.block))
  assert.equal(r.reviewers.antigravity.status, 'ok')
  const ids = shared.currentBoard(r)!.decisions.map((d: any) => d.issueId)
  assert.ok(ids.includes('antigravity.o1') && ids.includes('codex.o1') && ids.includes('antigravity.m1'))
  assert.equal(r.budget.planningCallsUsed, 4, 'N+1 calls for three agents')
  const agCall = r.calls.find((c: any) => c.agent === 'antigravity')
  assert.ok(agCall.timeoutMs >= 600_000 && agCall.usage.inputTokens === 900)
  await svc3.cancel(r.id)
  console.log('e2e antigravity reviewer ok')
}

// 14. agy 用了白名單外的工具：立刻終止，不能等它跑完；可以明確選擇不等它
{
  behave({ r2Objection: true, agyBadTool: 'schedule' })
  const run0 = await svc3.start(three)
  const t0 = Date.now()
  const r = await settle3(run0.id)
  assert.ok(Date.now() - t0 < 20000, 'the bad tool is killed, not waited out')
  assert.equal(r.block.kind, 'reviewers-failed')
  assert.match(r.reviewers.antigravity.error, /schedule/)
  assert.equal(r.reviewers.codex.status, 'ok')
  behave({ r2Objection: true })
  await svc3.dropFailedReviewers(r.id)
  const r2 = await settle3(r.id)
  assert.equal(r2.phase, 'awaiting-approval')
  assert.equal(r2.planRevision, 2)
  assert.ok(!shared.currentBoard(r2)!.decisions.some((d: any) => d.issueId.startsWith('antigravity.')))
  await svc3.cancel(r.id)
  console.log('e2e antigravity tool guard ok')
}

// 15. agy 因權限中止而沒有輸出：當成失敗，訊息說明原因
{
  behave({ agyNoOutput: true })
  const run0 = await svc3.start(three)
  const r = await settle3(run0.id)
  assert.equal(r.block.kind, 'reviewers-failed')
  assert.match(r.reviewers.antigravity.error, /permission/)
  await svc3.cancel(r.id)
  console.log('e2e antigravity no output ok')
}

for (const d of cleanup) {
  try {
    fs.rmSync(d, { recursive: true, force: true })
  } catch {
    /* Windows 偶爾還有 handle 沒放 */
  }
}
assert.ok(emitted.length > 0)
console.log('cowork ok')
