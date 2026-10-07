// Cowork P1 的協調者：會議狀態機（R1 → R2 → R3/R4 → 待核准）、預算記帳、取消、重試、改板與核准。
// 不 import electron：所有跟 app 相關的東西（資料目錄、CLI 路徑、廣播）都由 deps 注入，
// scripts/check-cowork.mts 才能拿假 CLI 在暫存 repo 上把整條流程跑一遍。
// 設計依據：cowork.md §4（會議協議）、§5.4（暫停／取消／恢復）、§7（持久化）、§8（預算）。
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { runProcess, type RunResult } from './runner'
import { writeJsonAtomic, readJsonWithFallback } from './store'
import {
  readBaseline,
  createSnapshot,
  snapshotChanges,
  removeSnapshot,
  snapshotDirFor,
  scopeEscapes,
  type Baseline
} from './git'
import {
  COWORK_TERMINAL_PHASES,
  DEFAULT_COWORK_LIMITS,
  assignableAgents,
  buildR1Prompt,
  buildR2Prompt,
  buildR34Prompt,
  buildRepairPrompt,
  buildRevisePrompt,
  checkR1,
  checkR2,
  checkResolution,
  checkTasks,
  collectIssues,
  currentBoard,
  parseClaudeOutput,
  parseCodexOutput,
  plannerInvocation,
  reviewersOf,
  schemaFor,
  summarizeRun,
  type CoworkAgent,
  type CoworkBlockKind,
  type CoworkCall,
  type CoworkLimits,
  type CoworkRun,
  type CoworkRunSummary,
  type CoworkStep,
  type CoworkTask,
  type ParsedOutput,
  type R1Output,
  type R2Output,
  type Resolution
} from '../../shared/cowork'

export interface ResolvedCli {
  command: string
  /** 假 CLI 用：放在 CLI 參數前面（例如 node 的腳本路徑） */
  prefixArgs?: string[]
  /** codex 在 Windows 需要的 sandbox 模式（從使用者設定讀出來） */
  windowsSandbox?: string | null
}

export interface CoworkDeps {
  /** 例如 userData/cowork */
  dataDir: string
  resolveCli(agent: CoworkAgent): ResolvedCli | { error: string }
  emit(run: CoworkRun): void
  now?(): number
}

export interface StartOptions {
  workspace: string
  prompt: string
  chair: CoworkAgent
  participants: CoworkAgent[]
  chairExecutes: boolean
  language: 'en' | 'zh-TW'
  limits: Pick<CoworkLimits, 'maxPlanningCalls' | 'maxPlanningMinutes' | 'maxExecutionMinutes'>
}

/** 給 IPC 回傳的錯誤：code 讓 renderer 翻譯，message 給 log */
export class CoworkError extends Error {
  code: string
  data?: unknown
  constructor(code: string, message?: string, data?: unknown) {
    super(message || code)
    this.code = code
    this.data = data
  }
}

type StepResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'failed' | 'budget' | 'side-effects' | 'cancelled'; error: string; details?: string[] }

const RAW_LIMIT = 256 * 1024
const ACTIVITY_EMIT_MS = 1000

export class CoworkService {
  private runs = new Map<string, CoworkRun>()
  private dirs = new Map<string, string>()
  /** 每次取消／重試都換代；await 回來發現代數變了就放手，不再改 run 狀態 */
  private gen = new Map<string, number>()
  private controllers = new Map<string, Set<AbortController>>()
  private abortReason = new Map<string, 'cancel' | 'budget' | 'side-effects'>()
  private activeCalls = new Map<string, number>()
  /** 從呼叫開始到核對完快照為止都算在內；取消時要等它歸零才能收快照 */
  private inflight = new Map<string, number>()
  private snapshotBuilding = new Map<string, Promise<void>>()
  private budgetTimers = new Map<string, NodeJS.Timeout>()
  private lastActivityEmit = new Map<string, number>()
  private shuttingDown = false
  private deps: CoworkDeps

  constructor(deps: CoworkDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  // ── 載入與恢復 ────────────────────────────────────────────────────

  /** 啟動時載入所有 run。進行中的會議一律轉 paused，等使用者核對（cowork.md 設計主軸 5） */
  init(): void {
    if (!fs.existsSync(this.deps.dataDir)) return
    for (const repoId of fs.readdirSync(this.deps.dataDir)) {
      const repoDir = path.join(this.deps.dataDir, repoId)
      if (!fs.statSync(repoDir).isDirectory()) continue
      for (const runId of fs.readdirSync(repoDir)) {
        const dir = path.join(repoDir, runId)
        const loaded = readJsonWithFallback(path.join(dir, 'run.json'), isRun)
        if (!loaded) continue
        const run = loaded.value
        this.runs.set(run.id, run)
        this.dirs.set(run.id, dir)
        let changed = loaded.fromBackup
        for (const c of run.calls) {
          if (c.status === 'running') {
            c.status = 'interrupted'
            c.endedAt = c.endedAt || run.updatedAt
            changed = true
          }
        }
        for (const r of Object.values(run.reviewers)) {
          if (r && r.status === 'running') {
            r.status = 'pending'
            changed = true
          }
        }
        if (run.budget.activeSince) {
          run.budget.planningMsUsed += Math.max(0, run.updatedAt - run.budget.activeSince)
          run.budget.activeSince = null
          changed = true
        }
        if (run.phase === 'meeting') {
          run.phase = 'paused'
          run.block = { kind: 'restart', message: 'The app restarted while the meeting was running.', at: this.now() }
          run.log.push({ t: 'blocked', kind: 'restart', message: run.block.message, at: this.now() })
          const step = this.nextStep(run)
          run.pending = run.pending || (step ? { step } : null)
          changed = true
        }
        if (changed) this.save(run, false)
      }
    }
  }

  /** app 結束：收掉所有還在跑的 CLI。下次啟動 init() 會把會議轉成 paused */
  shutdown(): void {
    this.shuttingDown = true
    for (const set of this.controllers.values()) for (const c of set) c.abort()
  }

  // ── 查詢 ───────────────────────────────────────────────────────────

  async list(workspace: string): Promise<CoworkRunSummary[]> {
    let base: Baseline
    try {
      base = await readBaseline(workspace)
    } catch {
      return []
    }
    const repoId = repoIdOf(base.commonDir)
    return [...this.runs.values()]
      .filter((r) => repoIdOf(r.repo.commonDir) === repoId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(summarizeRun)
  }

  get(runId: string): CoworkRun | null {
    return this.runs.get(runId) || null
  }

  // ── 開會 ───────────────────────────────────────────────────────────

  async start(opts: StartOptions): Promise<CoworkRun> {
    const prompt = typeof opts.prompt === 'string' ? opts.prompt.trim() : ''
    if (!prompt) throw new CoworkError('empty-prompt')
    if (prompt.length > 20000) throw new CoworkError('prompt-too-long')
    const participants = [...new Set(opts.participants)]
    if (!participants.includes(opts.chair)) throw new CoworkError('chair-not-participant')
    if (participants.length < 2) throw new CoworkError('need-two-participants')
    for (const a of participants) {
      const cli = this.deps.resolveCli(a)
      if ('error' in cli) throw new CoworkError('agent-not-eligible', `${a}: ${cli.error}`, { agent: a, reason: cli.error })
    }

    let base: Baseline
    try {
      base = await readBaseline(opts.workspace)
    } catch (e) {
      throw new CoworkError((e as Error).message)
    }
    const repoId = repoIdOf(base.commonDir)
    const active = [...this.runs.values()].find(
      (r) => repoIdOf(r.repo.commonDir) === repoId && !COWORK_TERMINAL_PHASES.includes(r.phase)
    )
    if (active) throw new CoworkError('active-run-exists', undefined, { runId: active.id })

    const id = newRunId()
    const now = this.now()
    const run: CoworkRun = {
      schemaVersion: 1,
      id,
      revision: 0,
      planRevision: 1,
      approvedPlanRevision: null,
      prompt,
      createdAt: now,
      updatedAt: now,
      language: opts.language,
      repo: {
        root: base.root,
        commonDir: base.commonDir,
        sourceBranch: base.branch,
        baseCommit: base.head,
        excludedDirty: base.dirty.slice(0, 500)
      },
      snapshotDir: snapshotDirFor(base.commonDir, id),
      chair: opts.chair,
      participants,
      chairExecutes: opts.chairExecutes,
      phase: 'meeting',
      block: null,
      pending: null,
      notes: [],
      limits: {
        ...DEFAULT_COWORK_LIMITS,
        maxPlanningCalls: opts.limits.maxPlanningCalls,
        maxPlanningMinutes: opts.limits.maxPlanningMinutes,
        maxExecutionMinutes: opts.limits.maxExecutionMinutes
      },
      budget: { planningCallsUsed: 0, planningMsUsed: 0, activeSince: null, costUsd: 0, tokens: 0 },
      r1: null,
      reviewers: {},
      boards: [],
      calls: [],
      log: [
        { t: 'start', at: now },
        { t: 'round', round: 1, at: now, planRevision: 1 }
      ]
    }
    this.runs.set(id, run)
    this.dirs.set(id, path.join(this.deps.dataDir, repoId, id))
    this.gen.set(id, 0)
    this.save(run)

    try {
      await createSnapshot(base.root, run.snapshotDir, base.head)
    } catch (e) {
      run.phase = 'failed'
      run.block = { kind: 'step-failed', message: `Could not create the planning snapshot: ${(e as Error).message}`, at: this.now() }
      run.log.push({ t: 'blocked', kind: 'step-failed', message: run.block.message, at: this.now() })
      this.save(run)
      return run
    }
    void this.advance(run)
    return run
  }

  /** 依目前狀態決定下一步並執行。每次呼叫都綁定當下的代數 */
  private async advance(run: CoworkRun): Promise<void> {
    if (run.phase !== 'meeting' || this.shuttingDown) return
    const step = run.pending?.step || this.nextStep(run)
    if (!step) return
    try {
      if (step === 'r1') await this.stepR1(run)
      else if (step === 'r2') await this.stepR2(run)
      else if (step === 'r34') await this.stepR34(run)
      else await this.stepRevise(run, run.pending?.feedback || '')
    } catch (e) {
      // 預期外的錯誤也不能讓會議卡在 meeting：轉成 blocked，保留可重試的步驟
      if (run.phase === 'meeting') this.block(run, 'step-failed', `Unexpected error: ${(e as Error).message}`, step)
    }
  }

  private nextStep(run: CoworkRun): CoworkStep | null {
    if (!run.r1) return 'r1'
    const reviewers = reviewersOf(run)
    if (reviewers.some((a) => ['pending', 'running', 'failed'].includes(run.reviewers[a]?.status || 'pending'))) return 'r2'
    if (!run.boards.length) return 'r34'
    return null
  }

  private async stepR1(run: CoworkRun): Promise<void> {
    const g = this.gen.get(run.id)
    const assignable = assignableAgents(run)
    const prompt = buildR1Prompt({ run, notes: run.notes })
    const res = await this.runStep<R1Output>(run, 'r1', run.chair, prompt, (v) => this.withScopeCheck(run, checkR1(v, { assignable, maxTasks: run.limits.maxTasks }), (r) => r.tasks))
    if (this.gen.get(run.id) !== g || run.phase !== 'meeting') return
    if (!res.ok) return this.stepFailed(run, 'r1', res)
    run.r1 = res.value
    run.pending = null
    for (const a of reviewersOf(run)) run.reviewers[a] = { status: 'pending' }
    run.log.push({ t: 'r1', at: this.now() }, { t: 'round', round: 2, at: this.now(), planRevision: run.planRevision })
    this.save(run)
    return this.advance(run)
  }

  private async stepR2(run: CoworkRun): Promise<void> {
    const g = this.gen.get(run.id)
    const r1 = run.r1!
    const todo = reviewersOf(run).filter((a) => {
      const s = run.reviewers[a]?.status
      return !s || s === 'pending' || s === 'running'
    })
    for (const a of todo) run.reviewers[a] = { status: 'running' }
    this.save(run)
    const results = await Promise.all(
      todo.map((agent) =>
        this.runStep<R2Output>(run, 'r2', agent, buildR2Prompt({ run, reviewer: agent, r1, notes: run.notes }), checkR2).then(
          (res) => ({ agent, res })
        )
      )
    )
    if (this.gen.get(run.id) !== g || run.phase !== 'meeting') return
    for (const { agent, res } of results) {
      if (res.ok) {
        run.reviewers[agent] = { status: 'ok', output: res.value }
        run.log.push({ t: 'r2', agent, at: this.now() })
      } else {
        run.reviewers[agent] = { status: 'failed', error: res.error }
        if (res.kind !== 'cancelled') run.log.push({ t: 'error', step: 'r2', agent, message: res.error, at: this.now() })
      }
    }
    const worst = pickWorst(results.map((r) => r.res))
    if (worst && worst.kind !== 'failed') return this.stepFailed(run, 'r2', worst)
    const failed = reviewersOf(run).filter((a) => run.reviewers[a]?.status === 'failed')
    if (failed.length) {
      // R2 失敗不能當成同意：停下來讓使用者重試，或明確選擇少一位覆核者
      return this.block(run, 'reviewers-failed', `Review failed for: ${failed.join(', ')}`, 'r2', failed.map((a) => `${a}: ${run.reviewers[a]?.error || ''}`))
    }
    run.pending = null
    run.log.push({ t: 'round', round: 3, at: this.now(), planRevision: run.planRevision })
    this.save(run)
    return this.advance(run)
  }

  private async stepR34(run: CoworkRun): Promise<void> {
    const g = this.gen.get(run.id)
    const r1 = run.r1!
    const issues = collectIssues(run.chair, r1, run.reviewers)
    const assignable = assignableAgents(run)
    const prompt = buildR34Prompt({ run, r1, reviews: run.reviewers, issues, notes: run.notes })
    const res = await this.runStep<Resolution>(run, 'r34', run.chair, prompt, (v) =>
      this.withScopeCheck(
        run,
        checkResolution(v, { assignable, maxTasks: run.limits.maxTasks, requiredIssues: issues.map((i) => i.id) }),
        (r) => r.tasks
      )
    )
    if (this.gen.get(run.id) !== g || run.phase !== 'meeting') return
    if (!res.ok) return this.stepFailed(run, 'r34', res)
    this.adoptBoard(run, res.value, 'chair', false)
  }

  private async stepRevise(run: CoworkRun, feedback: string): Promise<void> {
    const g = this.gen.get(run.id)
    const board = currentBoard(run)
    if (!board) return this.block(run, 'step-failed', 'There is no plan to revise.', null)
    const assignable = assignableAgents(run)
    const required = board.unresolved.map((u) => u.issueId).filter(Boolean)
    const prompt = buildRevisePrompt({ run, board, feedback, notes: run.notes })
    const res = await this.runStep<Resolution>(run, 'revise', run.chair, prompt, (v) =>
      this.withScopeCheck(run, checkResolution(v, { assignable, maxTasks: run.limits.maxTasks, requiredIssues: required }), (r) => r.tasks)
    )
    if (this.gen.get(run.id) !== g || run.phase !== 'meeting') return
    if (!res.ok) {
      run.pending = { step: 'revise', feedback }
      return this.stepFailed(run, 'revise', res)
    }
    // 改版的決策附在原本的後面：前面仲裁過的 issue 仍然算數
    this.adoptBoard(run, { ...res.value, decisions: [...board.decisions, ...res.value.decisions] }, 'chair', true)
  }

  /** 採用一份新的任務板；有待定項目就停在 blocked(unresolved)，否則進入待核准 */
  private adoptBoard(run: CoworkRun, res: Resolution, source: 'chair' | 'user', bump: boolean): void {
    if (bump) run.planRevision++
    run.boards.push({ ...res, planRevision: run.planRevision, source, at: this.now() })
    run.pending = null
    run.log.push({ t: 'board', planRevision: run.planRevision, at: this.now() })
    if (res.unresolved.length) {
      this.block(run, 'unresolved', `${res.unresolved.length} issue(s) need your decision.`, null)
      return
    }
    run.phase = 'awaiting-approval'
    run.block = null
    this.save(run)
  }

  private stepFailed<T>(run: CoworkRun, step: CoworkStep, res: Extract<StepResult<T>, { ok: false }>): void {
    if (res.kind === 'cancelled') return
    // R2 的錯誤已在 stepR2 逐位覆核者記錄過
    if (step !== 'r2') run.log.push({ t: 'error', step, agent: run.chair, message: res.error, at: this.now() })
    const kind: CoworkBlockKind = res.kind === 'budget' ? 'budget' : res.kind === 'side-effects' ? 'side-effects' : 'step-failed'
    this.block(run, kind, res.error, step, res.details)
  }

  private block(run: CoworkRun, kind: CoworkBlockKind, message: string, step: CoworkStep | null, details?: string[]): void {
    run.phase = 'blocked'
    run.block = { kind, message, at: this.now(), ...(details?.length ? { details: details.slice(0, 200) } : {}) }
    if (step) run.pending = { step, ...(run.pending?.feedback && step === 'revise' ? { feedback: run.pending.feedback } : {}) }
    run.log.push({ t: 'blocked', kind, message, at: this.now() })
    this.save(run)
  }

  // ── 一個步驟：呼叫 → 解析 → 驗證；不合格最多修正一次 ────────────────

  private async runStep<T>(
    run: CoworkRun,
    step: CoworkStep,
    agent: CoworkAgent,
    prompt: string,
    validate: (v: unknown) => { ok: true; value: T } | { ok: false; errors: string[] }
  ): Promise<StepResult<T>> {
    const first = await this.callAgent(run, agent, step, prompt, false)
    if (!first.ok) return first
    const v1 = validate(first.value)
    if (v1.ok) return v1
    // 修正呼叫也計入預算；預算不夠就直接回報驗證錯誤，不硬擠
    const repaired = await this.callAgent(run, agent, step, buildRepairPrompt(prompt, first.raw, v1.errors), true)
    if (!repaired.ok) {
      if (repaired.kind === 'budget') {
        return { ok: false, kind: 'budget', error: `Invalid output and no budget left to repair it: ${v1.errors.slice(0, 3).join('; ')}`, details: v1.errors }
      }
      return repaired
    }
    const v2 = validate(repaired.value)
    if (v2.ok) return v2
    return { ok: false, kind: 'failed', error: `Output still invalid after one repair: ${v2.errors.slice(0, 3).join('; ')}`, details: v2.errors }
  }

  /** 從驗證結果再加一道：scope 路徑經 symlink 跨出快照就不收 */
  private withScopeCheck<T>(
    run: CoworkRun,
    checked: { ok: true; value: T } | { ok: false; errors: string[] },
    tasksOf: (v: T) => CoworkTask[]
  ): { ok: true; value: T } | { ok: false; errors: string[] } {
    if (!checked.ok) return checked
    const tree = fs.existsSync(run.snapshotDir) ? run.snapshotDir : run.repo.root
    const errors: string[] = []
    for (const t of tasksOf(checked.value)) {
      for (const s of t.scope) {
        const why = scopeEscapes(tree, s)
        if (why) errors.push(`task ${t.id}: ${why}`)
      }
    }
    return errors.length ? { ok: false, errors } : checked
  }

  private async callAgent(
    run: CoworkRun,
    agent: CoworkAgent,
    step: CoworkStep,
    prompt: string,
    repair: boolean
  ): Promise<{ ok: true; value: unknown; raw: string } | Extract<StepResult<never>, { ok: false }>> {
    // 預算在呼叫開始前記帳；失敗的呼叫也算（cowork.md §8）
    if (run.budget.planningCallsUsed >= run.limits.maxPlanningCalls) {
      return { ok: false, kind: 'budget', error: `Planning call limit reached (${run.limits.maxPlanningCalls}).` }
    }
    const maxMs = run.limits.maxPlanningMinutes * 60_000
    if (this.msUsed(run) >= maxMs) {
      return { ok: false, kind: 'budget', error: `Planning time limit reached (${run.limits.maxPlanningMinutes} min).` }
    }
    const cli = this.deps.resolveCli(agent)
    if ('error' in cli) return { ok: false, kind: 'failed', error: `${agent} is not available: ${cli.error}` }
    try {
      await this.ensureSnapshot(run)
    } catch (e) {
      return { ok: false, kind: 'failed', error: `Could not prepare the planning snapshot: ${(e as Error).message}` }
    }

    this.inflight.set(run.id, (this.inflight.get(run.id) || 0) + 1)
    try {
      return await this.callAgentInner(run, agent, step, prompt, repair, cli)
    } finally {
      this.inflight.set(run.id, Math.max(0, (this.inflight.get(run.id) || 1) - 1))
    }
  }

  /** R2 平行呼叫時兩位覆核者可能同時發現快照不在：共用同一個建立中的 promise */
  private ensureSnapshot(run: CoworkRun): Promise<void> {
    if (fs.existsSync(path.join(run.snapshotDir, '.git'))) return Promise.resolve()
    let p = this.snapshotBuilding.get(run.id)
    if (!p) {
      p = createSnapshot(run.repo.root, run.snapshotDir, run.repo.baseCommit).finally(() => this.snapshotBuilding.delete(run.id))
      this.snapshotBuilding.set(run.id, p)
    }
    return p
  }

  private async callAgentInner(
    run: CoworkRun,
    agent: CoworkAgent,
    step: CoworkStep,
    prompt: string,
    repair: boolean,
    cli: ResolvedCli
  ): Promise<{ ok: true; value: unknown; raw: string } | Extract<StepResult<never>, { ok: false }>> {
    const callId = `c${run.calls.length + 1}`
    const meetingDir = path.join(this.dirOf(run), 'meeting')
    fs.mkdirSync(meetingDir, { recursive: true })
    const schema = schemaFor(step, assignableAgents(run))
    const schemaFile = path.join(meetingDir, `${callId}.schema.json`)
    const outFile = path.join(meetingDir, `${callId}.last.txt`)
    fs.writeFileSync(schemaFile, JSON.stringify(schema))
    let inv
    try {
      inv = plannerInvocation(agent, { cwd: run.snapshotDir, schema, schemaFile, outFile, windowsSandbox: cli.windowsSandbox })
    } catch (e) {
      return { ok: false, kind: 'failed', error: (e as Error).message }
    }

    const call: CoworkCall = {
      id: callId,
      agent,
      step,
      repair,
      planRevision: run.planRevision,
      startedAt: this.now(),
      outputBytes: 0,
      timeoutMs: run.limits.callTimeoutSec * 1000,
      status: 'running'
    }
    run.calls.push(call)
    run.budget.planningCallsUsed++
    this.clockStart(run)
    this.save(run)

    const ac = new AbortController()
    const set = this.controllers.get(run.id) || new Set()
    set.add(ac)
    this.controllers.set(run.id, set)
    let result: RunResult
    try {
      result = await runProcess(
        {
          command: cli.command,
          args: [...(cli.prefixArgs || []), ...inv.args],
          cwd: run.snapshotDir,
          stdin: prompt,
          timeoutMs: call.timeoutMs,
          maxBytes: run.limits.maxOutputBytes,
          onActivity: (bytes) => {
            call.outputBytes = bytes
            call.lastOutputAt = this.now()
            const last = this.lastActivityEmit.get(run.id) || 0
            if (this.now() - last >= ACTIVITY_EMIT_MS) {
              this.lastActivityEmit.set(run.id, this.now())
              this.deps.emit(run)
            }
          }
        },
        ac.signal
      )
    } finally {
      set.delete(ac)
      this.clockStop(run)
    }
    call.endedAt = this.now()

    let parsed: ParsedOutput
    if (result.spawnError) parsed = { ok: false, error: `Could not start ${agent}: ${result.spawnError}`, raw: '' }
    else if (result.cancelled) parsed = { ok: false, error: 'cancelled', raw: result.stdout }
    else if (result.timedOut) parsed = { ok: false, error: `${agent} timed out after ${run.limits.callTimeoutSec}s`, raw: result.stdout }
    else if (result.truncated) parsed = { ok: false, error: `${agent} produced more output than the ${run.limits.maxOutputBytes} byte limit`, raw: '' }
    else {
      const lastMsg = inv.outFile && fs.existsSync(inv.outFile) ? fs.readFileSync(inv.outFile, 'utf8') : null
      parsed = agent === 'codex' ? parseCodexOutput(result.stdout, lastMsg) : parseClaudeOutput(result.stdout)
      if (!parsed.ok && result.code !== 0 && result.stderr.trim()) {
        parsed = { ...parsed, error: `${parsed.error} (exit ${result.code}: ${result.stderr.trim().slice(-400)})` }
      }
    }
    if (parsed.usage) {
      call.usage = parsed.usage
      run.budget.costUsd += parsed.usage.costUsd || 0
      run.budget.tokens += (parsed.usage.inputTokens || 0) + (parsed.usage.outputTokens || 0)
    }
    this.saveRaw(meetingDir, callId, { agent, step, repair, prompt, stdout: result.stdout, stderr: result.stderr, parsed })

    // 每次呼叫後都核對快照：任何變動都代表 CLI 沒守住唯讀，這次規劃作廢並保留 diff
    let changes: string[] = []
    try {
      changes = await snapshotChanges(run.snapshotDir, run.repo.baseCommit)
    } catch (e) {
      changes = [`could not verify the snapshot: ${(e as Error).message}`]
    }

    const reason = this.abortReason.get(run.id)
    if (changes.length) {
      call.status = 'failed'
      call.error = 'side effects detected'
      fs.writeFileSync(path.join(meetingDir, `${callId}.side-effects.txt`), changes.join('\n'))
      this.abortAll(run, 'side-effects')
      this.save(run)
      return {
        ok: false,
        kind: 'side-effects',
        error: `${agent} changed the read-only snapshot during planning; this plan is void.`,
        details: changes
      }
    }
    if (result.cancelled) {
      call.status = 'cancelled'
      call.error = reason === 'budget' ? 'planning time limit reached' : 'cancelled'
      this.save(run)
      if (reason === 'budget') return { ok: false, kind: 'budget', error: `Planning time limit reached (${run.limits.maxPlanningMinutes} min).` }
      return { ok: false, kind: 'cancelled', error: 'cancelled' }
    }
    if (!parsed.ok) {
      call.status = 'failed'
      call.error = parsed.error
      this.save(run)
      return { ok: false, kind: 'failed', error: parsed.error }
    }
    call.status = 'ok'
    this.save(run)
    return { ok: true, value: parsed.value, raw: parsed.raw }
  }

  // ── 規劃時間：只算「有呼叫在跑」的區間，平行呼叫不重複計 ─────────────

  private msUsed(run: CoworkRun): number {
    return run.budget.planningMsUsed + (run.budget.activeSince ? this.now() - run.budget.activeSince : 0)
  }

  private clockStart(run: CoworkRun): void {
    const n = (this.activeCalls.get(run.id) || 0) + 1
    this.activeCalls.set(run.id, n)
    if (n === 1) {
      run.budget.activeSince = this.now()
      const maxMs = run.limits.maxPlanningMinutes * 60_000
      const t = setInterval(() => {
        if (this.msUsed(run) >= maxMs) this.abortAll(run, 'budget')
      }, 1000)
      t.unref?.()
      this.budgetTimers.set(run.id, t)
    }
  }

  private clockStop(run: CoworkRun): void {
    const n = Math.max(0, (this.activeCalls.get(run.id) || 1) - 1)
    this.activeCalls.set(run.id, n)
    if (n === 0) {
      if (run.budget.activeSince) run.budget.planningMsUsed += this.now() - run.budget.activeSince
      run.budget.activeSince = null
      const t = this.budgetTimers.get(run.id)
      if (t) clearInterval(t)
      this.budgetTimers.delete(run.id)
    }
  }

  private abortAll(run: CoworkRun, reason: 'cancel' | 'budget' | 'side-effects'): void {
    if (!this.abortReason.has(run.id)) this.abortReason.set(run.id, reason)
    for (const c of this.controllers.get(run.id) || []) c.abort()
  }

  /** 等這個 run 所有還在跑的呼叫都結束（取消後用：確定行程停了才收快照） */
  private async settle(run: CoworkRun): Promise<void> {
    for (let i = 0; i < 300 && (this.inflight.get(run.id) || 0) > 0; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  private nextGen(run: CoworkRun): void {
    this.gen.set(run.id, (this.gen.get(run.id) || 0) + 1)
    this.abortReason.delete(run.id)
  }

  // ── 使用者操作 ─────────────────────────────────────────────────────

  private mustGet(runId: string): CoworkRun {
    const run = this.runs.get(runId)
    if (!run) throw new CoworkError('run-not-found')
    return run
  }

  async cancel(runId: string): Promise<void> {
    const run = this.mustGet(runId)
    if (COWORK_TERMINAL_PHASES.includes(run.phase)) return
    this.abortAll(run, 'cancel')
    this.nextGen(run)
    run.phase = 'cancelled'
    run.block = null
    run.pending = null
    for (const a of Object.keys(run.reviewers) as CoworkAgent[]) {
      if (run.reviewers[a]?.status === 'running') run.reviewers[a] = { status: 'pending' }
    }
    run.log.push({ t: 'cancelled', at: this.now() })
    this.save(run)
    await this.settle(run)
    this.dropSnapshot(run)
  }

  /** 卡住或暫停後重試當下那一步（重試也計入預算） */
  async retry(runId: string): Promise<void> {
    const run = this.mustGet(runId)
    if (run.phase !== 'blocked' && run.phase !== 'paused') throw new CoworkError('not-retryable')
    if (run.block?.kind === 'unresolved') throw new CoworkError('not-retryable')
    if ((this.inflight.get(run.id) || 0) > 0) throw new CoworkError('busy')
    if (run.block?.kind === 'side-effects') {
      // 快照被動過：整個重建，回到乾淨的基線再試
      this.dropSnapshot(run)
    }
    for (const a of reviewersOf(run)) {
      if (run.reviewers[a]?.status === 'failed') run.reviewers[a] = { status: 'pending' }
    }
    this.nextGen(run)
    run.phase = 'meeting'
    run.block = null
    run.log.push({ t: 'resumed', at: this.now() })
    this.save(run)
    void this.advance(run)
  }

  /** R2 有人失敗時，明確選擇不等他、少一位覆核者繼續（cowork.md §4.2） */
  async dropFailedReviewers(runId: string): Promise<void> {
    const run = this.mustGet(runId)
    if (run.phase !== 'blocked' || run.block?.kind !== 'reviewers-failed') throw new CoworkError('not-allowed')
    const failed = reviewersOf(run).filter((a) => run.reviewers[a]?.status === 'failed')
    const ok = reviewersOf(run).filter((a) => run.reviewers[a]?.status === 'ok')
    if (!ok.length) throw new CoworkError('no-reviewer-left')
    for (const a of failed) run.reviewers[a] = { ...run.reviewers[a], status: 'dropped' }
    this.nextGen(run)
    run.planRevision++
    run.log.push({ t: 'drop', agents: failed, at: this.now(), planRevision: run.planRevision })
    run.log.push({ t: 'round', round: 3, at: this.now(), planRevision: run.planRevision })
    run.phase = 'meeting'
    run.block = null
    run.pending = { step: 'r34' }
    this.save(run)
    void this.advance(run)
  }

  addNote(runId: string, text: string): void {
    const run = this.mustGet(runId)
    const t = text.trim()
    if (!t) return
    if (COWORK_TERMINAL_PHASES.includes(run.phase)) throw new CoworkError('not-allowed')
    run.notes.push(t.slice(0, 4000))
    run.log.push({ t: 'note', text: t.slice(0, 4000), at: this.now() })
    this.save(run)
  }

  /** 使用者對計畫的回饋：主席改一版（一次呼叫），新版本要重新核准 */
  async feedback(runId: string, text: string): Promise<void> {
    const run = this.mustGet(runId)
    const t = text.trim()
    if (!t) throw new CoworkError('empty-feedback')
    const okPhase = run.phase === 'awaiting-approval' || run.phase === 'approved' || (run.phase === 'blocked' && run.block?.kind === 'unresolved')
    if (!okPhase || !currentBoard(run)) throw new CoworkError('not-allowed')
    this.nextGen(run)
    run.log.push({ t: 'feedback', text: t.slice(0, 4000), at: this.now(), planRevision: run.planRevision })
    run.phase = 'meeting'
    run.block = null
    run.pending = { step: 'revise', feedback: t.slice(0, 4000) }
    this.save(run)
    void this.advance(run)
  }

  /** 使用者直接改板：一樣要過 scope／assignee／DAG 驗證，並綁定版本避免覆蓋別人的新版 */
  editBoard(runId: string, basePlanRevision: number, tasks: unknown): { ok: true } | { ok: false; errors: string[] } {
    const run = this.mustGet(runId)
    const board = currentBoard(run)
    const okPhase = run.phase === 'awaiting-approval' || run.phase === 'approved' || (run.phase === 'blocked' && run.block?.kind === 'unresolved')
    if (!okPhase || !board) throw new CoworkError('not-allowed')
    if (basePlanRevision !== run.planRevision) throw new CoworkError('stale-revision', undefined, { current: run.planRevision })
    const checked = this.withScopeCheck(run, checkTasks(tasks, { assignable: assignableAgents(run), maxTasks: run.limits.maxTasks }), (v) => v)
    if (!checked.ok) return { ok: false, errors: checked.errors }
    this.nextGen(run)
    run.planRevision++
    run.log.push({ t: 'edit', planRevision: run.planRevision, at: this.now() })
    this.adoptBoard(run, { tasks: checked.value, decisions: board.decisions, unresolved: board.unresolved }, 'user', false)
    return { ok: true }
  }

  /** 使用者明確決定：待定項目不再追，帶著現在的計畫進入待核准 */
  dismissUnresolved(runId: string): void {
    const run = this.mustGet(runId)
    const board = currentBoard(run)
    if (run.phase !== 'blocked' || run.block?.kind !== 'unresolved' || !board) throw new CoworkError('not-allowed')
    this.nextGen(run)
    run.log.push({ t: 'dismiss', count: board.unresolved.length, at: this.now(), planRevision: run.planRevision + 1 })
    run.planRevision++
    this.adoptBoard(run, { tasks: board.tasks, decisions: board.decisions, unresolved: [] }, 'user', false)
  }

  approve(runId: string, planRevision: number): void {
    const run = this.mustGet(runId)
    const board = currentBoard(run)
    if (run.phase !== 'awaiting-approval' || !board) throw new CoworkError('not-allowed')
    if (planRevision !== run.planRevision || board.planRevision !== run.planRevision) {
      throw new CoworkError('stale-revision', undefined, { current: run.planRevision })
    }
    if (board.unresolved.length) throw new CoworkError('has-unresolved')
    run.approvedPlanRevision = planRevision
    run.phase = 'approved'
    run.block = null
    run.log.push({ t: 'approved', planRevision, at: this.now() })
    this.save(run)
    // P1 之後不再需要唯讀快照；之後若要改版會自動重建
    this.dropSnapshot(run)
  }

  /** 提高本次 run 的上限：只能由使用者明確操作，不會被設定預設值悄悄放寬 */
  raiseLimits(runId: string, limits: { maxPlanningCalls?: number; maxPlanningMinutes?: number }): void {
    const run = this.mustGet(runId)
    if (COWORK_TERMINAL_PHASES.includes(run.phase)) throw new CoworkError('not-allowed')
    const calls = Math.min(60, Math.max(run.limits.maxPlanningCalls, Math.round(limits.maxPlanningCalls ?? 0)))
    const minutes = Math.min(240, Math.max(run.limits.maxPlanningMinutes, Math.round(limits.maxPlanningMinutes ?? 0)))
    run.limits.maxPlanningCalls = calls
    run.limits.maxPlanningMinutes = minutes
    run.log.push({ t: 'limits', maxPlanningCalls: calls, maxPlanningMinutes: minutes, at: this.now() })
    this.save(run)
  }

  logDispatch(runId: string, taskId: string, target: string): void {
    const run = this.mustGet(runId)
    if (run.phase !== 'approved') throw new CoworkError('not-allowed')
    if (!currentBoard(run)?.tasks.some((t) => t.id === taskId)) throw new CoworkError('task-not-found')
    run.log.push({ t: 'dispatch', taskId, target: target.slice(0, 200), at: this.now() })
    this.save(run)
  }

  delete(runId: string): void {
    const run = this.mustGet(runId)
    if (run.phase === 'meeting' || (this.inflight.get(run.id) || 0) > 0) throw new CoworkError('busy')
    this.dropSnapshot(run)
    const dir = this.dirOf(run)
    const base = path.resolve(this.deps.dataDir)
    const rel = path.relative(base, path.resolve(dir))
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) fs.rmSync(dir, { recursive: true, force: true })
    this.runs.delete(runId)
    this.dirs.delete(runId)
  }

  // ── 持久化 ─────────────────────────────────────────────────────────

  private dirOf(run: CoworkRun): string {
    let d = this.dirs.get(run.id)
    if (!d) {
      d = path.join(this.deps.dataDir, repoIdOf(run.repo.commonDir), run.id)
      this.dirs.set(run.id, d)
    }
    return d
  }

  private save(run: CoworkRun, emit = true): void {
    run.revision++
    run.updatedAt = this.now()
    try {
      writeJsonAtomic(path.join(this.dirOf(run), 'run.json'), run)
    } catch (e) {
      // 寫不進去就不能再往前走：停在 blocked，避免狀態與磁碟脫節
      console.error('[cowork] failed to save run', run.id, e)
      if (run.phase === 'meeting') {
        this.abortAll(run, 'cancel')
        run.phase = 'blocked'
        run.block = { kind: 'step-failed', message: `Could not save the run: ${(e as Error).message}`, at: this.now() }
      }
    }
    if (emit) this.deps.emit(run)
  }

  private saveRaw(dir: string, callId: string, data: { stdout: string; stderr: string; [k: string]: unknown }): void {
    try {
      fs.writeFileSync(
        path.join(dir, `${callId}.json`),
        JSON.stringify({ ...data, stdout: data.stdout.slice(0, RAW_LIMIT), stderr: data.stderr.slice(-16 * 1024) }, null, 2)
      )
    } catch {
      /* 診斷用，寫不進去不影響流程 */
    }
  }

  private dropSnapshot(run: CoworkRun): void {
    try {
      removeSnapshot(run.snapshotDir, path.join(run.repo.commonDir, 'cowork'))
    } catch (e) {
      console.warn('[cowork] could not remove snapshot', run.snapshotDir, e)
    }
  }
}

// ── 小工具 ───────────────────────────────────────────────────────────

/** repo 身分：本機正規化後的 git common dir（Windows 不分大小寫） */
export function repoIdOf(commonDir: string): string {
  let p = path.resolve(commonDir)
  try {
    p = fs.realpathSync(p)
  } catch {
    /* 已不存在就用原路徑 */
  }
  if (process.platform === 'win32') p = p.toLowerCase()
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 16)
}

function newRunId(): string {
  return `r${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`
}

/** 平行呼叫裡挑最需要使用者處理的失敗：副作用 > 預算 > 一般失敗 > 取消 */
function pickWorst<T>(results: StepResult<T>[]): Extract<StepResult<T>, { ok: false }> | null {
  const order = ['side-effects', 'budget', 'failed', 'cancelled'] as const
  for (const k of order) {
    const hit = results.find((r): r is Extract<StepResult<T>, { ok: false }> => !r.ok && r.kind === k)
    if (hit) return hit
  }
  return null
}

function isRun(v: unknown): v is CoworkRun {
  const r = v as CoworkRun
  return !!r && typeof r === 'object' && r.schemaVersion === 1 && typeof r.id === 'string' && Array.isArray(r.log) && Array.isArray(r.calls) && Array.isArray(r.boards)
}
