// Cowork 的背景執行：開始執行的選項、每個任務的對話串（交辦、進度、回覆、追問）、收尾（合併／清理）。
// 執行在 main（src/main/cowork/executor.ts），這裡只顯示 run.execution 並送出使用者的操作。
import { useEffect, useRef, useState } from 'react'
import AgentMark from '@/components/AgentMark'
import {
  agentLabel,
  currentBoard,
  type CoworkExecMode,
  type CoworkResult,
  type CoworkRun,
  type CoworkTask,
  type CoworkTaskExec
} from '../../../../shared/cowork'

type T = (key: string, params?: Record<string, string | number>) => string
type Act = (p: Promise<CoworkResult<unknown>>) => Promise<boolean>

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 已核准、還沒開始執行：選依序或同時，然後在背景開始 */
export function ExecLauncher({ run, t, act, onChangePlan }: { run: CoworkRun; t: T; act: Act; onChangePlan: () => void }): JSX.Element {
  const [mode, setMode] = useState<CoworkExecMode>('sequential')
  const [linkDeps, setLinkDeps] = useState(true)
  const [bypass, setBypass] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const agents = [...new Set((currentBoard(run)?.tasks || []).map((x) => x.assignee))]

  useEffect(() => {
    window.api.cowork.bypass().then((r) => setBypass(r.ok ? r.data : null))
  }, [])

  const options: { id: CoworkExecMode; title: string; desc: string }[] = [
    { id: 'sequential', title: t('cowork.execSequential'), desc: t('cowork.execSequentialDesc') },
    { id: 'parallel', title: t('cowork.execParallel'), desc: t('cowork.execParallelDesc', { count: agents.length }) }
  ]

  return (
    <div className="cw-turn ok" role="status" tabIndex={-1}>
      <div className="cw-turn-title">✓ {t('cowork.approvedTitle', { rev: run.approvedPlanRevision ?? run.planRevision })}</div>
      <div className="cw-turn-desc">{t('cowork.execIntro')}</div>
      <div className="cw-exec-modes" role="radiogroup">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={mode === o.id}
            className={`cw-exec-mode ${mode === o.id ? 'on' : ''}`}
            onClick={() => setMode(o.id)}
          >
            <span className="cw-exec-mode-title">{o.title}</span>
            <span className="cw-exec-mode-desc">{o.desc}</span>
          </button>
        ))}
      </div>
      <label className="cw-exec-opt">
        <input type="checkbox" checked={linkDeps} onChange={(e) => setLinkDeps(e.target.checked)} />
        <span>{t('cowork.execLinkDeps')}</span>
      </label>
      <div className={`cw-exec-perm ${bypass ? 'bypass' : ''}`}>
        {bypass === null ? '' : bypass ? t('cowork.execBypassOn') : t('cowork.execBypassOff')}
      </div>
      <div className="cw-turn-actions">
        <button
          type="button"
          className="cw-btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await act(window.api.cowork.execStart(run.id, { mode, linkDeps }))
            setBusy(false)
          }}
        >
          {t('cowork.execStart')}
        </button>
        <button type="button" className="cw-btn" onClick={onChangePlan}>
          {t('cowork.changePlan')}
        </button>
      </div>
    </div>
  )
}

/** 時間軸上的執行區：每個任務一張卡，裡面是這個任務的對話串 */
export function ExecTasks({
  run,
  t,
  act,
  now,
  onFollowUp
}: {
  run: CoworkRun
  t: T
  act: Act
  now: number
  onFollowUp: (taskId: string) => void
}): JSX.Element | null {
  const ex = run.execution
  const board = currentBoard(run)
  if (!ex || !board) return null
  return (
    <div className="cw-exec-tasks">
      {board.tasks.map((task) =>
        ex.tasks[task.id] ? (
          <ExecTaskCard key={task.id} run={run} task={task} te={ex.tasks[task.id]} t={t} act={act} now={now} onFollowUp={onFollowUp} />
        ) : null
      )}
    </div>
  )
}

function ExecTaskCard({
  run,
  task,
  te,
  t,
  act,
  now,
  onFollowUp
}: {
  run: CoworkRun
  task: CoworkTask
  te: CoworkTaskExec
  t: T
  act: Act
  now: number
  onFollowUp: (taskId: string) => void
}): JSX.Element {
  const ex = run.execution!
  const wt = ex.worktrees[te.worktree]
  const canTalk = !ex.cleaned && (run.phase === 'executing' || run.phase === 'review')
  const canRetry = canTalk && ['failed', 'blocked', 'cancelled'].includes(te.status)
  return (
    <div className={`cw-msg agent cw-exec-task status-${te.status}`} data-agent={te.agent} data-tasks={task.id}>
      <div className="cw-msg-head">
        <AgentMark agent={te.agent} size={14} />
        <span className="cw-msg-who">{agentLabel(te.agent)}</span>
        <span className="cw-task-id">{task.id}</span>
        <span className="cw-exec-task-title">{task.title}</span>
        <span className={`cw-pill exec-${te.status}`}>{t(`cowork.task_${te.status}`)}</span>
      </div>
      {wt && (
        <div className="cw-exec-branch cw-muted">
          <code>{wt.branch}</code>
          {te.commits.length > 0 && <span>· {t('cowork.execCommits', { count: te.commits.length })}</span>}
          {te.usage?.costUsd ? <span>· ${te.usage.costUsd.toFixed(2)}</span> : null}
        </div>
      )}
      <div className="cw-exec-turns">
        {te.turns.map((turn, i) =>
          turn.role === 'cowork' ? (
            <details key={i} className="cw-answers">
              <summary>{t('cowork.execBrief')}</summary>
              <div className="pre cw-exec-brief">{turn.text}</div>
            </details>
          ) : turn.role === 'user' ? (
            <div key={i} className="cw-exec-user">
              <span className="cw-you-dot" aria-hidden />
              <span className="pre">{turn.text}</span>
            </div>
          ) : (
            <AgentTurn key={i} turn={turn} t={t} now={now} startedAt={te.startedAt} />
          )
        )}
      </div>
      {te.status === 'pending' && <div className="cw-muted small">{t('cowork.execWaiting', { deps: task.dependsOn.join(', ') || '—' })}</div>}
      {(canTalk || canRetry) && te.status !== 'running' && te.status !== 'pending' && (
        <div className="cw-task-actions">
          {canTalk && te.status !== 'blocked' && (
            <button type="button" className="cw-btn sm" onClick={() => onFollowUp(task.id)}>
              {t('cowork.execFollowUp')}
            </button>
          )}
          {canRetry && (
            <button type="button" className="cw-btn sm" onClick={() => act(window.api.cowork.execRetry(run.id, task.id))}>
              {t('cowork.execRetry')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AgentTurn({
  turn,
  t,
  now,
  startedAt
}: {
  turn: CoworkTaskExec['turns'][number]
  t: T
  now: number
  startedAt?: number
}): JSX.Element {
  const [allSteps, setAllSteps] = useState(false)
  const steps = turn.progress || []
  const shown = allSteps ? steps : steps.slice(-5)
  return (
    <div className="cw-exec-agent">
      {steps.length > 0 && (
        <div className="cw-exec-steps">
          {steps.length > shown.length && (
            <button type="button" className="cw-disclosure" onClick={() => setAllSteps(true)}>
              {t('cowork.execMoreSteps', { count: steps.length - shown.length })}
            </button>
          )}
          {shown.map((s, i) => (
            <div key={i} className="cw-exec-step">
              {s}
            </div>
          ))}
        </div>
      )}
      {turn.running && (
        <div className="cw-person-status thinking">
          <span className="cw-dots" aria-hidden />
          {t('cowork.execWorking', { elapsed: mmss(now - (startedAt || turn.at)) })}
        </div>
      )}
      {turn.text && <div className="pre cw-exec-reply">{turn.text}</div>}
      {turn.error && turn.error !== 'stopped' && <div className="cw-sys error">{turn.error}</div>}
    </div>
  )
}

/** 執行中與收尾階段的「輪到你」卡：停止／繼續、整合結果、合併、清理 */
export function ExecTurnCard({ run, t, act }: { run: CoworkRun; t: T; act: Act }): JSX.Element | null {
  const ex = run.execution
  const ref = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (run.phase === 'review') ref.current?.focus()
  }, [run.phase])
  if (!ex) return null
  const tasks = Object.values(ex.tasks)
  const done = tasks.filter((x) => x.status === 'done').length
  const stuck = tasks.filter((x) => ['failed', 'blocked', 'cancelled'].includes(x.status)).length
  const running = tasks.some((x) => x.status === 'running')
  const run1 = async (p: Promise<CoworkResult<unknown>>): Promise<void> => {
    setBusy(true)
    await act(p)
    setBusy(false)
  }
  const cleanupBtn = !ex.cleaned && (
    <button
      type="button"
      className="cw-btn danger"
      disabled={busy || running}
      onClick={() => window.confirm(t('cowork.execConfirmCleanup')) && run1(window.api.cowork.execCleanup(run.id))}
    >
      {t('cowork.execCleanup')}
    </button>
  )

  if (run.phase === 'executing') {
    return (
      <div className={`cw-turn ${ex.paused || (!running && stuck) ? 'warn' : ''}`} role="status" ref={ref} tabIndex={-1}>
        <div className="cw-turn-title">
          {ex.paused ? t(`cowork.execPaused_${ex.pausedReason || 'user'}`) : t('cowork.execProgress', { done, total: tasks.length })}
        </div>
        {!ex.paused && !running && stuck > 0 && <div className="cw-turn-desc">{t('cowork.execStuck')}</div>}
        <div className="cw-turn-actions">
          {ex.paused ? (
            <button type="button" className="cw-btn primary" disabled={busy} onClick={() => run1(window.api.cowork.execResume(run.id))}>
              {t('cowork.execResume')}
            </button>
          ) : (
            running && (
              <button type="button" className="cw-btn" disabled={busy} onClick={() => run1(window.api.cowork.execPause(run.id))}>
                {t('cowork.execPause')}
              </button>
            )
          )}
          {!running && cleanupBtn}
        </div>
      </div>
    )
  }

  if (run.phase === 'review') {
    const it = ex.integration
    const ok = it?.status === 'ok'
    return (
      <div className={`cw-turn ${ok ? '' : 'warn'}`} role="status" ref={ref} tabIndex={-1}>
        <div className="cw-turn-title">{ok ? t('cowork.execReviewTitle', { count: tasks.length }) : t(`cowork.execIntegration_${it?.status || 'error'}`)}</div>
        {it?.branch && (
          <div className="cw-turn-desc">
            {t('cowork.execBranch')} <code>{it.branch}</code>
          </div>
        )}
        {ok && it?.stat && <pre className="cw-exec-stat">{it.stat}</pre>}
        {!ok && it?.message && <div className="cw-turn-detail">{it.message}</div>}
        <div className="cw-turn-actions">
          {ok && (
            <button type="button" className="cw-btn primary" disabled={busy} onClick={() => run1(window.api.cowork.execMerge(run.id))}>
              {t('cowork.execMerge', { branch: run.repo.sourceBranch })}
            </button>
          )}
          {cleanupBtn}
        </div>
      </div>
    )
  }

  if (run.phase === 'completed') {
    return (
      <div className="cw-turn ok" role="status" ref={ref} tabIndex={-1}>
        <div className="cw-turn-title">
          ✓ {ex.merged ? t('cowork.execMerged', { branch: ex.merged.into, commit: ex.merged.commit.slice(0, 7) }) : t('cowork.execDone')}
        </div>
        {ex.cleaned ? (
          <div className="cw-turn-desc">{t('cowork.execCleanedDesc')}</div>
        ) : (
          <div className="cw-turn-actions">{cleanupBtn}</div>
        )}
      </div>
    )
  }
  return null
}

/** 執行階段的輸入框：對某個任務追問（接續同一個 session） */
export function ExecComposer({
  run,
  t,
  act,
  target,
  onTarget,
  inputRef
}: {
  run: CoworkRun
  t: T
  act: Act
  target: string | null
  onTarget: (id: string) => void
  inputRef: React.RefObject<HTMLTextAreaElement>
}): JSX.Element | null {
  const [text, setText] = useState('')
  const ex = run.execution
  const board = currentBoard(run)
  if (!ex || !board || ex.cleaned || (run.phase !== 'executing' && run.phase !== 'review')) return null
  const talkable = board.tasks.filter((x) => ex.tasks[x.id] && !['pending', 'running', 'blocked'].includes(ex.tasks[x.id].status))
  if (!talkable.length) return null
  const sel = target && talkable.some((x) => x.id === target) ? target : talkable[talkable.length - 1].id
  const send = async (): Promise<void> => {
    const v = text.trim()
    if (!v) return
    if (await act(window.api.cowork.execMessage(run.id, sel, v))) setText('')
  }
  return (
    <div className="cw-composer">
      <select className="cw-select cw-exec-target" value={sel} onChange={(e) => onTarget(e.target.value)} title={t('cowork.execTarget')}>
        {talkable.map((x) => (
          <option key={x.id} value={x.id}>
            {x.id} · {agentLabel(ex.tasks[x.id].agent)}
          </option>
        ))}
      </select>
      <textarea
        ref={inputRef}
        className="cw-textarea"
        rows={1}
        value={text}
        placeholder={t('cowork.execPlaceholder', { agent: agentLabel(ex.tasks[sel].agent) })}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <button type="button" className="cw-btn primary" onClick={send} disabled={!text.trim()}>
        {t('cowork.execSend')}
      </button>
    </div>
  )
}
