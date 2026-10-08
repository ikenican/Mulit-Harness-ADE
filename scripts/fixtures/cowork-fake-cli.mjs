// 假的 claude / codex：給 scripts/check-cowork.mts 用，輸出格式照 2026-10-07 實測的真 CLI。
// 參數有 exec 就扮 codex（事件 JSONL + -o 檔），否則扮 claude（單一 result 物件）。
// 行為由環境變數 FAKE_COWORK（JSON）控制，見下方 cfg 的欄位。
import { writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const isCodex = argv.includes('exec')
// agy：stream-json 輸入輸出（2026-10-08 實測格式）
const isAgy = argv.includes('--input-format')
const me = isCodex ? 'codex' : isAgy ? 'antigravity' : 'claude'
const cfg = JSON.parse(process.env.FAKE_COWORK || '{}')

const chunks = []
for await (const c of process.stdin) chunks.push(c)
let prompt = Buffer.concat(chunks).toString('utf8')
if (isAgy) {
  // 第一行是 {"event":"user","message":{"role":"user","content":"..."}}
  const msg = JSON.parse(prompt.split('\n')[0])
  if (msg.event !== 'user' || typeof msg.message?.content !== 'string') {
    process.stderr.write('bad stream input\n')
    process.exit(4)
  }
  prompt = msg.message.content
  if (cfg.expectHome && process.env.USERPROFILE !== cfg.expectHome) {
    process.stderr.write(`USERPROFILE not isolated: ${process.env.USERPROFILE}\n`)
    process.exit(3)
  }
}

const step = (prompt.match(/^Cowork step: (\S+)/m) || [])[1]
// 記下每次呼叫：誰、哪一步、收到的參數（測模型與強度有沒有傳對）
if (cfg.logFile) appendFileSync(cfg.logFile, JSON.stringify({ me, step, argv, head: prompt.slice(0, 4000) }) + '\n')

// ── 背景執行（沒有 schema 參數）：改 cwd 裡的檔，照各家 stream 格式回報；接續時沿用 session id ──
if (!step) {
  const resumeId = isCodex
    ? argv.includes('resume') ? argv[argv.length - 2] : null
    : argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : argv.includes('--conversation') ? argv[argv.indexOf('--conversation') + 1] : null
  const task = (prompt.match(/^Cowork execution: task (\S+)/m) || [])[1]
  const sid = resumeId || `sess-${me}-${task || 'x'}`
  if (cfg.execSlowMs) await new Promise((r) => setTimeout(r, cfg.execSlowMs))
  const failed = task && cfg.execFail === task
  if (!failed) {
    if (task) {
      writeFileSync(join(process.cwd(), `${task}.txt`), `${me} did ${task}\n`)
      if (cfg.execConflict) writeFileSync(join(process.cwd(), 'shared.txt'), `${task}\n`)
    } else {
      appendFileSync(join(process.cwd(), 'followup.txt'), `${me}: ${prompt.slice(0, 60)}\n`)
    }
  }
  const reply = failed ? '' : task ? `Done ${task}.` : `Follow-up done.`
  const ev = (e) => process.stdout.write(JSON.stringify(e) + '\n')
  const file = join(process.cwd(), task ? `${task}.txt` : 'followup.txt')
  if (isCodex) {
    ev({ type: 'thread.started', thread_id: sid })
    ev({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } })
    if (failed) ev({ type: 'turn.failed', error: { message: 'fake exec failure' } })
    else {
      writeFileSync(argv[argv.indexOf('-o') + 1], reply)
      ev({ type: 'item.completed', item: { type: 'agent_message', text: reply } })
      ev({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5 } })
    }
  } else if (isAgy) {
    ev({ event: 'init', conversation_id: sid })
    ev({ event: 'step_update', step_update: { state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { parameters: { TargetFile: file } } } })
    for (const ch of reply.match(/.{1,4}/g) || []) ev({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: ch } })
    ev({ event: 'result', result: { status: failed ? 'ERROR' : 'SUCCESS', error: failed ? 'fake exec failure' : undefined, response: reply, conversation_id: sid, usage: { input_tokens: 10, output_tokens: 2 } } })
  } else {
    ev({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-model' })
    ev({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: file } }] } })
    ev({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: !!failed, result: reply || 'fake exec failure', session_id: sid, total_cost_usd: 0.02, usage: { input_tokens: 5, output_tokens: 3 } })
  }
  process.exit(failed ? 1 : 0)
}
const repair = prompt.includes('Your previous reply failed validation')
const assignable = ((prompt.match(/assignee: one of ([a-z, ]+)\./) || [])[1] || 'claude').split(',').map((s) => s.trim())

if (cfg.slowMs) await new Promise((r) => setTimeout(r, cfg.slowMs))
if (cfg.writeFile === me && step === 'R1') writeFileSync(join(process.cwd(), 'pwned.txt'), 'hi')
if (cfg.failAgent === me && (!cfg.failStep || cfg.failStep === step)) {
  process.stderr.write('fake failure\n')
  process.exit(1)
}

const tasks = () => [
  {
    id: 't1',
    title: 'Add the helper',
    detail: 'Create the helper module.',
    scope: ['src/a.ts'],
    dependsOn: [],
    assignee: assignable[0],
    acceptance: ['npm test passes'],
    resources: []
  },
  {
    id: 't2',
    title: 'Use the helper',
    detail: 'Call the helper from b.',
    scope: ['src\\b.ts'],
    dependsOn: ['t1'],
    assignee: assignable[assignable.length - 1],
    acceptance: ['b uses the helper'],
    resources: []
  }
]

let out
if (step === 'Discussion') {
  const messages = prompt.split('\n').flatMap((line) => { try { const m = JSON.parse(line); return m.id && m.speaker ? [m] : [] } catch { return [] } })
  const last = messages[messages.length - 1]
  out = { message: `${me} replies to ${last?.speaker}: ${last?.message}`, replyTo: last?.id || null }
} else if (step === 'Summary') {
  const messages = prompt.split('\n').flatMap((line) => { try { const m = JSON.parse(line); return m.id && m.speaker ? [m] : [] } catch { return [] } })
  out = { summary: `Recorded ${messages.map((m) => m.id).join(', ')}; preserve EARLY_REQUIREMENT.`, consensus: ['Use the agreed approach'], disagreements: ['Claude prefers option B'], questions: ['User must approve execution'] }
} else if (step === 'Conclusion') {
  out = { message: 'Chair recommends the recorded approach. EARLY_REQUIREMENT remains required; user approval is needed before execution.', replyTo: null }
} else if (step === 'R1') {
  out =
    cfg.invalidOnce && !repair
      ? { summary: 's', framing: 'f', tasks: [], questions: [], risks: [] }
      : { summary: 'Plan', framing: 'Two tasks', tasks: tasks(), questions: [{ id: 'whatever', text: 'Is a.ts the right place?' }], risks: [] }
} else if (step === 'R2') {
  out = cfg.r2Objection
    ? {
        agree: ['t2'],
        objections: [{ id: 'x', target: 't1', reason: 'a.ts already exists', alternative: 'use c.ts' }],
        missing: [{ id: 'y', title: 'Tests', why: 'no test task' }],
        claims: ['t2'],
        answers: [{ questionId: 'q1', answer: 'yes' }]
      }
    : { agree: ['t1', 't2'], objections: [], missing: [], claims: [], answers: [] }
} else if (step === 'R3/R4') {
  const issueIds = [...prompt.matchAll(/^- (\S+) \[/gm)].map((m) => m[1])
  const decided = cfg.r34Unresolved ? issueIds.slice(1) : issueIds
  out = {
    tasks: tasks(),
    decisions: cfg.r34OmitDecisions ? [] : decided.map((id) => ({ issueId: id, verdict: 'accept', reason: `handled ${id}` })),
    unresolved: cfg.r34Unresolved && issueIds.length ? [{ issueId: issueIds[0], text: 'need the user' }] : []
  }
} else if (step === 'Revise') {
  const ids = ((prompt.match(/you must now decide or keep in unresolved: (.+)$/m) || [])[1] || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== '(new)')
  out = { tasks: tasks().slice(0, 1), decisions: ids.map((id) => ({ issueId: id, verdict: 'reject', reason: 'user said so' })), unresolved: [] }
} else {
  process.stderr.write(`unknown step ${step}\n`)
  process.exit(2)
}
if (['R2', 'R3/R4', 'Revise'].includes(step)) out.message = `${me}: I reviewed the earlier proposal and addressed the concrete points.`

if (isAgy) {
  const ev = (e) => process.stdout.write(JSON.stringify(e) + '\n')
  ev({ event: 'init', conversation_id: 'fake', init: { cwd: process.cwd(), tools: ['view_file', 'run_command', 'schedule'] } })
  const tool = cfg.agyBadTool || (step === 'Discussion' ? 'finish' : 'view_file')
  ev({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: tool, tool_info: { name: tool, parameters: {} } } })
  if (cfg.agyBadTool) {
    // 違規工具：照理會被 orchestrator 立刻終止；等著，證明是被殺掉而不是自己結束
    await new Promise((r) => setTimeout(r, 30000))
  }
  ev({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: tool } })
  const usage = { input_tokens: 900, output_tokens: 40, thinking_tokens: 30, cache_read_tokens: 300, total_tokens: 940 }
  ev({
    event: 'result',
    result: cfg.agyNoOutput
      ? { status: 'SUCCESS', response: '', usage, denied_actions: [{ action: 'read_file', display_name: 'ViewFile' }] }
      : { status: 'SUCCESS', response: JSON.stringify(out), structured_output: out, usage }
  })
} else if (isCodex) {
  const o = argv[argv.indexOf('-o') + 1]
  writeFileSync(o, JSON.stringify(out))
  const ev = (e) => process.stdout.write(JSON.stringify(e) + '\n')
  ev({ type: 'thread.started', thread_id: 'fake' })
  ev({ type: 'turn.started' })
  if (step !== 'Discussion') ev({ type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'ls', aggregated_output: 'a.ts', exit_code: 0, status: 'completed' } })
  ev({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: JSON.stringify(out) } })
  ev({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 5 } })
} else {
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify(out),
      structured_output: out,
      total_cost_usd: 0.01,
      usage: { input_tokens: 4, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 }
    })
  )
}
