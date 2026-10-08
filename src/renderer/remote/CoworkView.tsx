import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  agentLabel,
  currentBoard,
  reviewersOf,
  type CoworkAgent,
  type CoworkCapability,
  type CoworkBaselineInfo,
  type CoworkMode,
  type CoworkPhase,
  type CoworkRun,
  type CoworkRunSummary
} from '../../shared/cowork'
import type { RemoteConnection } from './conn'
import { AgentMark, IArrowUp, IPlus, IWarning } from './icons'
import { ago, coworkLanguage, t, type Key } from './i18n'
import { ConfirmSheet, NavBar } from './ui'

// 手機版 Cowork：清單、開新會議、看會議進度、在每個階段做桌面上同樣的決定。
// 所有操作都經 conn.cowork 打到桌面同一份 ops（main/ipc/cowork.ts），手機不自己判斷能不能做，
// 桌面拒絕就把錯誤碼顯示出來。編輯任務板與選模型仍只在桌面（cwDesktopOnly）。

type Caps = { agents: CoworkCapability[]; baseline: CoworkBaselineInfo; defaults?: { chair: CoworkAgent | null; participants: CoworkAgent[] } }

const phaseText = (p: CoworkPhase): string => t(`cwPhase_${p}` as Key)
const phaseTone = (p: CoworkPhase): string =>
  p === 'failed' ? 'danger' : ['awaiting-approval', 'blocked', 'paused', 'review'].includes(p) ? 'wait' : ['meeting', 'executing'].includes(p) ? 'run' : 'idle'

function PhasePill({ phase }: { phase: CoworkPhase }): JSX.Element {
  return (
    <span className={`pill ${phaseTone(phase)}`}>
      <span className="dot" aria-hidden="true" />
      {phaseText(phase)}
    </span>
  )
}

const Md = ({ text }: { text: string }): JSX.Element => (
  <div className="markdown cw-md">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
  </div>
)

export default function CoworkView({
  conn,
  windowId,
  workspace,
  hostName,
  onBack
}: {
  conn: RemoteConnection
  windowId: number
  workspace: string
  hostName: string
  onBack: () => void
}): JSX.Element {
  const [runs, setRuns] = useState<CoworkRunSummary[] | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<CoworkRun | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runIdRef = useRef(runId)
  runIdRef.current = runId

  const call = async <T,>(op: string, ...args: unknown[]): Promise<T | undefined> => {
    setError(null)
    const r = await conn.cowork<T>(windowId, op, ...args)
    if (r.ok) return r.data
    setError(r.message || r.code)
    return undefined
  }

  useEffect(() => {
    const load = (): void => {
      void conn.cowork<CoworkRunSummary[]>(windowId, 'list').then((r) => r.ok && setRuns(r.data))
      const id = runIdRef.current
      if (id) void conn.cowork<CoworkRun | null>(windowId, 'get', id).then((r) => r.ok && runIdRef.current === id && setRun(r.data))
    }
    const off = conn.onMessage((m) => {
      if (m.t !== 'coworkRun') return
      if (m.run.id === runIdRef.current) setRun(m.run)
      setRuns((prev) => prev && prev.map((x) => (x.id === m.run.id ? { ...x, phase: m.run.phase, updatedAt: m.run.updatedAt } : x)))
    })
    const offState = conn.onState((s) => s === 'open' && load())
    load()
    return () => {
      off()
      offState()
    }
  }, [conn, windowId])

  const open = (id: string | null): void => {
    setRun(null)
    setRunId(id)
    setError(null)
    if (id) void call<CoworkRun | null>('get', id).then((r) => r !== undefined && runIdRef.current === id && setRun(r))
  }

  if (creating) {
    return (
      <NewMeeting
        conn={conn}
        windowId={windowId}
        workspace={workspace}
        onBack={() => setCreating(false)}
        onStarted={(r) => {
          setCreating(false)
          setRuns((prev) => [{ id: r.id, prompt: r.prompt, phase: r.phase, createdAt: r.createdAt, updatedAt: r.updatedAt, planRevision: r.planRevision, chair: r.chair, participants: r.participants }, ...(prev || [])])
          setRunId(r.id)
          setRun(r)
        }}
      />
    )
  }

  if (runId) {
    return (
      <div className="session">
        <NavBar title={t('cowork')} subtitle={workspace} backLabel={t('cowork')} onBack={() => open(null)} />
        {run ? <RunScreen run={run} call={call} error={error} /> : <p className="empty">{t('loading')}</p>}
      </div>
    )
  }

  return (
    <div className="session">
      <NavBar title={t('cowork')} subtitle={workspace} backLabel={hostName} onBack={onBack} />
      <main className="workspace-pane">
        <div className="stack">
          <button className="add-card press" onClick={() => setCreating(true)}>
            <IPlus size={20} />
            {t('cwNew')}
          </button>
          {runs === null ? (
            <p className="empty">{t('loading')}</p>
          ) : runs.length === 0 ? (
            <p className="empty">{t('cwNone')}</p>
          ) : (
            runs.map((r) => (
              <button key={r.id} className="bubble session-card press" onClick={() => open(r.id)}>
                <AgentMark launcherKey={r.chair} />
                <span className="card-main">
                  <span className="card-title">{r.prompt}</span>
                  <span className="card-sub">{ago(r.updatedAt)}</span>
                </span>
                <PhasePill phase={r.phase} />
              </button>
            ))
          )}
        </div>
        {error && <p className="form-error" role="alert"><IWarning size={18} />{error}</p>}
      </main>
    </div>
  )
}

function NewMeeting({
  conn,
  windowId,
  workspace,
  onBack,
  onStarted
}: {
  conn: RemoteConnection
  windowId: number
  workspace: string
  onBack: () => void
  onStarted: (r: CoworkRun) => void
}): JSX.Element {
  const [caps, setCaps] = useState<Caps | null>(null)
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<CoworkMode>('discussion')
  const [picked, setPicked] = useState<CoworkAgent[]>([])
  const [chair, setChair] = useState<CoworkAgent | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void conn.cowork<Caps>(windowId, 'capabilities').then((r) => {
      if (!r.ok) return setError(r.message || r.code)
      setCaps(r.data)
      const usable = r.data.agents.filter((a) => a.enabled && a.planning).map((a) => a.agent)
      // 預設：桌面記住的與會者（還能用的），不夠兩位就補
      const p = (r.data.defaults?.participants || []).filter((a) => usable.includes(a))
      for (const a of usable) if (p.length < 2 && !p.includes(a)) p.push(a)
      setPicked(p)
      const c = r.data.defaults?.chair
      setChair(c && p.includes(c) ? c : p[0] || null)
    })
  }, [conn, windowId])

  const toggle = (a: CoworkAgent): void => {
    const next = picked.includes(a) ? picked.filter((x) => x !== a) : [...picked, a]
    setPicked(next)
    if (!chair || !next.includes(chair)) setChair(next[0] || null)
  }
  const repoOk = caps?.baseline.ok === true
  const canStart = !!prompt.trim() && prompt.length <= 20000 && picked.length >= 2 && !!chair && (mode === 'discussion' || repoOk) && !busy

  const start = async (): Promise<void> => {
    if (!canStart) return
    setBusy(true)
    setError(null)
    const r = await conn.cowork<CoworkRun>(windowId, 'start', { prompt: prompt.trim(), chair, participants: picked, language: coworkLanguage(), mode })
    setBusy(false)
    if (r.ok) onStarted(r.data)
    else setError(r.message || r.code)
  }

  return (
    <div className="session">
      <NavBar title={t('cwNew')} subtitle={workspace} backLabel={t('cowork')} onBack={onBack} />
      <main className="workspace-pane">
        <div className="segmented" style={{ ['--seg' as string]: 2 }} data-index={mode === 'project' ? 1 : 0}>
          <button aria-pressed={mode === 'discussion'} onClick={() => setMode('discussion')}>{t('cwModeDiscussion')}</button>
          <button aria-pressed={mode === 'project'} onClick={() => setMode('project')}>{t('cwModeProject')}</button>
        </div>
        <div className="bubble form-card">
          <div className="field">
            <textarea className="cw-input" rows={5} maxLength={20000} value={prompt} placeholder={t('cwPrompt')} aria-label={t('cwPrompt')} onChange={(e) => setPrompt(e.target.value)} />
          </div>
        </div>
        <div className="section-head"><h2>{t('cwParticipants')}</h2></div>
        <div className="stack">
          {(caps?.agents || []).map((c) => {
            const usable = c.enabled && c.planning
            return (
              <div key={c.agent} className="bubble session-card">
                <button className="cw-agent press" disabled={!usable} aria-pressed={picked.includes(c.agent)} onClick={() => toggle(c.agent)}>
                  <AgentMark launcherKey={c.agent} />
                  <span className="card-main">
                    <span className="card-title">{agentLabel(c.agent)}</span>
                    <span className="card-sub">{usable ? (picked.includes(c.agent) ? '✓' : '') : t('cwUnavailable')}</span>
                  </span>
                </button>
                {picked.includes(c.agent) && (
                  <button className={`pill ${chair === c.agent ? 'run' : 'idle'} press`} aria-pressed={chair === c.agent} onClick={() => setChair(c.agent)}>
                    {t('cwChair')}
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {mode === 'project' && caps && !repoOk && <p className="form-error" role="alert"><IWarning size={18} />{t('cwNeedRepo')}</p>}
        {error && <p className="form-error" role="alert"><IWarning size={18} />{error}</p>}
        <p className="footnote">{t('cwDesktopOnly')}</p>
        <button className="btn prominent press" disabled={!canStart} onClick={start}>{t('cwStart')}</button>
      </main>
    </div>
  )
}

type Call = <T>(op: string, ...args: unknown[]) => Promise<T | undefined>

function RunScreen({ run, call, error }: { run: CoworkRun; call: Call; error: string | null }): JSX.Element {
  const [text, setText] = useState('')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [busy, setBusy] = useState(false)
  const d = run.discussion
  const board = currentBoard(run)
  const ex = run.execution
  const act = async (op: string, ...args: unknown[]): Promise<boolean> => {
    setBusy(true)
    const ok = (await call(op, run.id, ...args)) !== undefined
    setBusy(false)
    return ok
  }

  // 輸入框：跟桌面同樣依階段決定送到哪裡
  const talkable = ex && board && !ex.cleaned && ['executing', 'review'].includes(run.phase)
    ? board.tasks.filter((x) => ex.tasks[x.id] && !['pending', 'running', 'blocked'].includes(ex.tasks[x.id].status))
    : []
  const composer: { placeholder: string; send: (v: string) => Promise<boolean> } | null = d
    ? run.phase === 'completed' ? { placeholder: t('cwFollowUp'), send: (v) => act('discuss', v) } : null
    : talkable.length
      ? { placeholder: t('cwAskTask', { task: talkable[talkable.length - 1].id }), send: (v) => act('execMessage', talkable[talkable.length - 1].id, v) }
      : run.phase === 'meeting' || run.phase === 'paused' || (run.phase === 'blocked' && run.block?.kind !== 'unresolved')
        ? { placeholder: t('cwNote'), send: (v) => act('note', v) }
        : run.phase === 'awaiting-approval' || run.phase === 'approved' || (run.phase === 'blocked' && run.block?.kind === 'unresolved')
          ? { placeholder: t('cwFeedback'), send: (v) => act('feedback', v) }
          : null
  const submit = async (): Promise<void> => {
    const v = text.trim()
    if (v && composer && (await composer.send(v))) setText('')
  }

  const speaker = d && (run.pending?.step === 'summary' ? d.summarizer || run.chair : run.pending?.step === 'conclusion' ? run.chair : d.order[d.cursor])
  const kind = run.block?.kind || 'step-failed'
  const canCancel = ['meeting', 'awaiting-approval', 'blocked', 'paused'].includes(run.phase)

  const actions: JSX.Element[] = []
  const btn = (label: string, onClick: () => void, prominent = false): void => {
    actions.push(<button key={label} className={`btn ${prominent ? 'prominent' : ''} press`} disabled={busy} onClick={onClick}>{label}</button>)
  }
  if (d && run.phase === 'completed') {
    if (d.summaries?.at(-1)?.through !== d.messages.length) btn(t('cwSummarize'), () => act('summarize'))
    if (d.conclusion?.through !== d.messages.length) btn(t('cwConclude'), () => act('summarize', true), true)
  }
  if (run.phase === 'awaiting-approval') btn(t('cwApprove', { rev: run.planRevision }), () => act('approve', run.planRevision), true)
  if (run.phase === 'blocked' || run.phase === 'paused') {
    if (kind === 'unresolved') btn(t('cwSetAside'), () => act('dismiss'))
    else if (kind === 'budget')
      btn(t('cwRaiseRetry'), async () => {
        const more = { maxPlanningCalls: run.limits.maxPlanningCalls + 3, maxPlanningMinutes: run.limits.maxPlanningMinutes + 5 }
        if (await act('raiseLimits', more)) await act('retry')
      }, true)
    else btn(t('cwRetry'), () => act('retry'), true)
    if (kind === 'reviewers-failed' && reviewersOf(run).some((a) => run.reviewers[a]?.status === 'ok')) btn(t('cwContinueWithout'), () => act('drop'))
  }
  if (run.phase === 'approved' && !ex) {
    btn(t('cwExecSeq'), () => act('execStart', { mode: 'sequential' }), true)
    btn(t('cwExecPar'), () => act('execStart', { mode: 'parallel' }))
  }
  if (run.phase === 'executing' && ex) btn(ex.paused ? t('cwResume') : t('cwPause'), () => act(ex.paused ? 'execResume' : 'execPause'), ex.paused)
  if (run.phase === 'review' && ex?.integration?.status === 'ok') btn(t('cwMerge', { branch: run.repo.sourceBranch }), () => act('execMerge'), true)
  if ((run.phase === 'review' || run.phase === 'completed') && ex && !ex.cleaned) btn(t('cwCleanup'), () => act('execCleanup'))
  if (canCancel) actions.push(<button key="cancel" className="text-btn press" disabled={busy} onClick={() => setConfirmCancel(true)}>{t('cwCancel')}</button>)

  return (
    <>
      <main className="workspace-pane">
        <section className="bubble cw-card">
          <div className="cw-head">
            <PhasePill phase={run.phase} />
            <span className="t-foot">{ago(run.updatedAt)}</span>
          </div>
          <p className="cw-prompt">{run.prompt}</p>
        </section>

        {d?.messages.map((m) => (
          <article key={m.id} className={`bubble cw-card ${m.agent ? '' : 'cw-user'}`}>
            <div className="cw-head">
              {m.agent && <AgentMark launcherKey={m.agent} size={28} />}
              <b>{m.agent ? agentLabel(m.agent) : t('cwYou')}</b>
            </div>
            <Md text={m.message} />
          </article>
        ))}
        {d?.summaries?.length ? (
          <article className="bubble cw-card"><b>{t('cwSummary')}</b><Md text={d.summaries[d.summaries.length - 1].summary} /></article>
        ) : null}
        {d?.conclusion && <article className="bubble cw-card"><b>{t('cwConclusion')}</b><Md text={d.conclusion.message} /></article>}

        {!d && run.r1 && <article className="bubble cw-card"><b>{agentLabel(run.chair)}</b><Md text={run.r1.summary} /></article>}
        {!d && board && (
          <>
            <div className="section-head"><h2>{t('cwBoard', { rev: board.planRevision })}</h2></div>
            <div className="stack">
              {board.tasks.map((task) => {
                const te = ex?.tasks[task.id]
                const last = te?.turns.filter((x) => x.role === 'agent').at(-1)
                return (
                  <details key={task.id} className="bubble cw-card">
                    <summary className="cw-head">
                      <AgentMark launcherKey={task.assignee} size={28} />
                      <span className="card-main"><span className="card-title">{task.id} · {task.title}</span></span>
                      {te && <span className={`pill ${te.status === 'done' ? 'run' : te.status === 'failed' ? 'danger' : 'idle'}`}>{te.status}</span>}
                    </summary>
                    <Md text={task.detail} />
                    {last && <Md text={last.error || last.text} />}
                    {te?.status === 'failed' && <button className="text-btn press" disabled={busy} onClick={() => act('execRetry', task.id)}>{t('cwRetry')}</button>}
                  </details>
                )
              })}
            </div>
            {board.unresolved.length > 0 && (
              <article className="bubble cw-card">
                <b>{t('cwUnresolved')}</b>
                <ul>{board.unresolved.map((u) => <li key={u.issueId}>{u.text}</li>)}</ul>
              </article>
            )}
          </>
        )}
        {ex?.integration?.stat && <pre className="bubble cw-card cw-pre">{ex.integration.stat}</pre>}

        {run.phase === 'meeting' && <p className="footnote" role="status">{speaker ? t('cwSpeaking', { name: agentLabel(speaker) }) : t('cwPlanning')}</p>}
        {run.block && (run.phase === 'blocked' || run.phase === 'paused') && (
          <p className="form-error" role="alert"><IWarning size={18} />{run.block.message}</p>
        )}
        {ex?.integration?.message && ex.integration.status !== 'ok' && <p className="form-error" role="alert"><IWarning size={18} />{ex.integration.message}</p>}
        {error && <p className="form-error" role="alert"><IWarning size={18} />{error}</p>}
      </main>

      {(actions.length > 0 || composer) && (
        <div className="dock">
          <div className="dock-inner">
            {actions.length > 0 && <div className="cw-actions">{actions}</div>}
            {composer && (
              <form className="composer" onSubmit={(e) => { e.preventDefault(); void submit() }}>
                <textarea
                  value={text}
                  rows={1}
                  maxLength={12000}
                  aria-label={composer.placeholder}
                  placeholder={composer.placeholder}
                  enterKeyHint="send"
                  onChange={(e) => {
                    setText(e.target.value)
                    e.target.style.height = 'auto'
                    e.target.style.height = `${e.target.scrollHeight}px`
                  }}
                />
                <button type="submit" className="send press" aria-label={t('send')} disabled={busy || !text.trim()}>
                  <IArrowUp size={20} />
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {confirmCancel && (
        <ConfirmSheet
          title={t('cwCancel')}
          message={t('cwCancelBody')}
          action={t('cwCancel')}
          onCancel={() => setConfirmCancel(false)}
          onConfirm={() => {
            setConfirmCancel(false)
            void act('cancel')
          }}
        />
      )}
    </>
  )
}
