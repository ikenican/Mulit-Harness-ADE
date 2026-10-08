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
  // 模型與強度：各家用自己的參數；不指定就不帶（agy 例外：強度預設 medium）
  const argsFor = (agent: 'claude' | 'codex' | 'antigravity', model?: string, effort?: string) =>
    shared.plannerInvocation(agent, { cwd: '.', schema: {}, schemaFile: 's.json', outFile: 'o', model, effort }).args.join(' ')
  assert.ok(argsFor('claude', 'opus', 'high').includes('--model opus --effort high'))
  assert.ok(!argsFor('claude').includes('--model') && !argsFor('claude').includes('--effort'))
  assert.ok(argsFor('codex', 'gpt-6.1-sol', 'xhigh').includes('-m gpt-6.1-sol -c model_reasoning_effort="xhigh"'))
  assert.ok(!argsFor('codex').includes(' -m ') && !argsFor('codex').includes('model_reasoning_effort'))
  // agy：ID 本身帶強度。模型＋強度 → 組成完整 ID；只有模型 → 不加 --effort；都沒有 → --effort medium（實測規則）
  assert.ok(argsFor('antigravity', 'gemini-3.8-flash', 'low').includes('--model gemini-3.8-flash-low') && !argsFor('antigravity', 'gemini-3.8-flash', 'low').includes('--effort'))
  assert.ok(argsFor('antigravity', 'claude-sonnet-4-6').includes('--model claude-sonnet-4-6') && !argsFor('antigravity', 'claude-sonnet-4-6').includes('--effort'))
  assert.ok(argsFor('antigravity').includes('--effort medium') && !argsFor('antigravity').includes('--model'))
  assert.ok(argsFor('antigravity', '', 'high').includes('--effort high'))
  const grouped = shared.groupAgyModels([
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
  ])
  assert.deepEqual(grouped, [
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['high', 'low'] },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', efforts: [] },
    { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', efforts: ['medium'] }
  ])
  // 不安全的值一律丟掉（會接進命令列，codex 的強度還會被當成 TOML）
  assert.ok(!argsFor('codex', 'x" ; rm -rf', 'high"').includes('rm') && !argsFor('codex', 'x', 'hi"gh').includes('hi"gh'))
  assert.deepEqual(shared.sanitizeModelChoice({ model: ' opus ', effort: 'HIGH' }), { model: 'opus', effort: '' })
  assert.deepEqual(shared.sanitizeCoworkSettings({ models: { claude: { model: 'opus', effort: 'high' }, codex: { model: '', effort: '' }, bogus: {} } }).models, {
    claude: { model: 'opus', effort: 'high' }
  })
  // claude 回報實際用的模型
  assert.equal(shared.parseClaudeOutput(env({ modelUsage: { 'claude-opus-5-5': {} } })).model, 'claude-opus-5-5')

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
        : agent === 'codex'
          ? // 模擬使用者 config.toml 的 model／model_reasoning_effort
            { command: process.execPath, prefixArgs: [fake], defaultModel: 'gpt-user', defaultEffort: 'low' }
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

// 16. 模型與強度：會議指定的值傳到 CLI；codex 沒指定時沿用使用者 config.toml；開會後改設定不影響這場
{
  const log = path.join(tmp, 'argv.log')
  behave({ logFile: log })
  const models = { claude: { model: 'opus', effort: 'high' }, codex: { model: '', effort: '' }, antigravity: { model: 'gemini-x', effort: '' } }
  const run0 = await svc3.start({ ...three, models } as any)
  assert.deepEqual(run0.models, { claude: { model: 'opus', effort: 'high' }, antigravity: { model: 'gemini-x', effort: '' } })
  const r = await settle3(run0.id)
  assert.equal(r.phase, 'awaiting-approval', JSON.stringify(r.block))
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const argsOf = (me: string) => calls.filter((c) => c.me === me).map((c) => c.argv.join(' '))
  assert.ok(argsOf('claude').every((a) => a.includes('--model opus --effort high')))
  assert.ok(argsOf('codex').every((a) => a.includes('-m gpt-user -c model_reasoning_effort="low"')), 'codex falls back to the user config')
  assert.ok(argsOf('antigravity').every((a) => a.includes('--model gemini-x') && !a.includes('--effort')), 'a chosen agy model carries its own effort')
  const byAgent = (a: string) => r.calls.find((c: any) => c.agent === a)
  assert.equal(byAgent('claude').model, 'opus')
  assert.equal(byAgent('codex').model, 'gpt-user')
  assert.equal(byAgent('codex').effort, 'low')
  assert.equal(byAgent('antigravity').model, 'gemini-x')
  assert.equal(byAgent('antigravity').effort, undefined)
  // 磁碟上的 run 也記住了這場的選擇；舊 run 沒有 models 欄位也能讀
  const file = path.join(dataDir, fs.readdirSync(dataDir).find((d) => fs.existsSync(path.join(dataDir, d, r.id)))!, r.id, 'run.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).models, run0.models)
  await svc3.cancel(r.id)
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete legacy.models
  fs.writeFileSync(file, JSON.stringify(legacy))
  const svc4 = new CoworkService(deps)
  svc4.init()
  assert.deepEqual(svc4.get(r.id)!.models, {})
  console.log('e2e models ok')
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

// ── 背景執行（§12.5）：worktree、依序／同時、追問接續、失敗重試、停止、重啟、合併、清理 ──
{
  const erepo = makeRepo('repo-exec')
  fs.writeFileSync(path.join(erepo, 'CLAUDE.md'), 'PROJECT RULE: keep it small\n')
  g(erepo, 'add', '-A')
  g(erepo, 'commit', '-qm', 'instructions')
  const log = path.join(tmp, 'exec-argv.log')
  const execDeps = {
    ...deps,
    // 執行用使用者平常的 CLI：agy 不帶隔離家目錄
    resolveExecCli: (agent: string) => (ineligible.has(agent) ? { error: 'not available' } : { command: process.execPath, prefixArgs: [fake] })
  }
  const svc5 = new CoworkService(execDeps)
  svc5.init()
  const wait5 = async (id: string, cond: (r: any) => boolean, ms = 30000): Promise<any> => {
    const t0 = Date.now()
    for (;;) {
      const r = svc5.get(id)!
      if (cond(r)) return r
      if (Date.now() - t0 > ms) throw new Error(`timeout; phase=${r.phase} tasks=${JSON.stringify(r.execution?.tasks)}`)
      await new Promise((res) => setTimeout(res, 50))
    }
  }
  const meeting = async (extra: Record<string, unknown> = {}): Promise<any> => {
    const run0 = await svc5.start({ ...three, workspace: erepo, ...extra } as any)
    const r = await wait5(run0.id, (x) => x.phase !== 'meeting')
    assert.equal(r.phase, 'awaiting-approval', JSON.stringify(r.block))
    svc5.approve(r.id, r.planRevision)
    return r
  }
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

  // 規劃參考資料：基線的 CLAUDE.md 與勾選的 skill 進了 prompt
  behave({ logFile: log })
  const skills = [{ key: 'my-skill', name: 'My Skill', content: 'SKILL BODY' }]
  const r = await meeting({ skills })
  assert.deepEqual(r.context.instructions, [{ file: 'CLAUDE.md', content: 'PROJECT RULE: keep it small\n' }])
  assert.equal(r.context.skills[0].name, 'My Skill')
  const r1call = calls().find((c) => c.step === 'R1')
  assert.ok(r1call.head.includes('PROJECT RULE') && r1call.head.includes('--- skill: My Skill ---') && r1call.head.includes('SKILL BODY'))

  // 依序：一個 worktree，t1（claude）→ t2（agy）；各一個 commit；主工作區保持乾淨
  fs.writeFileSync(log, '')
  await svc5.execStart(r.id, { mode: 'sequential', linkDeps: true, bypass: true })
  await code(() => svc5.cancel(r.id), 'not-allowed')
  let x = await wait5(r.id, (y) => y.phase === 'review')
  const wt = x.execution.worktrees.main
  assert.equal(path.resolve(wt.path), path.resolve(erepo, '.cowork', r.id, 'main'))
  assert.equal(wt.branch, `cowork/${r.id}/main`)
  assert.ok(fs.existsSync(path.join(wt.path, 't1.txt')) && fs.existsSync(path.join(wt.path, 't2.txt')))
  assert.equal(x.execution.tasks.t1.status, 'done')
  assert.equal(x.execution.tasks.t1.commits.length, 1)
  assert.equal(x.execution.tasks.t1.sessionId, 'sess-claude-t1')
  assert.equal(x.execution.tasks.t2.agent, 'antigravity')
  assert.equal(x.execution.integration.status, 'ok')
  assert.match(x.execution.integration.stat, /t1\.txt/)
  assert.equal(g(erepo, 'status', '--porcelain').trim(), '', '.cowork/ is excluded from the main worktree status')
  assert.match(g(erepo, 'log', '--format=%s', wt.branch), /t2 Use the helper[\s\S]*t1 Add the helper/)
  const ex1 = calls()
  assert.ok(ex1.find((c) => c.me === 'claude').argv.join(' ').includes('--permission-mode bypassPermissions'))
  const agyExec = ex1.find((c) => c.me === 'antigravity')
  assert.ok(agyExec.argv.includes('--dangerously-skip-permissions'))
  assert.ok(agyExec.head.includes('Prerequisite tasks') && agyExec.head.includes('Done t1.'), 'dependent task sees the prerequisite reply')
  const agentTurn = x.execution.tasks.t2.turns.find((t: any) => t.role === 'agent')
  assert.equal(agentTurn.text, 'Done t2.')
  assert.ok(agentTurn.progress[0].startsWith('write_to_file t2.txt'), agentTurn.progress[0])

  // 追問：接續同一個 agy conversation，改動另成一個 commit，整合重算
  fs.writeFileSync(log, '')
  await code(svc5.execMessage(r.id, 't2', '   '), 'empty-feedback')
  await svc5.execMessage(r.id, 't2', 'also add a note')
  x = await wait5(r.id, (y) => y.phase === 'review' && y.execution.tasks.t2.commits.length === 2)
  const resumed = calls().find((c) => c.me === 'antigravity')
  assert.equal(resumed.argv[resumed.argv.indexOf('--conversation') + 1], 'sess-antigravity-t2')
  assert.ok(fs.existsSync(path.join(wt.path, 'followup.txt')))
  assert.equal(x.execution.integration.commit, g(wt.path, 'rev-parse', 'HEAD').trim())

  // 有 worktree 不能刪紀錄；合併回來源分支；清理後 worktree 不在、分支還在
  await code(() => svc5.delete(r.id), 'has-worktrees')
  // 已追蹤的檔案有改動就不合併；未追蹤的（例如 app 的 .workbench/）不擋
  fs.writeFileSync(path.join(erepo, 'CLAUDE.md'), 'changed\n')
  await code(svc5.execMerge(r.id), 'merge-dirty')
  g(erepo, 'checkout', '--', 'CLAUDE.md')
  fs.mkdirSync(path.join(erepo, '.workbench'))
  fs.writeFileSync(path.join(erepo, '.workbench', 'state.json'), '{}')
  await svc5.execMerge(r.id)
  x = svc5.get(r.id)!
  assert.equal(x.phase, 'completed')
  assert.ok(fs.existsSync(path.join(erepo, 't1.txt')) && fs.existsSync(path.join(erepo, 'followup.txt')))
  await svc5.execCleanup(r.id)
  assert.ok(!fs.existsSync(path.join(erepo, '.cowork')))
  assert.ok(g(erepo, 'branch', '--list', `cowork/${r.id}/main`).trim(), 'branch kept after cleanup')
  svc5.delete(r.id)
  console.log('e2e exec sequential ok')

  // 同時：每家一個 worktree；t1 失敗 → t2 等著；重試後 t2 先套用 t1 的 commit；最後整合成一條分支
  behave({ execFail: 't1' })
  const p = await meeting()
  await svc5.execStart(p.id, { mode: 'parallel', linkDeps: false, bypass: false })
  x = await wait5(p.id, (y) => y.execution.tasks.t1.status === 'failed')
  assert.equal(x.execution.tasks.t2.status, 'pending')
  assert.equal(x.phase, 'executing')
  assert.deepEqual(Object.keys(x.execution.worktrees).sort(), ['antigravity', 'claude'])
  await code(svc5.execMessage(p.id, 't2', 'hi'), 'busy')
  behave({ logFile: log })
  fs.writeFileSync(log, '')
  await svc5.execRetry(p.id, 't1')
  x = await wait5(p.id, (y) => y.phase === 'review')
  assert.ok(fs.existsSync(path.join(x.execution.worktrees.antigravity.path, 't1.txt')), 't1 commit applied before t2')
  assert.equal(x.execution.integration.status, 'ok')
  assert.equal(x.execution.integration.branch, `cowork/${p.id}/integration`)
  const intDir = x.execution.worktrees.integration.path
  assert.ok(fs.existsSync(path.join(intDir, 't1.txt')) && fs.existsSync(path.join(intDir, 't2.txt')))
  // 沒開 Bypass：claude 只自動接受改檔
  assert.ok(calls().find((c) => c.me === 'claude').argv.join(' ').includes('--permission-mode acceptEdits'))
  await svc5.execCleanup(p.id)
  assert.equal(svc5.get(p.id)!.phase, 'completed')
  console.log('e2e exec parallel ok')

  // 停止與重啟：跑到一半停止 → 任務標成被中斷；app 重啟時還在跑的任務也一樣，等使用者繼續
  behave({ execSlowMs: 4000 })
  const s = await meeting()
  await svc5.execStart(s.id, { mode: 'sequential', linkDeps: false, bypass: true })
  await wait5(s.id, (y) => y.execution.tasks.t1.status === 'running')
  await svc5.execPause(s.id)
  x = await wait5(s.id, (y) => y.execution.tasks.t1.status === 'cancelled')
  assert.equal(x.execution.paused, true)
  const runFile = path.join(dataDir, fs.readdirSync(dataDir).find((d) => fs.existsSync(path.join(dataDir, d, s.id)))!, s.id, 'run.json')
  const onDisk = JSON.parse(fs.readFileSync(runFile, 'utf8'))
  onDisk.execution.tasks.t1.status = 'running'
  onDisk.execution.paused = false
  fs.writeFileSync(runFile, JSON.stringify(onDisk))
  const svc6 = new CoworkService(execDeps)
  svc6.init()
  const rec = svc6.get(s.id)!
  assert.equal(rec.execution!.tasks.t1.status, 'cancelled')
  assert.equal(rec.execution!.pausedReason, 'restart')
  behave({})
  await svc5.execResume(s.id)
  x = await wait5(s.id, (y) => y.phase === 'review')
  assert.equal(x.execution.tasks.t2.status, 'done')
  await svc5.execCleanup(s.id)
  console.log('e2e exec pause/restart ok')
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
