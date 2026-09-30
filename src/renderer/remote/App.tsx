import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { RemoteGitFile, RemoteLauncher, RemoteSession, RemoteWindow, ServerMessage } from '../../shared/remoteProtocol'
import { RemoteConnection, type ConnState } from './conn'
import {
  disablePush,
  enablePush,
  getToken,
  isStandalone,
  pair,
  pushState,
  pushSupported,
  registerServiceWorker,
  setToken
} from './api'
import TerminalView from './TerminalView'
import { ago, t } from './i18n'
import { questionPreview } from './prompt'
import { AgentMark, IBranch, IChevronRight, IDesktop, IDoc, IGear, IHand, IPlus, IShare, IWarning } from './icons'
import { ConfirmSheet, ConnCapsule, NavBar, Sheet, Switch, useScrolled } from './ui'

type View =
  | { kind: 'home' }
  | { kind: 'session'; id: string }
  | { kind: 'handoff'; windowId: number }
  | { kind: 'git'; windowId: number }

function sessionFromHash(): string | null {
  return /[#&]s=([\w-]+)/.exec(location.hash)?.[1] ?? null
}

function formatCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s
}

export default function App(): JSX.Element {
  const [token, setTokenState] = useState<string | null>(getToken())
  const [unpaired, setUnpaired] = useState(false)

  useEffect(() => {
    void registerServiceWorker()
  }, [])

  if (!token) {
    return (
      <PairScreen
        notice={unpaired ? t('unauthorized') : null}
        onPaired={(tok) => {
          setToken(tok)
          setUnpaired(false)
          setTokenState(tok)
        }}
      />
    )
  }
  return (
    <Main
      key={token}
      token={token}
      onUnauthorized={() => {
        setToken(null)
        setUnpaired(true)
        setTokenState(null)
      }}
    />
  )
}

// —— 配對 ——

function PairScreen({ notice, onPaired }: { notice: string | null; onPaired: (token: string) => void }): JSX.Element {
  const [code, setCode] = useState(() => formatCode(/[#&]pair=([A-Za-z0-9-]+)/.exec(location.hash)?.[1] ?? ''))
  const [name, setName] = useState(/iPad/.test(navigator.userAgent) ? 'iPad' : 'iPhone')
  const [error, setError] = useState<string | null>(notice)
  const [busy, setBusy] = useState(false)
  const ready = code.replace(/-/g, '').length === 8 && name.trim().length > 0

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await pair(code, name.trim())
      history.replaceState(null, '', '/')
      onPaired(res.token)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg === 'invalid' ? t('pairInvalid') : t('pairFailed', { e: msg }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="pair content"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !busy) void submit()
      }}
    >
      <div className="pair-hero">
        <img src="/remote-icon-180.png" alt="" width={76} height={76} />
        <h1>{t('pairTitle')}</h1>
        <p>{t('pairDesc')}</p>
      </div>

      <div className="section">
        <div className="list">
          <div className="field">
            <label htmlFor="code">{t('pairCode')}</label>
            <input
              id="code"
              className="code-input"
              value={code}
              onChange={(e) => setCode(formatCode(e.target.value))}
              placeholder="XXXX-XXXX"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="one-time-code"
              spellCheck={false}
              aria-invalid={!!error}
              aria-describedby={error ? 'pair-error' : undefined}
            />
          </div>
          <div className="field">
            <label htmlFor="name">{t('deviceName')}</label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </div>
        </div>
        {error && (
          <p className="form-error" id="pair-error" role="alert">
            <IWarning size={18} />
            {error}
          </p>
        )}
      </div>

      {!isStandalone() && (
        <div className="notice neutral">
          <IShare size={22} />
          <div>
            <b>{t('addToHomeTitle')}</b>
            <p className="t-sub">{t('addToHome')}</p>
          </div>
        </div>
      )}

      <div className="pair-actions">
        <button className="btn prominent" disabled={!ready || busy}>
          {busy ? t('pairing') : t('pair')}
        </button>
      </div>
    </form>
  )
}

// —— 主畫面 ——

function Main({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }): JSX.Element {
  const conn = useMemo(() => new RemoteConnection(token), [token])
  const [connState, setConnState] = useState<ConnState>('connecting')
  const [host, setHost] = useState('')
  const [sessions, setSessions] = useState<RemoteSession[]>([])
  const [windows, setWindows] = useState<RemoteWindow[]>([])
  const [bypass, setBypass] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [view, setView] = useState<View>(() => {
    const id = sessionFromHash()
    return id ? { kind: 'session', id } : { kind: 'home' }
  })
  const [exits, setExits] = useState<Record<string, number>>({})
  const [tails, setTails] = useState<Record<string, string>>({})
  const [sheet, setSheet] = useState<null | { kind: 'new'; windowId: number } | { kind: 'settings' }>(null)
  const [lastSession, setLastSession] = useState<RemoteSession | null>(null)

  useEffect(() => {
    const offState = conn.onState((s) => {
      setConnState(s)
      if (s === 'unauthorized') onUnauthorized()
    })
    const off = conn.onMessage((m: ServerMessage) => {
      switch (m.t) {
        case 'authed':
          setHost(m.hostName)
          break
        case 'state':
          setSessions(m.sessions)
          setWindows(m.windows)
          setBypass(m.bypass)
          setLoaded(true)
          break
        case 'exit':
          setExits((prev) => ({ ...prev, [m.id]: m.code }))
          break
        case 'approval':
          setTails((prev) => ({ ...prev, [m.id]: m.tail }))
          break
        case 'spawned':
          setSheet(null)
          setView({ kind: 'session', id: m.id })
          break
      }
    })
    conn.start()
    // 點通知（Service Worker 轉來）時直接開到那個終端
    const onSwMessage = (ev: MessageEvent): void => {
      const id = /[#&]s=([\w-]+)/.exec(String(ev.data?.url ?? ''))?.[1]
      if (ev.data?.type === 'open' && id) setView({ kind: 'session', id })
    }
    navigator.serviceWorker?.addEventListener('message', onSwMessage)
    return () => {
      off()
      offState()
      conn.stop()
      navigator.serviceWorker?.removeEventListener('message', onSwMessage)
    }
  }, [conn])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [view.kind])

  const current = view.kind === 'session' ? sessions.find((s) => s.id === view.id) || null : null
  useEffect(() => {
    if (current) setLastSession(current)
  }, [current])

  const goHome = (): void => {
    history.replaceState(null, '', '/')
    setView({ kind: 'home' })
  }
  const hostName = host || t('computer')

  let screen: JSX.Element
  if (view.kind === 'session' && (current || lastSession?.id === view.id)) {
    const s = (current || lastSession)!
    screen = <TerminalView conn={conn} session={s} hostName={hostName} exitCode={exits[s.id]} onBack={goHome} />
  } else if (view.kind === 'handoff' || view.kind === 'git') {
    const w = windows.find((x) => x.id === view.windowId)
    screen = <DetailView conn={conn} view={view} workspace={w?.workspaceName || ''} hostName={hostName} onBack={goHome} />
  } else {
    screen = (
      <Home
        host={hostName}
        connState={connState}
        loaded={loaded}
        sessions={sessions}
        windows={windows}
        bypass={bypass}
        tails={tails}
        onOpen={(v) => setView(v)}
        onNew={(windowId) => setSheet({ kind: 'new', windowId })}
        onSettings={() => setSheet({ kind: 'settings' })}
      />
    )
  }

  return (
    <>
      {screen}
      <ConnCapsule state={connState} />
      {sheet?.kind === 'new' && (
        <NewTerminalSheet
          launchers={windows.find((w) => w.id === sheet.windowId)?.launchers || []}
          bypass={bypass}
          onClose={() => setSheet(null)}
          onPick={(key) => conn.send({ t: 'spawn', windowId: sheet.windowId, launcherKey: key })}
        />
      )}
      {sheet?.kind === 'settings' && (
        <SettingsSheet
          token={token}
          host={hostName}
          connState={connState}
          onClose={() => setSheet(null)}
          onUnpair={() => {
            conn.stop()
            onUnauthorized()
          }}
        />
      )}
    </>
  )
}

function statusOf(s: RemoteSession, now: number): 'waiting' | 'running' | 'idle' {
  return s.needsApproval ? 'waiting' : now - s.lastOutputAt < 4000 ? 'running' : 'idle'
}

function useNow(ms = 2000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}

function Home({
  host,
  connState,
  loaded,
  sessions,
  windows,
  bypass,
  tails,
  onOpen,
  onNew,
  onSettings
}: {
  host: string
  connState: ConnState
  loaded: boolean
  sessions: RemoteSession[]
  windows: RemoteWindow[]
  bypass: boolean
  tails: Record<string, string>
  onOpen: (v: View) => void
  onNew: (windowId: number) => void
  onSettings: () => void
}): JSX.Element {
  const scrolled = useScrolled(44)
  const now = useNow()
  const waiting = sessions.filter((s) => s.needsApproval)
  const byWindow = new Map<number, RemoteSession[]>()
  for (const s of sessions) byWindow.set(s.windowId, [...(byWindow.get(s.windowId) || []), s])

  return (
    <div className="home">
      <NavBar
        title={host}
        scrolled={scrolled}
        trailing={
          <button className="icon-btn" aria-label={t('settings')} onClick={onSettings}>
            <IGear size={24} />
          </button>
        }
      />
      <main className="content">
        <header className="large-header">
          <h1 className="t-large">{host}</h1>
          <p className="status-line t-sub">
            <span className={`dot ${connState === 'open' ? 'run' : ''}`} aria-hidden="true" />
            {connState === 'open' ? t('connected') : t('connecting')}
            {connState === 'open' && loaded && (
              <>
                <span aria-hidden="true">·</span>
                {waiting.length > 0 ? <strong>{t('waitingCount', { n: waiting.length })}</strong> : t('allQuiet')}
              </>
            )}
          </p>
        </header>

        {bypass && (
          <div className="notice" role="note">
            <IWarning size={20} />
            <div className="t-sub">
              <b>{t('bypassTitle')}</b>
              {t('bypass')}
            </div>
          </div>
        )}

        {waiting.length > 0 && (
          <section className="section" aria-labelledby="waiting-h">
            <h2 className="section-header" id="waiting-h">
              {t('needsYou')}
            </h2>
            {waiting.map((s) => (
              <button key={s.id} className="wait-card" onClick={() => onOpen({ kind: 'session', id: s.id })}>
                <div className="wait-head">
                  <AgentMark launcherKey={s.launcherKey} />
                  <div className="row-main">
                    <span className="row-title t-headline">{s.title}</span>
                    <span className="row-sub">{s.workspaceName}</span>
                  </div>
                  <span className="pill">
                    <IHand size={14} />
                    {t('waiting')}
                  </span>
                </div>
                {(() => {
                  const q = questionPreview(tails[s.id] || s.approvalTail || '')
                  return q ? <p className="wait-q">{q}</p> : null
                })()}
                <div className="wait-foot">
                  {t('reply')}
                  <IChevronRight size={18} />
                </div>
              </button>
            ))}
          </section>
        )}

        {loaded && windows.length === 0 && (
          <div className="empty">
            <IDesktop size={40} />
            <p style={{ marginTop: 12 }}>{t('noWindows')}</p>
          </div>
        )}

        {windows.map((w) => {
          const list = (byWindow.get(w.id) || []).sort((a, b) => a.startTime - b.startTime)
          return (
            <section key={w.id} className="section" aria-label={w.workspaceName}>
              <h2 className="section-header">{w.workspaceName}</h2>
              <ul className="list">
                {list.map((s) => {
                  const st = statusOf(s, now)
                  return (
                    <li key={s.id}>
                      <button className="row with-mark" onClick={() => onOpen({ kind: 'session', id: s.id })}>
                        <AgentMark launcherKey={s.launcherKey} />
                        <span className="row-main">
                          <span className="row-title">{s.title}</span>
                          <span className="row-sub">
                            {ago(s.startTime) === t('justNow') ? t('justNow') : t('startedAgo', { t: ago(s.startTime) })}
                          </span>
                        </span>
                        {st === 'waiting' ? (
                          <span className="pill">
                            <IHand size={14} />
                            {t('waiting')}
                          </span>
                        ) : (
                          <span className={`state ${st === 'running' ? 'run' : ''}`}>
                            <span className={`dot ${st === 'running' ? 'run' : ''}`} aria-hidden="true" />
                            {t(st)}
                          </span>
                        )}
                        <IChevronRight size={18} className="chev" />
                      </button>
                    </li>
                  )
                })}
                <li>
                  <button className="row action with-icon" onClick={() => onNew(w.id)}>
                    <span className="row-icon">
                      <IPlus size={22} />
                    </span>
                    <span className="row-main">{t('newTerminal')}</span>
                  </button>
                </li>
              </ul>
              <ul className="list">
                <li>
                  <button className="row with-icon" onClick={() => onOpen({ kind: 'handoff', windowId: w.id })}>
                    <span className="row-icon">
                      <IDoc size={22} />
                    </span>
                    <span className="row-main row-title">{t('handoff')}</span>
                    <IChevronRight size={18} className="chev" />
                  </button>
                </li>
                <li>
                  <button className="row with-icon" onClick={() => onOpen({ kind: 'git', windowId: w.id })}>
                    <span className="row-icon">
                      <IBranch size={22} />
                    </span>
                    <span className="row-main row-title">{t('git')}</span>
                    <IChevronRight size={18} className="chev" />
                  </button>
                </li>
              </ul>
            </section>
          )
        })}
      </main>
    </div>
  )
}

function NewTerminalSheet({
  launchers,
  bypass,
  onClose,
  onPick
}: {
  launchers: RemoteLauncher[]
  bypass: boolean
  onClose: () => void
  onPick: (key: string) => void
}): JSX.Element {
  const agents = launchers.filter((l) => l.kind !== 'shell')
  const shells = launchers.filter((l) => l.kind === 'shell')
  const group = (list: RemoteLauncher[]): JSX.Element => (
    <ul className="list">
      {list.map((l) => (
        <li key={l.key}>
          <button className="row with-mark" onClick={() => onPick(l.key)}>
            <AgentMark launcherKey={l.key} />
            <span className="row-main row-title">{l.title}</span>
          </button>
        </li>
      ))}
    </ul>
  )
  return (
    <Sheet
      title={t('newTerminal')}
      onClose={onClose}
      leading={
        <button className="text-btn lead" onClick={onClose}>
          {t('cancel')}
        </button>
      }
    >
      {agents.length > 0 && (
        <section className="section">
          <h3 className="section-header">{t('agents')}</h3>
          {group(agents)}
          {bypass && (
            <p className="section-footer" style={{ display: 'flex', gap: 6, color: 'var(--wait)' }}>
              <IWarning size={16} />
              <span>
                {t('bypassTitle')}：{t('bypass')}
              </span>
            </p>
          )}
        </section>
      )}
      {shells.length > 0 && (
        <section className="section">
          <h3 className="section-header">{t('shells')}</h3>
          {group(shells)}
        </section>
      )}
    </Sheet>
  )
}

function SettingsSheet({
  token,
  host,
  connState,
  onClose,
  onUnpair
}: {
  token: string
  host: string
  connState: ConnState
  onClose: () => void
  onUnpair: () => void
}): JSX.Element {
  const [push, setPush] = useState<'unsupported' | 'denied' | 'on' | 'off'>('off')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    pushState()
      .then(setPush)
      .catch(() => setPush('unsupported'))
  }, [])

  const toggle = async (on: boolean): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      if (on) await enablePush(token)
      else await disablePush(token)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPush(await pushState().catch(() => 'off' as const))
      setBusy(false)
    }
  }

  const canPush = pushSupported() && isStandalone()
  const footer = !canPush ? t('notifNeedsHome') : push === 'denied' ? t('notifDenied') : t('notifFooter')

  return (
    <>
      <Sheet
        title={t('settings')}
        onClose={onClose}
        trailing={
          <button className="text-btn trail strong" onClick={onClose}>
            {t('done')}
          </button>
        }
      >
        <section className="section">
          <ul className="list">
            <li className="row">
              <span className="row-main">{t('computer')}</span>
              <span className="row-value">{host}</span>
            </li>
            <li className="row">
              <span className="row-main">{t('thisPhone')}</span>
              <span className="row-value">{connState === 'open' ? t('connected') : t('connecting')}</span>
            </li>
          </ul>
        </section>
        <section className="section">
          <ul className="list">
            <li className="row">
              <span className="row-main">{t('notifications')}</span>
              <Switch
                label={t('notifications')}
                checked={push === 'on'}
                disabled={!canPush || push === 'denied' || busy}
                onChange={(v) => void toggle(v)}
              />
            </li>
          </ul>
          <p className="section-footer">{footer}</p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </section>
        <section className="section">
          <div className="list">
            <button className="row destructive" onClick={() => setConfirm(true)}>
              {t('unpair')}
            </button>
          </div>
        </section>
      </Sheet>
      {confirm && (
        <ConfirmSheet
          title={t('unpairTitle')}
          message={t('unpairBody')}
          action={t('unpair')}
          onCancel={() => setConfirm(false)}
          onConfirm={onUnpair}
        />
      )}
    </>
  )
}

// —— 交接筆記 / Git ——

function DetailView({
  conn,
  view,
  workspace,
  hostName,
  onBack
}: {
  conn: RemoteConnection
  view: { kind: 'handoff' | 'git'; windowId: number }
  workspace: string
  hostName: string
  onBack: () => void
}): JSX.Element {
  const [handoff, setHandoff] = useState<string | null | undefined>(undefined)
  const [git, setGit] = useState<{ branch: string | null; ahead: number; behind: number; files: RemoteGitFile[]; error?: string } | null>(null)
  const scrolled = useScrolled(4)

  useEffect(() => {
    const off = conn.onMessage((m) => {
      if (m.t === 'handoff' && m.windowId === view.windowId) setHandoff(m.text)
      if (m.t === 'git' && m.windowId === view.windowId) setGit(m)
    })
    const request = (): void => conn.send({ t: view.kind, windowId: view.windowId })
    const offState = conn.onState((s) => s === 'open' && request())
    request()
    return () => {
      off()
      offState()
    }
  }, [view.kind, view.windowId])

  return (
    <div className="detail">
      <NavBar
        title={view.kind === 'git' ? t('git') : t('handoff')}
        subtitle={workspace}
        backLabel={hostName}
        onBack={onBack}
        scrolled={scrolled}
      />
      <main className="content detail-body">
        {view.kind === 'handoff' &&
          (handoff === undefined ? (
            <p className="empty">{t('loading')}</p>
          ) : handoff === null ? (
            <div className="empty">
              <IDoc size={40} />
              <p style={{ marginTop: 12 }}>{t('noHandoff')}</p>
            </div>
          ) : (
            <article className="markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{handoff}</ReactMarkdown>
            </article>
          ))}
        {view.kind === 'git' &&
          (!git ? (
            <p className="empty">{t('loading')}</p>
          ) : git.error ? (
            <p className="form-error" role="alert">
              <IWarning size={18} />
              {git.error}
            </p>
          ) : (
            <>
              <section className="section">
                <ul className="list">
                  <li className="row with-icon">
                    <span className="row-icon">
                      <IBranch size={22} />
                    </span>
                    <span className="row-main row-title t-headline">{git.branch}</span>
                    {(git.ahead > 0 || git.behind > 0) && (
                      <span className="row-value t-sub">
                        {git.ahead > 0 && `↑${git.ahead} `}
                        {git.behind > 0 && `↓${git.behind}`}
                      </span>
                    )}
                  </li>
                </ul>
              </section>
              <section className="section">
                <h2 className="section-header">{git.files.length ? t('changes', { n: git.files.length }) : t('clean')}</h2>
                {git.files.length > 0 && (
                  <ul className="list">
                    {git.files.map((f) => {
                      const staged = !!f.index.trim() && f.index !== '?'
                      const flag = (staged ? f.index : f.workingDir).trim() || '?'
                      return (
                        <li key={f.path} className="row with-icon">
                          <span className={`git-flag ${staged ? 'staged' : ''}`}>{flag}</span>
                          <span className="git-path">{f.path}</span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            </>
          ))}
      </main>
    </div>
  )
}
