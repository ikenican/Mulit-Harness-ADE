// Cowork 的背景執行：核准後把任務交給各家 agent，在 repo 內的 git worktree（.cowork/<runId>/）裡做。
// 執行用完整設定（使用者的 skill／MCP／外掛／hook 都會載入），權限照使用者的 Bypass 設定；
// 進度與回覆寫回 run，使用者在 Cowork 裡追問時接續同一個 session。
// 不 import electron：資料目錄、CLI 路徑、存檔與廣播都由 host 注入，scripts/check-cowork.mts 可以拿假 CLI 測。
import * as fs from 'node:fs'
import * as path from 'node:path'
import { runProcess } from './runner'
import {
  addWorktree,
  cherryPickAll,
  commitAll,
  diffStat,
  excludeCoworkDir,
  git,
  linkNodeModules,
  mergeBranch,
  removeWorktrees
} from './git'
import {
  buildExecPrompt,
  currentBoard,
  execInvocation,
  parseExecLine,
  topoOrder,
  type CoworkAgent,
  type CoworkExecMode,
  type CoworkExecution,
  type CoworkRun,
  type CoworkTaskExec,
  type CoworkTurn,
  type CallUsage
} from '../../shared/cowork'

export interface ExecCli {
  command: string
  prefixArgs?: string[]
  env?: Record<string, string>
}

export interface ExecHost {
  /** 這場 run 的資料目錄（放 codex 的 -o 檔） */
  dirOf(run: CoworkRun): string
  save(run: CoworkRun): void
  emit(run: CoworkRun): void
  resolveExecCli(agent: CoworkAgent): ExecCli | { error: string }
  /** Same-repo execution stays exclusive until its worktrees are merged or cleaned; planning may run concurrently. */
  otherActiveRun(run: CoworkRun): CoworkRun | undefined
  now(): number
}

/** 給 IPC 回傳的錯誤；與 orchestrator 的 CoworkError 同形 */
export class ExecError extends Error {
  code: string
  data?: unknown
  constructor(code: string, message?: string, data?: unknown) {
    super(message || code)
    this.code = code
    this.data = data
  }
}

const TURN_TIMEOUT_MS = 30 * 60_000
const MAX_PROGRESS = 40
const MAX_TEXT = 40_000
const EMIT_MS = 1000

export class CoworkExecutor {
  private host: ExecHost
  private controllers = new Map<string, Set<AbortController>>()
  private active = new Map<string, number>()
  private timers = new Map<string, NodeJS.Timeout>()
  private lastEmit = new Map<string, number>()
  private shuttingDown = false

  constructor(host: ExecHost) {
    this.host = host
  }

  // ── 開始 ───────────────────────────────────────────────────────────

  async start(run: CoworkRun, o: { mode: CoworkExecMode; linkDeps: boolean; bypass: boolean }): Promise<void> {
    if (run.phase !== 'approved') throw new ExecError('not-allowed')
    const board = currentBoard(run)
    if (!board || board.planRevision !== run.approvedPlanRevision) throw new ExecError('not-allowed')
    if (!topoOrder(board.tasks)) throw new ExecError('not-allowed', 'dependency cycle')
    const other = this.host.otherActiveRun(run)
    if (other) throw new ExecError('active-run-exists', undefined, { runId: other.id })

    const root = path.join(run.repo.root, '.cowork', run.id)
    const keys = o.mode === 'sequential' ? ['main'] : [...new Set(board.tasks.map((t) => t.assignee))]
    const worktrees: CoworkExecution['worktrees'] = {}
    for (const k of keys) worktrees[k] = { path: path.join(root, k), branch: `cowork/${run.id}/${k}` }

    excludeCoworkDir(run.repo.commonDir)
    const created: string[] = []
    try {
      for (const k of keys) {
        await addWorktree(run.repo.root, worktrees[k].path, worktrees[k].branch, run.repo.baseCommit)
        created.push(worktrees[k].path)
        if (o.linkDeps) await linkNodeModules(run.repo.root, worktrees[k].path)
      }
    } catch (e) {
      // 建到一半失敗：收掉已建的 worktree 與分支，run 維持在已核准
      await removeWorktrees(run.repo.root, root, created).catch(() => {})
      for (const k of keys) await git(run.repo.root, ['branch', '-D', worktrees[k].branch]).catch(() => '')
      throw new ExecError('worktree-failed', (e as Error).message)
    }

    const tasks: CoworkExecution['tasks'] = {}
    for (const t of board.tasks) {
      tasks[t.id] = { status: 'pending', agent: t.assignee, worktree: o.mode === 'sequential' ? 'main' : t.assignee, turns: [], commits: [] }
    }
    run.execution = {
      mode: o.mode,
      startedAt: this.host.now(),
      bypass: o.bypass,
      linkDeps: o.linkDeps,
      root,
      worktrees,
      tasks,
      paused: false,
      msUsed: 0,
      activeSince: null
    }
    run.phase = 'executing'
    run.log.push({ t: 'exec-start', mode: o.mode, bypass: o.bypass, at: this.host.now() })
    this.host.save(run)
    this.schedule(run)
  }

  // ── 排程 ───────────────────────────────────────────────────────────

  /** 依依賴順序啟動可以跑的任務：依賴都完成、所在的 worktree 沒有別的任務在跑 */
  schedule(run: CoworkRun): void {
    const ex = run.execution
    const board = currentBoard(run)
    if (!ex || !board || this.shuttingDown) return
    if (run.phase !== 'executing' && run.phase !== 'review') return
    if (!ex.paused) {
      const order = topoOrder(board.tasks) || board.tasks.map((t) => t.id)
      for (const id of order) {
        const te = ex.tasks[id]
        const task = board.tasks.find((t) => t.id === id)
        if (!te || !task || te.status !== 'pending') continue
        if (!task.dependsOn.every((d) => ex.tasks[d]?.status === 'done')) continue
        if (Object.values(ex.tasks).some((x) => x.status === 'running' && x.worktree === te.worktree)) continue
        if (board.tasks.some((other) => ex.tasks[other.id]?.status === 'running' && task.resources.some((r) => other.resources.includes(r)))) continue
        if (this.budgetLeft(run) <= 0) {
          this.pause(run, 'budget')
          return
        }
        void this.runTurn(run, id, {})
      }
    }
    const all = Object.values(ex.tasks)
    if (all.length && all.every((t) => t.status === 'done') && !all.some((t) => t.status === 'running')) {
      void this.finish(run)
    }
  }

  private budgetLeft(run: CoworkRun): number {
    const ex = run.execution!
    const used = ex.msUsed + (ex.activeSince ? this.host.now() - ex.activeSince : 0)
    return run.limits.maxExecutionMinutes * 60_000 - used
  }

  // ── 一輪對話：第一次交辦、使用者追問、或中斷後接續 ────────────────────

  private async runTurn(run: CoworkRun, taskId: string, o: { message?: string; fresh?: boolean }): Promise<void> {
    const ex = run.execution!
    const board = currentBoard(run)!
    const te = ex.tasks[taskId]
    const task = board.tasks.find((t) => t.id === taskId)!
    const wt = ex.worktrees[te.worktree]
    // 同步設成 running，排程才不會重複啟動同一個任務
    te.status = 'running'
    te.error = undefined
    te.startedAt = this.host.now()
    if (o.fresh) te.sessionId = undefined
    const followUp = !!o.message && !!te.sessionId

    // 同時模式：前置任務若在別的 worktree 完成，先把它們的 commit 套過來
    if (ex.mode === 'parallel' && !followUp) {
      const order = topoOrder(board.tasks) || []
      const needed = new Set<string>()
      const walk = (id: string): void => {
        for (const d of board.tasks.find((t) => t.id === id)?.dependsOn || []) {
          if (!needed.has(d)) {
            needed.add(d)
            walk(d)
          }
        }
      }
      walk(taskId)
      const commits = order
        .filter((id) => needed.has(id) && ex.tasks[id].worktree !== te.worktree)
        .flatMap((id) => ex.tasks[id].commits)
      if (commits.length) {
        const r = await cherryPickAll(wt.path, commits)
        if (!r.ok) {
          te.status = 'blocked'
          te.error = `Could not apply prerequisite commit ${r.commit.slice(0, 10)}: ${r.message}`
          te.endedAt = this.host.now()
          run.log.push({ t: 'task-failed', taskId, message: te.error, at: this.host.now() })
          this.host.save(run)
          this.schedule(run)
          return
        }
      }
    }

    const depSummaries = task.dependsOn.map((d) => {
      const dt = board.tasks.find((t) => t.id === d)
      const last = [...(ex.tasks[d]?.turns || [])].reverse().find((t) => t.role === 'agent' && t.text)
      return { id: d, title: dt?.title || d, summary: last?.text || '' }
    })
    // 接續 session 只送使用者的話；沒有 session（例如上次沒能啟動）就重新交辦並附上這段話
    const prompt = followUp
      ? o.message!
      : buildExecPrompt(run, task, { branch: wt.branch, deps: depSummaries }) +
        (o.message ? `\n\nAdditional instructions from the user:\n${o.message}` : '')
    const userTurn: CoworkTurn = { role: o.message ? 'user' : 'cowork', text: (o.message || prompt).slice(0, 8000), at: this.host.now() }
    const agentTurn: CoworkTurn = { role: 'agent', text: '', at: this.host.now(), progress: [], running: true }
    te.turns.push(userTurn, agentTurn)
    run.log.push({ t: 'task-start', taskId, agent: te.agent, followUp: !!o.message, at: this.host.now() })
    this.host.save(run)

    const cli = this.host.resolveExecCli(te.agent)
    if ('error' in cli) return this.endTurn(run, taskId, agentTurn, { ok: false, error: `${te.agent} is not available: ${cli.error}` })

    const n = te.turns.length
    const outFile = path.join(this.host.dirOf(run), 'exec', `${taskId}-${n}.last.txt`)
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    const choice = run.models?.[te.agent]
    const inv = execInvocation(te.agent, {
      cwd: wt.path,
      resumeId: followUp ? te.sessionId : undefined,
      model: choice?.model,
      effort: choice?.effort,
      bypass: ex.bypass,
      outFile
    })

    let final: { ok: boolean; text: string; error?: string } | null = null
    let lastText = ''
    const ac = new AbortController()
    const set = this.controllers.get(run.id) || new Set()
    set.add(ac)
    this.controllers.set(run.id, set)
    this.clockStart(run)
    let result
    try {
      result = await runProcess(
        {
          command: cli.command,
          args: [...(cli.prefixArgs || []), ...inv.args],
          cwd: wt.path,
          stdin: inv.stdin(prompt),
          timeoutMs: Math.max(60_000, Math.min(TURN_TIMEOUT_MS, this.budgetLeft(run))),
          maxBytes: 32 * 1024 * 1024,
          env: cli.env ? { ...process.env, ...cli.env } : undefined,
          onStdoutLine: (line) => {
            const ev = parseExecLine(te.agent, line, wt.path)
            if (!ev) return null
            if (ev.sessionId) te.sessionId = ev.sessionId
            if (ev.progress) {
              agentTurn.progress!.push(ev.progress)
              if (agentTurn.progress!.length > MAX_PROGRESS) agentTurn.progress!.splice(0, agentTurn.progress!.length - MAX_PROGRESS)
            }
            if (ev.text) {
              lastText = ev.text
              agentTurn.text = ev.text.slice(0, MAX_TEXT)
            }
            if (ev.textDelta) agentTurn.text = (agentTurn.text + ev.textDelta).slice(-MAX_TEXT)
            if (ev.usage) te.usage = addUsage(te.usage, ev.usage)
            if (ev.final) final = ev.final
            this.emitSoon(run)
            return null
          }
        },
        ac.signal
      )
    } finally {
      set.delete(ac)
      this.clockStop(run)
    }

    if (result.cancelled) return this.endTurn(run, taskId, agentTurn, { ok: false, error: 'stopped', cancelled: true })
    if (result.spawnError) return this.endTurn(run, taskId, agentTurn, { ok: false, error: `Could not start ${te.agent}: ${result.spawnError}` })
    if (result.timedOut) return this.endTurn(run, taskId, agentTurn, { ok: false, error: `${te.agent} did not finish within the time limit` })
    const f = final as { ok: boolean; text: string; error?: string } | null
    if (f && f.ok && result.code === 0) {
      const outText = inv.outFile && fs.existsSync(inv.outFile) ? fs.readFileSync(inv.outFile, 'utf8') : ''
      agentTurn.text = (f.text || lastText || outText || agentTurn.text).slice(0, MAX_TEXT)
      return this.endTurn(run, taskId, agentTurn, { ok: true, followUp: !!o.message })
    }
    const why = f?.error || (result.code !== 0 ? `exit ${result.code}: ${result.stderr.trim().slice(-400)}` : 'no result')
    return this.endTurn(run, taskId, agentTurn, { ok: false, error: why })
  }

  private async endTurn(
    run: CoworkRun,
    taskId: string,
    agentTurn: CoworkTurn,
    r: { ok: boolean; error?: string; cancelled?: boolean; followUp?: boolean }
  ): Promise<void> {
    const ex = run.execution!
    const te = ex.tasks[taskId]
    const task = currentBoard(run)!.tasks.find((t) => t.id === taskId)!
    agentTurn.running = false
    te.endedAt = this.host.now()
    if (r.ok) {
      let commit: string | null = null
      try {
        const msg = `cowork(${run.id}): ${task.id} ${task.title}${r.followUp ? ' (follow-up)' : ''}`
        commit = await commitAll(ex.worktrees[te.worktree].path, msg)
      } catch (e) {
        agentTurn.error = `Could not commit: ${(e as Error).message}`
        te.status = 'failed'
        te.error = agentTurn.error
        run.log.push({ t: 'task-failed', taskId, message: te.error, at: this.host.now() })
        this.host.save(run)
        this.schedule(run)
        return
      }
      if (commit) te.commits.push(commit)
      te.status = 'done'
      run.log.push({ t: 'task-done', taskId, commit, at: this.host.now() })
    } else {
      agentTurn.error = r.error
      te.status = r.cancelled ? 'cancelled' : 'failed'
      te.error = r.error
      if (!r.cancelled) run.log.push({ t: 'task-failed', taskId, message: r.error || 'failed', at: this.host.now() })
    }
    this.host.save(run)
    this.schedule(run)
  }

  // ── 收尾：整合成一條分支，給使用者看 diff ─────────────────────────────

  private finishing = new Set<string>()

  private async finish(run: CoworkRun): Promise<void> {
    const ex = run.execution!
    if (this.finishing.has(run.id) || (run.phase === 'review' && ex.integration)) return
    this.finishing.add(run.id)
    try {
      const board = currentBoard(run)!
      if (ex.mode === 'sequential') {
        const wt = ex.worktrees.main
        const head = (await git(wt.path, ['rev-parse', 'HEAD'])).trim()
        ex.integration = { status: 'ok', branch: wt.branch, worktree: 'main', commit: head, stat: await diffStat(wt.path, run.repo.baseCommit, head) }
      } else {
        // 同時模式：從基線開一條整合分支，依依賴順序 cherry-pick 每個任務的 commit
        const key = 'integration'
        const branch = `cowork/${run.id}/${key}`
        const dir = path.join(ex.root, key)
        if (ex.worktrees[key]) {
          await removeWorktrees(run.repo.root, path.join(ex.root, '__none__'), [dir]).catch(() => {})
          await git(run.repo.root, ['branch', '-D', branch]).catch(() => '')
        }
        await addWorktree(run.repo.root, dir, branch, run.repo.baseCommit)
        ex.worktrees[key] = { path: dir, branch }
        const order = topoOrder(board.tasks) || board.tasks.map((t) => t.id)
        const commits = order.flatMap((id) => ex.tasks[id].commits)
        const r = await cherryPickAll(dir, commits)
        if (!r.ok) {
          const owner = order.find((id) => ex.tasks[id].commits.includes(r.commit))
          ex.integration = { status: 'conflict', branch, worktree: key, message: `${owner || '?'} (${r.commit.slice(0, 10)}): ${r.message}` }
        } else {
          const head = (await git(dir, ['rev-parse', 'HEAD'])).trim()
          ex.integration = { status: 'ok', branch, worktree: key, commit: head, stat: await diffStat(dir, run.repo.baseCommit, head) }
        }
      }
    } catch (e) {
      ex.integration = { status: 'error', branch: '', message: (e as Error).message.slice(0, 500) }
    } finally {
      this.finishing.delete(run.id)
    }
    run.phase = 'review'
    run.log.push({ t: 'integrated', ok: ex.integration?.status === 'ok', message: ex.integration?.message || ex.integration?.branch || '', at: this.host.now() })
    this.host.save(run)
  }

  // ── 使用者操作 ─────────────────────────────────────────────────────

  /** 在 Cowork 裡對某個任務追問：接續同一個 session；沒有 session 就重新交辦並附上這段話 */
  async message(run: CoworkRun, taskId: string, text: string): Promise<void> {
    const ex = run.execution
    const te = ex?.tasks[taskId]
    const msg = text.trim()
    if (!ex || !te) throw new ExecError('task-not-found')
    if (!msg) throw new ExecError('empty-feedback')
    if (run.phase !== 'executing' && run.phase !== 'review') throw new ExecError('not-allowed')
    if (ex.cleaned) throw new ExecError('not-allowed', 'worktrees were cleaned up')
    if (te.status === 'running' || te.status === 'pending') throw new ExecError('busy')
    if (Object.values(ex.tasks).some((x) => x.status === 'running' && x.worktree === te.worktree)) throw new ExecError('busy')
    if (run.phase === 'review') run.phase = 'executing'
    void this.runTurn(run, taskId, { message: msg.slice(0, 20000) })
  }

  /** 失敗、卡住或被停掉的任務重新交辦（新的 session；worktree 裡已有的修改保留） */
  retry(run: CoworkRun, taskId: string): void {
    const ex = run.execution
    const te = ex?.tasks[taskId]
    if (!ex || !te) throw new ExecError('task-not-found')
    if (!['failed', 'blocked', 'cancelled'].includes(te.status)) throw new ExecError('not-allowed')
    te.status = 'pending'
    te.sessionId = undefined
    te.error = undefined
    if (run.phase === 'review') run.phase = 'executing'
    this.host.save(run)
    this.schedule(run)
  }

  /** 停止：終止還在跑的 agent，不再排新任務，等使用者繼續 */
  pause(run: CoworkRun, reason: 'user' | 'budget' | 'restart' = 'user'): void {
    const ex = run.execution
    if (!ex) throw new ExecError('not-allowed')
    ex.paused = true
    ex.pausedReason = reason
    for (const c of this.controllers.get(run.id) || []) c.abort()
    run.log.push({ t: 'exec-paused', reason, at: this.host.now() })
    this.host.save(run)
  }

  /** 繼續：被停掉的任務有 session 就接續，沒有就重新排 */
  resume(run: CoworkRun): void {
    const ex = run.execution
    if (!ex || !ex.paused) throw new ExecError('not-allowed')
    if (this.budgetLeft(run) <= 0) throw new ExecError('budget-exhausted')
    ex.paused = false
    ex.pausedReason = undefined
    run.log.push({ t: 'exec-resumed', at: this.host.now() })
    for (const [id, te] of Object.entries(ex.tasks)) {
      if (te.status !== 'cancelled') continue
      if (te.sessionId) {
        void this.runTurn(run, id, { message: 'You were interrupted. Continue the task from where you stopped, then reply as instructed before.' })
      } else {
        te.status = 'pending'
      }
    }
    this.host.save(run)
    this.schedule(run)
  }

  async merge(run: CoworkRun): Promise<void> {
    const ex = run.execution
    if (run.phase !== 'review' || !ex?.integration || ex.integration.status !== 'ok') throw new ExecError('not-allowed')
    const firstLine = run.prompt.split(/\r?\n/)[0].slice(0, 72)
    const r = await mergeBranch(run.repo.root, run.repo.sourceBranch, ex.integration.branch, `Merge Cowork ${run.id}: ${firstLine}`)
    if (!r.ok) throw new ExecError(`merge-${r.reason}`, r.message, { branch: run.repo.sourceBranch })
    ex.merged = { into: run.repo.sourceBranch, commit: r.commit, at: this.host.now() }
    run.phase = 'completed'
    run.log.push({ t: 'merged', into: run.repo.sourceBranch, commit: r.commit, at: this.host.now() })
    this.host.save(run)
  }

  /** 移除 worktree（分支保留，之後還能自己合併或查看） */
  async cleanup(run: CoworkRun): Promise<void> {
    const ex = run.execution
    if (!ex) throw new ExecError('not-allowed')
    if (Object.values(ex.tasks).some((t) => t.status === 'running')) throw new ExecError('busy')
    await removeWorktrees(run.repo.root, ex.root, Object.values(ex.worktrees).map((w) => w.path))
    ex.cleaned = true
    run.phase = 'completed'
    run.log.push({ t: 'cleaned', at: this.host.now() })
    this.host.save(run)
  }

  /** app 重啟後：還在跑的任務當成被中斷，整個執行先暫停，等使用者按繼續 */
  recover(run: CoworkRun): boolean {
    const ex = run.execution
    if (!ex || (run.phase !== 'executing' && run.phase !== 'review')) return false
    let changed = false
    for (const te of Object.values(ex.tasks)) {
      if (te.status !== 'running') continue
      te.status = 'cancelled'
      te.error = 'interrupted by app restart'
      for (const t of te.turns) if (t.running) t.running = false
      changed = true
    }
    if (ex.activeSince) {
      ex.msUsed += Math.max(0, run.updatedAt - ex.activeSince)
      ex.activeSince = null
      changed = true
    }
    if (changed && !ex.paused) {
      ex.paused = true
      ex.pausedReason = 'restart'
      run.log.push({ t: 'exec-paused', reason: 'restart', at: this.host.now() })
    }
    return changed
  }

  isRunning(run: CoworkRun): boolean {
    return (this.active.get(run.id) || 0) > 0
  }

  shutdown(): void {
    this.shuttingDown = true
    for (const set of this.controllers.values()) for (const c of set) c.abort()
  }

  // ── 執行時間：只算「有 agent 在跑」的區間 ─────────────────────────────

  private clockStart(run: CoworkRun): void {
    const ex = run.execution!
    const n = (this.active.get(run.id) || 0) + 1
    this.active.set(run.id, n)
    if (n === 1) {
      ex.activeSince = this.host.now()
      const t = setInterval(() => {
        if (this.budgetLeft(run) <= 0 && !ex.paused) this.pause(run, 'budget')
      }, 1000)
      t.unref?.()
      this.timers.set(run.id, t)
    }
  }

  private clockStop(run: CoworkRun): void {
    const ex = run.execution!
    const n = Math.max(0, (this.active.get(run.id) || 1) - 1)
    this.active.set(run.id, n)
    if (n === 0) {
      if (ex.activeSince) ex.msUsed += this.host.now() - ex.activeSince
      ex.activeSince = null
      const t = this.timers.get(run.id)
      if (t) clearInterval(t)
      this.timers.delete(run.id)
    }
  }

  private emitSoon(run: CoworkRun): void {
    const last = this.lastEmit.get(run.id) || 0
    if (this.host.now() - last < EMIT_MS) return
    this.lastEmit.set(run.id, this.host.now())
    this.host.emit(run)
  }
}

function addUsage(a: CallUsage | undefined, b: CallUsage): CallUsage {
  return {
    inputTokens: (a?.inputTokens || 0) + (b.inputTokens || 0),
    cachedInputTokens: (a?.cachedInputTokens || 0) + (b.cachedInputTokens || 0),
    outputTokens: (a?.outputTokens || 0) + (b.outputTokens || 0),
    costUsd: (a?.costUsd || 0) + (b.costUsd || 0) || undefined
  }
}

export type { CoworkTaskExec }
