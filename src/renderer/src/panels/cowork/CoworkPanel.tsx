// Cowork 面板：開會表單、與會者列、會議時間軸、「輪到你」卡片、任務板。
// 會議邏輯全在 main（src/main/cowork/），這裡只顯示 run 並送出使用者的決定。
// 呈現原則見 cowork.md §6.2–6.3：R2 並排、協議進度看得見、不鏡像終端、不做擬真會議室。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import AgentMark from '@/components/AgentMark'
import { IconChevronDown, IconClose, IconCowork, IconPlus, IconTrash } from '@/components/Icons'
import { useWorkbench, openSettings } from '@/store'
import { useTranslation } from '@/i18n'
import {
  COWORK_AGENTS,
  COWORK_TERMINAL_PHASES,
  agentLabel,
  assignableAgents,
  collectIssues,
  currentBoard,
  planningMsUsed,
  reviewersOf,
  sanitizeCoworkSettings,
  taskDispatchText,
  type CoworkAgent,
  type CoworkBaselineInfo,
  type CoworkBoard,
  type CoworkCapability,
  type CoworkIssue,
  type CoworkLogEntry,
  type CoworkResult,
  type CoworkRun,
  type CoworkRunSummary,
  type CoworkTask
} from '../../../../shared/cowork'
import './cowork.css'

export interface CoworkSessionRef {
  id: string
  title: string
  launcherKey: string
  isExited: boolean
  needsApproval: boolean
}

interface CoworkPanelProps {
  sessions: CoworkSessionRef[]
  /** 把文字貼進終端（不送 Enter）並切過去；fresh = 剛開的終端，要等 CLI 啟動完成再貼 */
  onPaste: (sessionId: string, text: string, fresh?: boolean) => void
  /** 開一個新的 agent 終端，回傳 session id */
  onOpenAgent: (agent: CoworkAgent) => string
  onClose: () => void
  /** 目前顯示的 run 狀態變了（給分頁上的狀態點用） */
  onPhase?: (phase: CoworkRun['phase'] | null) => void
}

type T = (key: string, params?: Record<string, string | number>) => string
type Highlight = { task?: string; issue?: string } | null

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** IPC 結果轉成可顯示的錯誤字串；成功回 null */
function errorText<X>(t: T, r: CoworkResult<X>): string | null {
  if (r.ok) return null
  const key = `cowork.err_${r.code}`
  const msg = t(key, { message: r.message || r.code })
  return msg === key ? t('cowork.err_internal', { message: r.message || r.code }) : msg
}

export default function CoworkPanel({ sessions, onPaste, onOpenAgent, onClose, onPhase }: CoworkPanelProps): JSX.Element {
  const { t } = useTranslation()
  const { workspaceRoot } = useWorkbench()
  const [runs, setRuns] = useState<CoworkRunSummary[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<CoworkRun | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const runIdRef = useRef<string | null>(null)
  runIdRef.current = runId

  const refreshList = useCallback(async () => {
    const r = await window.api.cowork.list()
    if (r.ok) setRuns(r.data)
    return r.ok ? r.data : []
  }, [])

  // 換工作區：重抓清單，預設打開最新一場還沒結束的會議
  useEffect(() => {
    let alive = true
    refreshList().then((list) => {
      if (!alive) return
      // 進行中的優先；否則最近一場若已核准也打開（P1 核准後正是要派送任務的時候）
      const open = list.find((x) => !COWORK_TERMINAL_PHASES.includes(x.phase)) || (list[0]?.phase === 'approved' ? list[0] : undefined)
      setRunId(open ? open.id : null)
    })
    return () => {
      alive = false
    }
  }, [workspaceRoot, refreshList])

  useEffect(() => {
    if (!runId) {
      setRun(null)
      return
    }
    window.api.cowork.get(runId).then((r) => {
      if (r.ok && runIdRef.current === runId) setRun(r.data)
    })
  }, [runId])

  useEffect(
    () =>
      window.api.cowork.onUpdate((r) => {
        if (r.id === runIdRef.current) setRun(r)
        setRuns((prev) => {
          const i = prev.findIndex((x) => x.id === r.id)
          if (i < 0) return prev
          const next = [...prev]
          next[i] = { ...next[i], phase: r.phase, planRevision: r.planRevision, updatedAt: r.updatedAt }
          return next
        })
      }),
    []
  )

  useEffect(() => onPhase?.(run?.phase ?? null), [run?.phase, onPhase])

  const openRun = (id: string | null): void => {
    setRunId(id)
    setPickerOpen(false)
  }

  const deleteRun = async (): Promise<void> => {
    if (!run || !window.confirm(t('cowork.confirmDelete'))) return
    const r = await window.api.cowork.delete(run.id)
    if (r.ok) {
      await refreshList()
      openRun(null)
    } else window.alert(errorText(t, r))
  }

  return (
    <div className="cw-root">
      <div className="cw-topbar">
        <div className="cw-topbar-left">
          <IconCowork size={14} className="cw-topbar-icon" />
          <span className="cw-topbar-title">{t('cowork.title')}</span>
          <div className="cw-picker">
            <button type="button" className="cw-picker-btn" onClick={() => setPickerOpen((v) => !v)} aria-expanded={pickerOpen}>
              <span className="cw-picker-label">{run ? run.prompt : t('cowork.newMeeting')}</span>
              {run && <PhasePill phase={run.phase} t={t} />}
              <IconChevronDown size={9} />
            </button>
            {pickerOpen && (
              <>
                <div className="cw-popover-backdrop" onClick={() => setPickerOpen(false)} />
                <div className="cw-popover cw-picker-menu" role="menu">
                  <button type="button" className="cw-menu-item cw-menu-new" onClick={() => openRun(null)}>
                    <IconPlus size={12} />
                    <span>{t('cowork.newMeeting')}</span>
                  </button>
                  {runs.length === 0 && <div className="cw-menu-empty">{t('cowork.noMeetings')}</div>}
                  {runs.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={`cw-menu-item ${r.id === runId ? 'on' : ''}`}
                      onClick={() => openRun(r.id)}
                    >
                      <span className="cw-menu-prompt">{r.prompt}</span>
                      <PhasePill phase={r.phase} t={t} />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="cw-topbar-actions">
          {run && run.phase !== 'meeting' && (
            <button type="button" className="term-btn-icon" title={t('cowork.deleteMeeting')} onClick={deleteRun}>
              <IconTrash size={13} />
            </button>
          )}
          <button type="button" className="term-btn-icon" title={t('cowork.close')} onClick={onClose}>
            <IconClose size={12} />
          </button>
        </div>
      </div>

      {run ? (
        <RunView run={run} t={t} sessions={sessions} onPaste={onPaste} onOpenAgent={onOpenAgent} />
      ) : (
        <StartForm
          t={t}
          onStarted={async (r) => {
            await refreshList()
            setRunId(r.id)
            setRun(r)
          }}
          onOpenRun={(id) => openRun(id)}
        />
      )}
    </div>
  )
}

function PhasePill({ phase, t }: { phase: CoworkRun['phase']; t: T }): JSX.Element {
  return <span className={`cw-pill phase-${phase}`}>{t(`cowork.phase_${phase}`)}</span>
}

// ── 開會表單 ────────────────────────────────────────────────────────

function StartForm({
  t,
  onStarted,
  onOpenRun
}: {
  t: T
  onStarted: (run: CoworkRun) => void
  onOpenRun: (id: string) => void
}): JSX.Element {
  const { language, editorDirtyPaths, workspaceRoot, settingsTick } = useWorkbench()
  const [caps, setCaps] = useState<CoworkCapability[] | null>(null)
  const [baseline, setBaseline] = useState<CoworkBaselineInfo | null>(null)
  const [limits, setLimits] = useState({ calls: 6, minutes: 10 })
  const [prompt, setPrompt] = useState('')
  const [picked, setPicked] = useState<CoworkAgent[]>([])
  const [chair, setChair] = useState<CoworkAgent | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; runId?: string } | null>(null)
  const [showDirty, setShowDirty] = useState(false)

  useEffect(() => {
    let alive = true
    Promise.all([window.api.cowork.capabilities(), window.api.settings.get()]).then(([c, s]) => {
      if (!alive || !c.ok) return
      const cw = sanitizeCoworkSettings(s.cowork)
      setCaps(c.data.agents)
      setBaseline(c.data.baseline)
      setLimits({ calls: cw.limits.maxPlanningCalls, minutes: cw.limits.maxPlanningMinutes })
      const usable = c.data.agents.filter((a) => a.enabled && a.planning).map((a) => a.agent)
      // 預設：上次選的與會者（還能用的）；不夠兩位就補上能用的
      let p = cw.participants.filter((a) => usable.includes(a))
      for (const a of usable) if (p.length < 2 && !p.includes(a)) p.push(a)
      p = p.slice(0, Math.max(2, p.length))
      setPicked(p)
      setChair(cw.chair && p.includes(cw.chair) ? cw.chair : p[0] || null)
    })
    return () => {
      alive = false
    }
  }, [workspaceRoot, settingsTick])

  const usable = (a: CoworkAgent): boolean => !!caps?.find((c) => c.agent === a && c.enabled && c.planning)
  const toggle = (a: CoworkAgent): void => {
    if (!usable(a)) return
    setPicked((prev) => {
      const next = prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]
      if (chair && !next.includes(chair)) setChair(next[0] || null)
      if (!chair && next.length) setChair(next[0])
      return next
    })
  }
  const canStart = !!prompt.trim() && picked.length >= 2 && !!chair && picked.includes(chair) && baseline?.ok === true && !busy

  const start = async (): Promise<void> => {
    if (!canStart || !chair) return
    setBusy(true)
    setError(null)
    const r = await window.api.cowork.start({ prompt: prompt.trim(), chair, participants: picked, language })
    setBusy(false)
    if (r.ok) onStarted(r.data)
    else {
      const runId = r.code === 'active-run-exists' ? (r.data as { runId?: string } | undefined)?.runId : undefined
      setError({ text: errorText(t, r) || '', runId })
    }
  }

  return (
    <div className="cw-start">
      <div className="cw-start-inner">
        <h2 className="cw-start-title">{t('cowork.startTitle')}</h2>
        <p className="cw-start-desc">{t('cowork.startDesc')}</p>

        <textarea
          className="cw-textarea cw-start-prompt"
          placeholder={t('cowork.promptPlaceholder')}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void start()
            }
          }}
          autoFocus
        />

        <div className="cw-section-label">{t('cowork.participants')}</div>
        <div className="cw-agent-cards">
          {COWORK_AGENTS.map((a) => {
            const cap = caps?.find((c) => c.agent === a)
            const ok = usable(a)
            const on = picked.includes(a)
            const reason = !cap ? '' : !cap.enabled ? t('cowork.reason_disabled') : cap.reason ? t(`cowork.reason_${cap.reason}`) : ''
            return (
              <div key={a} data-agent={a} className={`cw-agent-card ${on ? 'on' : ''} ${ok ? '' : 'disabled'}`}>
                <button type="button" className="cw-agent-card-main" onClick={() => toggle(a)} disabled={!ok} aria-pressed={on}>
                  <span className={`cw-check ${on ? 'on' : ''}`} aria-hidden />
                  <AgentMark agent={a} size={16} />
                  <span className="cw-agent-card-text">
                    <span className="cw-agent-card-name">{agentLabel(a)}</span>
                    <span className="cw-agent-card-sub">{ok ? t('cowork.eligible') : reason}</span>
                  </span>
                </button>
                {on && (
                  <button
                    type="button"
                    className={`cw-chair-toggle ${chair === a ? 'on' : ''}`}
                    onClick={() => setChair(a)}
                    aria-pressed={chair === a}
                  >
                    {chair === a ? `★ ${t('cowork.chair')}` : t('cowork.makeChair')}
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <div className={`cw-baseline ${baseline && !baseline.ok ? 'error' : ''}`}>
          {!baseline ? (
            <span className="cw-muted">…</span>
          ) : !baseline.ok ? (
            <span>{t(`cowork.baselineError_${baseline.code}`)}</span>
          ) : (
            <>
              <div>{t('cowork.baseline', { branch: baseline.branch, commit: baseline.head.slice(0, 7) })}</div>
              {baseline.dirtyCount > 0 && (
                <button type="button" className="cw-link" onClick={() => setShowDirty((v) => !v)}>
                  ⚠ {t('cowork.dirtyExcluded', { count: baseline.dirtyCount })}
                </button>
              )}
              {showDirty && (
                <ul className="cw-file-list">
                  {baseline.dirty.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
              {editorDirtyPaths.length > 0 && <div className="cw-warn">⚠ {t('cowork.unsavedExcluded', { count: editorDirtyPaths.length })}</div>}
              {baseline.warnings.map((w) => (
                <div key={w} className="cw-warn">
                  ⚠ {t(`cowork.warn_${w}`)}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="cw-start-footer">
          <button type="button" className="cw-link cw-muted" onClick={() => openSettings('cowork')}>
            {t('cowork.limitsLine', { calls: limits.calls, minutes: limits.minutes })}
          </button>
          <button type="button" className="cw-btn primary" onClick={start} disabled={!canStart}>
            {busy ? t('cowork.starting') : t('cowork.start')}
          </button>
        </div>
        {picked.length < 2 && caps && <div className="cw-muted cw-start-hint">{t('cowork.needTwo')}</div>}
        {error && (
          <div className="cw-error" role="alert">
            {error.text}
            {error.runId && (
              <button type="button" className="cw-link" onClick={() => onOpenRun(error.runId!)}>
                {t('cowork.openActive')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 一場會議 ────────────────────────────────────────────────────────

function RunView({
  run,
  t,
  sessions,
  onPaste,
  onOpenAgent
}: {
  run: CoworkRun
  t: T
  sessions: CoworkSessionRef[]
  onPaste: (sessionId: string, text: string, fresh?: boolean) => void
  onOpenAgent: (agent: CoworkAgent) => string
}): JSX.Element {
  const [now, setNow] = useState(Date.now())
  const [highlight, setHighlight] = useState<Highlight>(null)
  const [boardOpen, setBoardOpen] = useState(true)
  const [editing, setEditing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (run.phase !== 'meeting') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [run.phase])

  useEffect(() => {
    setEditing(false)
    setActionError(null)
    setHighlight(null)
  }, [run.id])

  // 新事件進來時，若使用者本來就在底部就跟著捲
  const logLen = run.log.length
  useEffect(() => {
    const el = timelineRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [logLen, run.phase])

  // 從任務板點任務：時間軸捲到第一則提到它的發言
  useEffect(() => {
    if (!highlight?.task || !timelineRef.current) return
    const hit = timelineRef.current.querySelector(`[data-tasks~="${CSS.escape(highlight.task)}"]`)
    hit?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [highlight])

  const act = async (p: Promise<CoworkResult<unknown>>): Promise<boolean> => {
    setActionError(null)
    const r = await p
    const e = errorText(t, r)
    if (e) setActionError(e)
    return !e
  }

  const board = currentBoard(run)
  const issues = useMemo(() => (run.r1 ? collectIssues(run.chair, run.r1, run.reviewers) : []), [run.r1, run.reviewers, run.chair])
  const issueById = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])

  return (
    <div className={`cw-run ${boardOpen ? '' : 'board-closed'}`}>
      <div className="cw-main">
        <Roster run={run} t={t} now={now} onCancel={() => act(window.api.cowork.cancel(run.id))} />
        <div className="cw-timeline" ref={timelineRef}>
          <Timeline run={run} t={t} issueById={issueById} highlight={highlight} onHighlight={setHighlight} />
          <TurnCard
            run={run}
            t={t}
            act={act}
            onEdit={() => {
              setBoardOpen(true)
              setEditing(true)
            }}
            onFeedback={() => composerRef.current?.focus()}
          />
          {actionError && (
            <div className="cw-error" role="alert">
              {actionError}
            </div>
          )}
        </div>
        <Composer run={run} t={t} act={act} inputRef={composerRef} />
      </div>
      <aside className="cw-board">
        <div className="cw-board-head">
          <button
            type="button"
            className="cw-board-toggle"
            onClick={() => setBoardOpen((v) => !v)}
            aria-expanded={boardOpen}
            title={boardOpen ? t('cowork.collapseBoard') : t('cowork.expandBoard')}
          >
            <IconChevronDown size={10} className={boardOpen ? 'rot-r' : 'rot-l'} />
          </button>
          {boardOpen && (
            <>
              <span className="cw-board-title">{t('cowork.board')}</span>
              {board && board.planRevision !== run.approvedPlanRevision ? (
                <span className="cw-pill">{t('cowork.revision', { rev: board.planRevision })}</span>
              ) : !board && run.r1 ? (
                <span className="cw-pill muted">{t('cowork.draft')}</span>
              ) : null}
              {run.approvedPlanRevision !== null && (
                <span className="cw-pill phase-approved">✓ {t('cowork.revision', { rev: run.approvedPlanRevision })}</span>
              )}
            </>
          )}
        </div>
        {boardOpen &&
          (editing && board ? (
            <BoardEditor
              run={run}
              board={board}
              t={t}
              onDone={() => setEditing(false)}
            />
          ) : (
            <Board
              run={run}
              t={t}
              highlight={highlight}
              onHighlight={setHighlight}
              sessions={sessions}
              onPaste={onPaste}
              onOpenAgent={onOpenAgent}
            />
          ))}
      </aside>
    </div>
  )
}

// ── 與會者列 ───────────────────────────────────────────────────────

function Roster({ run, t, now, onCancel }: { run: CoworkRun; t: T; now: number; onCancel: () => void }): JSX.Element {
  const running = run.calls.filter((c) => c.status === 'running')
  const yourTurn = run.phase === 'awaiting-approval' || run.phase === 'blocked' || run.phase === 'paused'
  const usedMin = Math.floor(planningMsUsed(run, now) / 60000)

  const statusOf = (a: CoworkAgent): { text: string; cls: string; call?: (typeof running)[number] } => {
    const call = running.find((c) => c.agent === a)
    if (call) {
      return {
        text: t('cowork.status_thinking', { elapsed: mmss(now - call.startedAt), limit: mmss(call.timeoutMs) }),
        cls: 'thinking',
        call
      }
    }
    if (a === run.chair) return run.r1 ? { text: t('cowork.status_spoke'), cls: 'done' } : { text: t('cowork.status_waiting'), cls: '' }
    const r = run.reviewers[a]
    if (r?.status === 'ok') return { text: t('cowork.status_spoke'), cls: 'done' }
    if (r?.status === 'failed') return { text: t('cowork.status_failed'), cls: 'failed' }
    if (r?.status === 'dropped') return { text: t('cowork.status_dropped'), cls: 'muted' }
    return { text: t('cowork.status_waiting'), cls: '' }
  }

  return (
    <div className="cw-roster">
      <div className="cw-roster-people">
        {run.participants.map((a) => {
          const s = statusOf(a)
          return (
            <div key={a} data-agent={a} className={`cw-person ${s.cls}`}>
              <AgentMark agent={a} size={14} />
              <span className="cw-person-name">{agentLabel(a)}</span>
              <span className={`cw-role ${a === run.chair ? 'chair' : ''}`}>
                {a === run.chair ? `★ ${t('cowork.role_chair')}` : t('cowork.role_reviewer')}
              </span>
              <span className="cw-person-status" aria-live="polite">
                {s.cls === 'thinking' && <span className="cw-dots" aria-hidden />}
                {s.text}
              </span>
              {s.call && (
                <button type="button" className="cw-mini-btn" onClick={onCancel} title={t('cowork.stopMeeting')}>
                  {t('cowork.stopMeeting')}
                </button>
              )}
            </div>
          )
        })}
        <div className={`cw-person you ${yourTurn ? 'turn' : ''}`}>
          <span className="cw-you-dot" aria-hidden />
          <span className="cw-person-name">{t('cowork.you')}</span>
          <span className="cw-person-status">{yourTurn ? t('cowork.status_yourTurn') : t('cowork.status_listening')}</span>
        </div>
      </div>
      <div className="cw-budget" title={t('cowork.budgetTitle')}>
        <span>{t('cowork.budgetCalls', { used: run.budget.planningCallsUsed, max: run.limits.maxPlanningCalls })}</span>
        <span>{t('cowork.budgetMinutes', { used: usedMin, max: run.limits.maxPlanningMinutes })}</span>
        {run.budget.costUsd > 0 && <span>{t('cowork.budgetCost', { cost: run.budget.costUsd.toFixed(2) })}</span>}
        {run.budget.tokens > 0 && <span className="cw-muted">{t('cowork.budgetTokens', { tokens: run.budget.tokens.toLocaleString() })}</span>}
      </div>
    </div>
  )
}

// ── 時間軸 ─────────────────────────────────────────────────────────

function Timeline({
  run,
  t,
  issueById,
  highlight,
  onHighlight
}: {
  run: CoworkRun
  t: T
  issueById: Map<string, CoworkIssue>
  highlight: Highlight
  onHighlight: (h: Highlight) => void
}): JSX.Element {
  const items: JSX.Element[] = []
  const boardAt = (rev: number): { board: CoworkBoard; prev: CoworkBoard | null } | null => {
    const i = run.boards.map((b) => b.planRevision).lastIndexOf(rev)
    return i < 0 ? null : { board: run.boards[i], prev: i > 0 ? run.boards[i - 1] : null }
  }

  run.log.forEach((e: CoworkLogEntry, idx: number) => {
    const key = `${idx}-${e.t}`
    switch (e.t) {
      case 'start':
        items.push(
          <div key={key} className="cw-msg you">
            <div className="cw-msg-head">
              <span className="cw-you-dot" aria-hidden />
              <span className="cw-msg-who">{t('cowork.you')}</span>
              <span className="cw-muted">
                {run.repo.sourceBranch}@{run.repo.baseCommit.slice(0, 7)}
              </span>
            </div>
            <div className="cw-msg-body pre">{run.prompt}</div>
          </div>
        )
        break
      case 'round':
        items.push(
          <Divider key={key}>
            {e.round === 1
              ? t('cowork.round1')
              : e.round === 2
                ? t('cowork.round2', {
                    done: reviewersOf(run).filter((a) => ['ok', 'failed', 'dropped'].includes(run.reviewers[a]?.status || '')).length,
                    total: reviewersOf(run).length
                  })
                : t('cowork.round3')}
          </Divider>
        )
        // R2 一律並排、緊接在第二輪分隔線後面（彼此看不到，不能排成一問一答）
        if (e.round === 2 && !run.log.slice(0, idx).some((x) => x.t === 'round' && x.round === 2)) {
          items.push(<ReviewGrid key={`${key}-grid`} run={run} t={t} highlight={highlight} onHighlight={onHighlight} />)
        }
        break
      case 'r1':
        if (run.r1) items.push(<ChairOpening key={key} run={run} t={t} highlight={highlight} onHighlight={onHighlight} />)
        break
      case 'board': {
        const found = boardAt(e.planRevision)
        if (!found) break
        const { board, prev } = found
        if (board.source === 'user') break // 使用者改板另有 edit／dismiss 事件
        const known = new Set((prev?.decisions || []).map((d) => d.issueId))
        const fresh = board.decisions.filter((d) => !known.has(d.issueId))
        items.push(
          <Divider key={`${key}-div`} tone={board.unresolved.length ? 'warn' : 'ok'}>
            {prev
              ? t('cowork.revisedByChair', { rev: board.planRevision })
              : t('cowork.settled', { handled: board.decisions.length, open: board.unresolved.length })}
          </Divider>
        )
        if (fresh.length || board.unresolved.length) {
          items.push(
            <Decisions key={key} run={run} board={board} decisions={fresh} t={t} issueById={issueById} highlight={highlight} onHighlight={onHighlight} />
          )
        }
        break
      }
      case 'note':
      case 'feedback':
        items.push(
          <div key={key} className="cw-msg you">
            <div className="cw-msg-head">
              <span className="cw-you-dot" aria-hidden />
              <span className="cw-msg-who">{t('cowork.you')}</span>
              <span className="cw-tag">{e.t === 'note' ? t('cowork.note') : t('cowork.feedback')}</span>
            </div>
            <div className="cw-msg-body pre">{e.text}</div>
          </div>
        )
        break
      case 'edit':
        items.push(<SysLine key={key}>{t('cowork.editedByYou', { rev: e.planRevision })}</SysLine>)
        break
      case 'dismiss':
        items.push(<SysLine key={key}>{t('cowork.dismissed', { count: e.count, rev: e.planRevision })}</SysLine>)
        break
      case 'drop':
        items.push(<SysLine key={key}>{t('cowork.dropped', { agents: e.agents.map(agentLabel).join(', '), rev: e.planRevision })}</SysLine>)
        break
      case 'approved':
        items.push(
          <Divider key={key} tone="ok">
            ✓ {t('cowork.approvedLine', { rev: e.planRevision })}
          </Divider>
        )
        break
      case 'dispatch':
        items.push(
          <SysLine key={key} tasks={e.taskId}>
            {t('cowork.dispatched', { task: e.taskId, target: e.target })}
          </SysLine>
        )
        break
      case 'error':
        items.push(
          <div key={key} className="cw-sys error" data-agent={e.agent}>
            {e.agent && <AgentMark agent={e.agent} size={12} />}
            <span>
              {t('cowork.errorLine', { agent: e.agent ? agentLabel(e.agent) : '', step: t(`cowork.step_${e.step}`) })}
            </span>
            <span className="cw-sys-detail">{e.message}</span>
          </div>
        )
        break
      case 'resumed':
        items.push(<SysLine key={key}>{t('cowork.resumed')}</SysLine>)
        break
      case 'limits':
        items.push(<SysLine key={key}>{t('cowork.limitsRaised', { calls: e.maxPlanningCalls, minutes: e.maxPlanningMinutes })}</SysLine>)
        break
      case 'cancelled':
        items.push(
          <Divider key={key} tone="muted">
            {t('cowork.cancelledLine')}
          </Divider>
        )
        break
      case 'blocked':
        // 目前的卡關由「輪到你」卡片處理；歷史上的卡關只留一行
        if (idx !== run.log.length - 1 || run.phase !== 'blocked') {
          items.push(<SysLine key={key}>{t(`cowork.block_${e.kind}`)}</SysLine>)
        }
        break
    }
  })
  return <>{items}</>
}

function Divider({ children, tone }: { children: React.ReactNode; tone?: 'ok' | 'warn' | 'muted' }): JSX.Element {
  return (
    <div className={`cw-divider ${tone || ''}`} role="separator">
      <span>{children}</span>
    </div>
  )
}

function SysLine({ children, tasks }: { children: React.ReactNode; tasks?: string }): JSX.Element {
  return (
    <div className="cw-sys" data-tasks={tasks}>
      {children}
    </div>
  )
}

/** 點了會亮起任務板上對應任務的小標記 */
function TaskRef({ id, onHighlight, issue }: { id: string; onHighlight: (h: Highlight) => void; issue?: string }): JSX.Element {
  return (
    <button type="button" className="cw-taskref" onClick={() => onHighlight({ task: id, issue })}>
      {id}
    </button>
  )
}

function ChairOpening({ run, t, highlight, onHighlight }: { run: CoworkRun; t: T; highlight: Highlight; onHighlight: (h: Highlight) => void }): JSX.Element {
  const r1 = run.r1!
  const [open, setOpen] = useState(false)
  return (
    <div className="cw-msg agent" data-agent={run.chair} data-tasks={r1.tasks.map((x) => x.id).join(' ')}>
      <div className="cw-msg-head">
        <AgentMark agent={run.chair} size={14} />
        <span className="cw-msg-who">{agentLabel(run.chair)}</span>
        <span className="cw-role chair">★ {t('cowork.role_chair')}</span>
      </div>
      <div className="cw-msg-body">
        <p className="cw-lead">{r1.summary}</p>
        <button type="button" className="cw-link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '▾' : '▸'} {t('cowork.framing')} · {t('cowork.draftTasks')} {r1.tasks.length} · {t('cowork.questions')} {r1.questions.length}
        </button>
        {open && (
          <div className="cw-expand">
            <div className="cw-field-label">{t('cowork.framing')}</div>
            <p className="pre">{r1.framing}</p>
            <div className="cw-field-label">{t('cowork.draftTasks')}</div>
            <ul className="cw-list">
              {r1.tasks.map((tk) => (
                <li key={tk.id} className={highlight?.task === tk.id ? 'hl' : ''}>
                  <TaskRef id={tk.id} onHighlight={onHighlight} /> {tk.title} <span className="cw-muted">→ {agentLabel(tk.assignee)}</span>
                </li>
              ))}
            </ul>
            {r1.risks.length > 0 && (
              <>
                <div className="cw-field-label">{t('cowork.risks')}</div>
                <ul className="cw-list">
                  {r1.risks.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {r1.questions.length > 0 && (
          <>
            <div className="cw-field-label">{t('cowork.questions')}</div>
            <ul className="cw-list">
              {r1.questions.map((q) => (
                <li key={q.id} className={highlight?.issue === `${run.chair}.${q.id}` ? 'hl' : ''}>
                  <span className="cw-qid">{q.id}</span> {q.text}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

function ReviewGrid({ run, t, highlight, onHighlight }: { run: CoworkRun; t: T; highlight: Highlight; onHighlight: (h: Highlight) => void }): JSX.Element {
  return (
    <div className="cw-review-grid">
      {reviewersOf(run).map((a) => {
        const r = run.reviewers[a]
        const out = r?.output
        const tasks = out ? [...new Set([...out.agree, ...out.claims, ...out.objections.map((o) => o.target)])].join(' ') : ''
        return (
          <div key={a} data-agent={a} data-tasks={tasks} className={`cw-review ${r?.status || 'pending'}`}>
            <div className="cw-msg-head">
              <AgentMark agent={a} size={14} />
              <span className="cw-msg-who">{agentLabel(a)}</span>
              <span className="cw-role">{t('cowork.role_reviewer')}</span>
            </div>
            {!r || r.status === 'pending' || r.status === 'running' ? (
              <div className="cw-review-wait">
                {r?.status === 'running' ? (
                  <>
                    <span className="cw-dots" aria-hidden /> {t('cowork.thinking')}
                  </>
                ) : (
                  t('cowork.waitingTurn')
                )}
              </div>
            ) : r.status === 'failed' ? (
              <div className="cw-review-wait error">{r.error}</div>
            ) : r.status === 'dropped' ? (
              <div className="cw-review-wait">{t('cowork.status_dropped')}</div>
            ) : out ? (
              <div className="cw-review-body">
                {out.agree.length > 0 && (
                  <div className="cw-row-line">
                    <span className="cw-kind agree">{t('cowork.agree')}</span>
                    {out.agree.map((id) => (
                      <TaskRef key={id} id={id} onHighlight={onHighlight} />
                    ))}
                  </div>
                )}
                {out.objections.map((o) => {
                  const iid = `${a}.${o.id}`
                  return (
                    <button
                      key={o.id}
                      type="button"
                      className={`cw-issue objection ${highlight?.issue === iid ? 'hl' : ''}`}
                      onClick={() => onHighlight({ task: o.target, issue: iid })}
                    >
                      <span className="cw-kind objection">
                        {t('cowork.objects')} {o.target}
                      </span>
                      <span>{o.reason}</span>
                      {o.alternative && (
                        <span className="cw-alt">
                          {t('cowork.alternative')}：{o.alternative}
                        </span>
                      )}
                    </button>
                  )
                })}
                {out.missing.map((m) => {
                  const iid = `${a}.${m.id}`
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={`cw-issue missing ${highlight?.issue === iid ? 'hl' : ''}`}
                      onClick={() => onHighlight({ issue: iid })}
                    >
                      <span className="cw-kind missing">{t('cowork.missing')}</span>
                      <span>
                        <strong>{m.title}</strong> {m.why}
                      </span>
                    </button>
                  )
                })}
                {out.objections.length === 0 && out.missing.length === 0 && <div className="cw-muted">{t('cowork.nothingToAdd')}</div>}
                {out.claims.length > 0 && (
                  <div className="cw-row-line">
                    <span className="cw-kind">{t('cowork.claims')}</span>
                    {out.claims.map((id) => (
                      <TaskRef key={id} id={id} onHighlight={onHighlight} />
                    ))}
                  </div>
                )}
                {out.answers.length > 0 && (
                  <details className="cw-answers">
                    <summary>
                      {t('cowork.answers')} ({out.answers.length})
                    </summary>
                    <ul className="cw-list">
                      {out.answers.map((ans, i) => (
                        <li key={i}>
                          <span className="cw-qid">{ans.questionId}</span> {ans.answer}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function Decisions({
  run,
  board,
  decisions,
  t,
  issueById,
  highlight,
  onHighlight
}: {
  run: CoworkRun
  board: CoworkBoard
  decisions: CoworkBoard['decisions']
  t: T
  issueById: Map<string, CoworkIssue>
  highlight: Highlight
  onHighlight: (h: Highlight) => void
}): JSX.Element {
  return (
    <div className="cw-msg agent" data-agent={run.chair}>
      <div className="cw-msg-head">
        <AgentMark agent={run.chair} size={14} />
        <span className="cw-msg-who">{agentLabel(run.chair)}</span>
        <span className="cw-role chair">★ {t('cowork.role_chair')}</span>
      </div>
      <div className="cw-msg-body">
        <ul className="cw-decisions">
          {decisions.map((d) => {
            const issue = issueById.get(d.issueId)
            return (
              <li
                key={d.issueId}
                className={highlight?.issue === d.issueId ? 'hl' : ''}
                data-tasks={issue?.target}
                onClick={() => onHighlight({ task: issue?.target, issue: d.issueId })}
              >
                <span className={`cw-verdict ${d.verdict}`}>{t(`cowork.verdict_${d.verdict}`)}</span>
                <span className="cw-decision-text">
                  <span className="cw-issue-ref">
                    {issue ? `${agentLabel(issue.from)} · ${issue.text}` : d.issueId}
                  </span>
                  <span className="cw-muted">{d.reason}</span>
                </span>
              </li>
            )
          })}
        </ul>
        {board.unresolved.length > 0 && (
          <>
            <div className="cw-field-label warn">{t('cowork.unresolvedTitle')}</div>
            <ul className="cw-list">
              {board.unresolved.map((u, i) => (
                <li key={i}>
                  {u.issueId && <span className="cw-qid">{u.issueId}</span>} {u.text}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

// ── 輪到你 ─────────────────────────────────────────────────────────

function TurnCard({
  run,
  t,
  act,
  onEdit,
  onFeedback
}: {
  run: CoworkRun
  t: T
  act: (p: Promise<CoworkResult<unknown>>) => Promise<boolean>
  onEdit: () => void
  onFeedback: () => void
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const needsYou = run.phase === 'awaiting-approval' || run.phase === 'blocked' || run.phase === 'paused'
  // 輪到使用者時把焦點移過來（cowork.md §6.3）
  useEffect(() => {
    if (needsYou) ref.current?.focus()
  }, [needsYou, run.phase, run.block?.kind, run.planRevision])

  const cancel = (): void => {
    if (window.confirm(t('cowork.confirmCancel'))) void act(window.api.cowork.cancel(run.id))
  }
  const cancelBtn = (
    <button type="button" className="cw-btn ghost" onClick={cancel}>
      {t('cowork.cancelMeeting')}
    </button>
  )

  if (run.phase === 'meeting') return null
  if (run.phase === 'cancelled') return null
  if (run.phase === 'failed') {
    return (
      <div className="cw-turn error" role="status" ref={ref} tabIndex={-1}>
        <div className="cw-turn-title">{t('cowork.failedTitle')}</div>
        {run.block && <div className="cw-turn-detail">{run.block.message}</div>}
      </div>
    )
  }
  if (run.phase === 'approved') {
    return (
      <div className="cw-turn ok" role="status" ref={ref} tabIndex={-1}>
        <div className="cw-turn-title">✓ {t('cowork.approvedTitle', { rev: run.approvedPlanRevision ?? run.planRevision })}</div>
        <div className="cw-turn-desc">{t('cowork.approvedDesc')}</div>
        <div className="cw-turn-actions">
          <button type="button" className="cw-btn" onClick={onFeedback}>
            {t('cowork.changePlan')}
          </button>
        </div>
      </div>
    )
  }
  if (run.phase === 'awaiting-approval') {
    return (
      <div className="cw-turn" role="status" ref={ref} tabIndex={-1}>
        <div className="cw-turn-badge">{t('cowork.turnTitle')}</div>
        <div className="cw-turn-title">{t('cowork.approveQuestion', { rev: run.planRevision })}</div>
        <div className="cw-turn-desc">{t('cowork.approveDesc')}</div>
        <div className="cw-turn-actions">
          <button type="button" className="cw-btn primary" onClick={() => act(window.api.cowork.approve(run.id, run.planRevision))}>
            {t('cowork.approve')}
          </button>
          <button type="button" className="cw-btn" onClick={onEdit}>
            {t('cowork.editBoard')}
          </button>
          <button type="button" className="cw-btn" onClick={onFeedback}>
            {t('cowork.giveFeedback')}
          </button>
          {cancelBtn}
        </div>
      </div>
    )
  }

  // blocked / paused
  const kind = run.block?.kind || 'step-failed'
  const reviewersOk = reviewersOf(run).some((a) => run.reviewers[a]?.status === 'ok')
  return (
    <div className={`cw-turn ${kind === 'side-effects' ? 'error' : 'warn'}`} role="status" ref={ref} tabIndex={-1}>
      <div className="cw-turn-badge">{t('cowork.turnTitle')}</div>
      <div className="cw-turn-title">{t(`cowork.block_${kind}`)}</div>
      {kind === 'unresolved' && <div className="cw-turn-desc">{t('cowork.unresolvedHint')}</div>}
      {kind === 'side-effects' && <div className="cw-turn-desc">{t('cowork.sideEffectsHint')}</div>}
      {run.block?.message && kind !== 'unresolved' && <div className="cw-turn-detail">{run.block.message}</div>}
      {run.block?.details && run.block.details.length > 0 && (
        <details className="cw-answers">
          <summary>{t('cowork.details')}</summary>
          <ul className="cw-file-list">
            {run.block.details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="cw-turn-actions">
        {kind === 'unresolved' && (
          <>
            <button type="button" className="cw-btn" onClick={onFeedback}>
              {t('cowork.giveFeedback')}
            </button>
            <button type="button" className="cw-btn" onClick={() => act(window.api.cowork.dismissUnresolved(run.id))}>
              {t('cowork.setAside')}
            </button>
            <button type="button" className="cw-btn" onClick={onEdit}>
              {t('cowork.editBoard')}
            </button>
          </>
        )}
        {kind === 'reviewers-failed' && (
          <>
            <button type="button" className="cw-btn primary" onClick={() => act(window.api.cowork.retry(run.id))}>
              {t('cowork.retry')}
            </button>
            <button
              type="button"
              className="cw-btn"
              disabled={!reviewersOk}
              onClick={() => act(window.api.cowork.dropFailedReviewers(run.id))}
            >
              {t('cowork.continueWithout')}
            </button>
          </>
        )}
        {kind === 'budget' && (
          <button
            type="button"
            className="cw-btn primary"
            onClick={async () => {
              const ok = await act(
                window.api.cowork.raiseLimits(run.id, {
                  maxPlanningCalls: run.limits.maxPlanningCalls + 3,
                  maxPlanningMinutes: run.limits.maxPlanningMinutes + 5
                })
              )
              if (ok) await act(window.api.cowork.retry(run.id))
            }}
          >
            {t('cowork.raiseAndRetry', { calls: run.limits.maxPlanningCalls + 3, minutes: run.limits.maxPlanningMinutes + 5 })}
          </button>
        )}
        {kind === 'side-effects' && (
          <button type="button" className="cw-btn primary" onClick={() => act(window.api.cowork.retry(run.id))}>
            {t('cowork.rebuildAndRetry')}
          </button>
        )}
        {(kind === 'step-failed' || kind === 'restart') && (
          <button type="button" className="cw-btn primary" onClick={() => act(window.api.cowork.retry(run.id))}>
            {kind === 'restart' ? t('cowork.resume') : t('cowork.retry')}
          </button>
        )}
        {cancelBtn}
      </div>
    </div>
  )
}

// ── 輸入框：依階段變形 ──────────────────────────────────────────────

function Composer({
  run,
  t,
  act,
  inputRef
}: {
  run: CoworkRun
  t: T
  act: (p: Promise<CoworkResult<unknown>>) => Promise<boolean>
  inputRef: React.RefObject<HTMLTextAreaElement>
}): JSX.Element | null {
  const [text, setText] = useState('')
  const mode: 'note' | 'feedback' | null =
    run.phase === 'meeting' || (run.phase === 'blocked' && run.block?.kind !== 'unresolved') || run.phase === 'paused'
      ? 'note'
      : run.phase === 'awaiting-approval' || run.phase === 'approved' || (run.phase === 'blocked' && run.block?.kind === 'unresolved')
        ? 'feedback'
        : null
  if (!mode) return null
  const send = async (): Promise<void> => {
    const v = text.trim()
    if (!v) return
    const ok = await act(mode === 'note' ? window.api.cowork.addNote(run.id, v) : window.api.cowork.feedback(run.id, v))
    if (ok) setText('')
  }
  return (
    <div className="cw-composer">
      <textarea
        ref={inputRef}
        className="cw-textarea"
        rows={2}
        value={text}
        placeholder={mode === 'note' ? t('cowork.notePlaceholder') : t('cowork.feedbackPlaceholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <button type="button" className="cw-btn primary" onClick={send} disabled={!text.trim()}>
        {mode === 'note' ? t('cowork.addNote') : t('cowork.sendFeedback')}
      </button>
    </div>
  )
}

// ── 任務板 ─────────────────────────────────────────────────────────

function Board({
  run,
  t,
  highlight,
  onHighlight,
  sessions,
  onPaste,
  onOpenAgent
}: {
  run: CoworkRun
  t: T
  highlight: Highlight
  onHighlight: (h: Highlight) => void
  sessions: CoworkSessionRef[]
  onPaste: (sessionId: string, text: string, fresh?: boolean) => void
  onOpenAgent: (agent: CoworkAgent) => string
}): JSX.Element {
  const board = currentBoard(run)
  const tasks = board ? board.tasks : run.r1?.tasks || []
  const draft = !board
  const refs = useRef(new Map<string, HTMLDivElement>())

  // 從時間軸點了某任務：任務板捲過去
  useEffect(() => {
    if (highlight?.task) refs.current.get(highlight.task)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [highlight])

  if (!tasks.length) return <div className="cw-board-empty">{t('cowork.emptyBoard')}</div>
  return (
    <div className={`cw-board-list ${draft ? 'draft' : ''}`}>
      {tasks.map((task) => (
        <div
          key={task.id}
          ref={(el) => {
            if (el) refs.current.set(task.id, el)
            else refs.current.delete(task.id)
          }}
        >
          <TaskCard
            run={run}
            task={task}
            t={t}
            on={highlight?.task === task.id}
            onClick={() => onHighlight(highlight?.task === task.id ? null : { task: task.id })}
            canDispatch={run.phase === 'approved' && !draft}
            sessions={sessions}
            onPaste={onPaste}
            onOpenAgent={onOpenAgent}
          />
        </div>
      ))}
    </div>
  )
}

function TaskCard({
  run,
  task,
  t,
  on,
  onClick,
  canDispatch,
  sessions,
  onPaste,
  onOpenAgent
}: {
  run: CoworkRun
  task: CoworkTask
  t: T
  on: boolean
  onClick: () => void
  canDispatch: boolean
  sessions: CoworkSessionRef[]
  onPaste: (sessionId: string, text: string, fresh?: boolean) => void
  onOpenAgent: (agent: CoworkAgent) => string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const dispatched = run.log.filter((e): e is Extract<CoworkLogEntry, { t: 'dispatch' }> => e.t === 'dispatch' && e.taskId === task.id)

  const send = (sessionId: string, title: string, fresh = false): void => {
    onPaste(sessionId, taskDispatchText(run, task), fresh)
    void window.api.cowork.logDispatch(run.id, task.id, title)
    setMenu(null)
  }
  const live = sessions.filter((s) => !s.isExited)
  // 指派對象的終端排前面
  const ordered = [...live.filter((s) => s.launcherKey === task.assignee), ...live.filter((s) => s.launcherKey !== task.assignee)]

  return (
    <div className={`cw-task ${on ? 'hl' : ''}`} data-agent={task.assignee}>
      <div className="cw-task-head" onClick={onClick}>
        <span className="cw-task-id">{task.id}</span>
        <span className="cw-task-title">{task.title}</span>
      </div>
      <div className="cw-task-meta">
        <span className="cw-assignee">
          <AgentMark agent={task.assignee} size={12} />
          {agentLabel(task.assignee)}
        </span>
        {task.dependsOn.length > 0 && <span className="cw-muted">{t('cowork.dependsOn', { deps: task.dependsOn.join(', ') })}</span>}
      </div>
      {task.scope.length > 0 && (
        <div className="cw-scope">
          {task.scope.map((s) => (
            <code key={s}>{s}</code>
          ))}
        </div>
      )}
      <button type="button" className="cw-link small" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? '▾' : '▸'} {t('cowork.detailAndAcceptance')}
      </button>
      {open && (
        <div className="cw-expand">
          <p className="pre">{task.detail}</p>
          {task.acceptance.length > 0 && (
            <>
              <div className="cw-field-label">{t('cowork.acceptance')}</div>
              <ul className="cw-list">
                {task.acceptance.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}
          {task.resources.length > 0 && (
            <div className="cw-muted">
              {t('cowork.resources')}: {task.resources.join(', ')}
            </div>
          )}
        </div>
      )}
      {canDispatch && (
        <div className="cw-task-actions">
          <button
            type="button"
            className="term-btn-action"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              // 選單最寬 340px：靠右的任務卡要往左推，不能超出視窗
              setMenu({ top: Math.min(r.bottom + 4, window.innerHeight - 280), left: Math.max(8, Math.min(r.left, window.innerWidth - 348)) })
            }}
          >
            {t('cowork.dispatch')}
          </button>
          <button
            type="button"
            className="term-btn-action"
            onClick={async () => {
              await navigator.clipboard.writeText(taskDispatchText(run, task))
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
          >
            {copied ? t('cowork.copied') : t('cowork.copy')}
          </button>
          {dispatched.length > 0 && <span className="cw-muted small">✓ {dispatched[dispatched.length - 1].target}</span>}
        </div>
      )}
      {menu &&
        createPortal(
          <>
            <div className="cw-popover-backdrop" onClick={() => setMenu(null)} />
            <div className="cw-popover cw-dispatch-menu" style={{ top: menu.top, left: menu.left }} role="menu">
              <div className="cw-menu-title">{t('cowork.dispatchTo')}</div>
              {ordered.length === 0 && <div className="cw-menu-empty">{t('cowork.noTerminals')}</div>}
              {ordered.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="cw-menu-item"
                  disabled={s.needsApproval}
                  title={s.needsApproval ? t('cowork.awaitingApproval') : undefined}
                  onClick={() => send(s.id, s.title)}
                >
                  <AgentMark agent={s.launcherKey as CoworkAgent} size={12} />
                  <span className="cw-menu-prompt">{s.title}</span>
                  {s.needsApproval && <span className="cw-pill phase-blocked">{t('cowork.awaitingApproval')}</span>}
                </button>
              ))}
              <button
                type="button"
                className="cw-menu-item cw-menu-new"
                onClick={() => {
                  const id = onOpenAgent(task.assignee)
                  send(id, agentLabel(task.assignee), true)
                }}
              >
                <IconPlus size={12} />
                <span>{t('cowork.newTerminal', { agent: agentLabel(task.assignee) })}</span>
              </button>
              <div className="cw-menu-hint">{t('cowork.dispatchHint')}</div>
            </div>
          </>,
          document.body
        )}
    </div>
  )
}

// ── 改板 ───────────────────────────────────────────────────────────

interface DraftTask {
  id: string
  title: string
  detail: string
  assignee: CoworkAgent
  scope: string
  dependsOn: string
  acceptance: string
  resources: string
}

const toDraft = (x: CoworkTask): DraftTask => ({
  id: x.id,
  title: x.title,
  detail: x.detail,
  assignee: x.assignee,
  scope: x.scope.join('\n'),
  dependsOn: x.dependsOn.join(', '),
  acceptance: x.acceptance.join('\n'),
  resources: x.resources.join(', ')
})
const lines = (s: string): string[] => s.split('\n').map((x) => x.trim()).filter(Boolean)
const commas = (s: string): string[] => s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)

function BoardEditor({ run, board, t, onDone }: { run: CoworkRun; board: CoworkBoard; t: T; onDone: () => void }): JSX.Element {
  const [drafts, setDrafts] = useState<DraftTask[]>(() => board.tasks.map(toDraft))
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const assignable = assignableAgents(run)
  const patch = (i: number, p: Partial<DraftTask>): void => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const nextId = (): string => {
    let n = drafts.length + 1
    while (drafts.some((d) => d.id === `t${n}`)) n++
    return `t${n}`
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setErrors([])
    const tasks = drafts.map((d) => ({
      id: d.id.trim(),
      title: d.title,
      detail: d.detail,
      assignee: d.assignee,
      scope: lines(d.scope),
      dependsOn: commas(d.dependsOn),
      acceptance: lines(d.acceptance),
      resources: commas(d.resources)
    }))
    const r = await window.api.cowork.editBoard(run.id, run.planRevision, tasks)
    setSaving(false)
    if (!r.ok) setErrors([errorText(t, r) || ''])
    else if (!r.data.ok) setErrors(r.data.errors)
    else onDone()
  }

  return (
    <div className="cw-editor">
      <div className="cw-editor-list">
        {drafts.map((d, i) => (
          <div key={i} className="cw-editor-task" data-agent={d.assignee}>
            <div className="cw-editor-row">
              <input className="cw-input id" value={d.id} onChange={(e) => patch(i, { id: e.target.value })} aria-label="id" />
              <input
                className="cw-input grow"
                value={d.title}
                placeholder={t('cowork.fieldTitle')}
                onChange={(e) => patch(i, { title: e.target.value })}
              />
              <button
                type="button"
                className="term-btn-icon"
                title={t('cowork.removeTask')}
                onClick={() => setDrafts((x) => x.filter((_, j) => j !== i))}
              >
                <IconTrash size={12} />
              </button>
            </div>
            <label className="cw-field-label">{t('cowork.fieldAssignee')}</label>
            <div className="segmented cw-assignee-seg">
              {assignable.map((a) => (
                <button key={a} type="button" className={d.assignee === a ? 'on' : ''} onClick={() => patch(i, { assignee: a })}>
                  <AgentMark agent={a} size={11} />
                  &nbsp;{agentLabel(a)}
                </button>
              ))}
            </div>
            <label className="cw-field-label">{t('cowork.fieldDetail')}</label>
            <textarea className="cw-textarea small" rows={3} value={d.detail} onChange={(e) => patch(i, { detail: e.target.value })} />
            <label className="cw-field-label">{t('cowork.fieldScope')}</label>
            <textarea className="cw-textarea small mono" rows={2} value={d.scope} onChange={(e) => patch(i, { scope: e.target.value })} />
            <label className="cw-field-label">{t('cowork.fieldDeps')}</label>
            <input className="cw-input mono" value={d.dependsOn} onChange={(e) => patch(i, { dependsOn: e.target.value })} />
            <label className="cw-field-label">{t('cowork.fieldAcceptance')}</label>
            <textarea className="cw-textarea small" rows={2} value={d.acceptance} onChange={(e) => patch(i, { acceptance: e.target.value })} />
          </div>
        ))}
        <button
          type="button"
          className="term-btn-action cw-add-task"
          onClick={() =>
            setDrafts((x) => [
              ...x,
              { id: nextId(), title: '', detail: '', assignee: assignable[0], scope: '', dependsOn: '', acceptance: '', resources: '' }
            ])
          }
        >
          <IconPlus size={11} /> {t('cowork.addTask')}
        </button>
      </div>
      {errors.length > 0 && (
        <ul className="cw-error cw-editor-errors" role="alert">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <div className="cw-editor-footer">
        <button type="button" className="cw-btn ghost" onClick={onDone}>
          {t('cowork.cancelEdit')}
        </button>
        <button type="button" className="cw-btn primary" onClick={save} disabled={saving || drafts.length === 0}>
          {t('cowork.saveRevision', { rev: run.planRevision + 1 })}
        </button>
      </div>
    </div>
  )
}
