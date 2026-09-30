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
import { AgentMark, IBranch, IChevronRight, IconMark, IDesktop, IDoc, IGear, IPhone, IPlus, IShare, IWarning } from './icons'
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

// 背景層：莫蘭迪色暈 + 往上飄的肥皂泡。位置與速度固定，每次開啟看到的畫面一致
const ORBS = [
  { s: 64, x: '8%', d: 26, delay: 0, sway: '18px', hue: 'var(--blob-2)' },
  { s: 28, x: '22%', d: 19, delay: 6, sway: '-12px', hue: 'var(--blob-5)' },
  { s: 96, x: '64%', d: 34, delay: 3, sway: '-24px', hue: 'var(--blob-3)' },
  { s: 40, x: '82%', d: 23, delay: 11, sway: '14px', hue: 'var(--blob-1)' },
  { s: 20, x: '46%', d: 17, delay: 15, sway: '10px', hue: 'var(--blob-4)' },
  { s: 52, x: '34%', d: 29, delay: 20, sway: '-16px', hue: 'var(--blob-2)' },
  { s: 34, x: '90%', d: 21, delay: 24, sway: '-10px', hue: 'var(--blob-5)' }
]

function Backdrop(): JSX.Element {
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="blob b1" />
      <div className="blob b2" />
      <div className="blob b3" />
      <div className="blob b4" />
      <div className="blob b5" />
      {ORBS.map((o, i) => (
        <span
          key={i}
          className="orb"
          style={
            {
              '--s': `${o.s}px`,
              '--x': o.x,
              '--d': `${o.d}s`,
              '--delay': `-${o.delay}s`,
              '--sway': o.sway,
              '--hue': o.hue
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <>
      <Backdrop />
      <Screens />
    </>
  )
}

function Screens(): JSX.Element {
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
        <div className="bubble form-card">
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
        <div className="notice neutral bubble">
          <IShare size={22} />
          <div>
            <b>{t('addToHomeTitle')}</b>
            <p className="t-sub">{t('addToHome')}</p>
          </div>
        </div>
      )}

      <div className="pair-actions">
        <button className="btn prominent press" disabled={!ready || busy}>
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

/** 狀態膠囊：文字 + 點，等你回覆的點會呼吸 */
function StatusPill({ status }: { status: 'waiting' | 'running' | 'idle' }): JSX.Element {
  const cls = status === 'waiting' ? 'wait' : status === 'running' ? 'run' : 'idle'
  return (
    <span className={`pill ${cls}`}>
      <span className="dot" aria-hidden="true" />
      {t(status)}
    </span>
  )
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
        clear
        scrolled={scrolled}
        trailing={
          <button className="circle-btn press" aria-label={t('settings')} onClick={onSettings}>
            <IGear size={22} />
          </button>
        }
      />
      <main className="content">
        <header className="large-header">
          <h1 className="t-large">{host}</h1>
          <div className="header-pills">
            <span className={`pill ${connState === 'open' ? 'run' : 'idle'}`}>
              <span className="dot" aria-hidden="true" />
              {connState === 'open' ? t('connected') : t('connecting')}
            </span>
            {connState === 'open' && loaded && (
              <span className={`pill ${waiting.length ? 'wait' : 'idle'}`}>
                {waiting.length > 0 && <span className="dot" aria-hidden="true" />}
                {waiting.length > 0 ? t('waitingCount', { n: waiting.length }) : t('allQuiet')}
              </span>
            )}
          </div>
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
            <div className="section-head">
              <h2 id="waiting-h">{t('needsYou')}</h2>
            </div>
            <div className="stack">
              {waiting.map((s) => {
                const q = questionPreview(tails[s.id] || s.approvalTail || '')
                return (
                  <button key={s.id} className="bubble wait-card press" onClick={() => onOpen({ kind: 'session', id: s.id })}>
                    <div className="wait-head">
                      <AgentMark launcherKey={s.launcherKey} />
                      <div className="card-main">
                        <span className="card-title">{s.title}</span>
                        <span className="card-sub">{s.workspaceName}</span>
                      </div>
                      <StatusPill status="waiting" />
                    </div>
                    {q && <p className="wait-q">{q}</p>}
                    <div className="wait-cta" style={q ? undefined : { marginTop: 14 }}>
                      {t('reply')}
                      <IChevronRight size={18} />
                    </div>
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {loaded && windows.length === 0 && (
          <div className="empty">
            <IDesktop size={44} />
            <p>{t('noWindows')}</p>
          </div>
        )}

        {windows.map((w) => {
          const list = (byWindow.get(w.id) || []).sort((a, b) => a.startTime - b.startTime)
          return (
            <section key={w.id} className="section" aria-label={w.workspaceName}>
              <div className="section-head">
                <h2>{w.workspaceName}</h2>
                {list.length > 0 && <span className="count">{list.length}</span>}
              </div>
              <div className="stack">
                {list.map((s) => (
                  <button key={s.id} className="bubble session-card press" onClick={() => onOpen({ kind: 'session', id: s.id })}>
                    <AgentMark launcherKey={s.launcherKey} />
                    <span className="card-main">
                      <span className="card-title">{s.title}</span>
                      <span className="card-sub">
                        {ago(s.startTime) === t('justNow') ? t('justNow') : t('startedAgo', { t: ago(s.startTime) })}
                      </span>
                    </span>
                    <StatusPill status={statusOf(s, now)} />
                    <IChevronRight size={18} className="chev" />
                  </button>
                ))}
                <button className="add-card press" onClick={() => onNew(w.id)}>
                  <IPlus size={20} />
                  {t('newTerminal')}
                </button>
              </div>
              <div className="tiles">
                <button className="bubble tile press" onClick={() => onOpen({ kind: 'handoff', windowId: w.id })}>
                  <IconMark tone="accent">
                    <IDoc size={20} />
                  </IconMark>
                  {t('handoff')}
                </button>
                <button className="bubble tile press" onClick={() => onOpen({ kind: 'git', windowId: w.id })}>
                  <IconMark tone="blue">
                    <IBranch size={20} />
                  </IconMark>
                  {t('git')}
                </button>
              </div>
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
  const grid = (list: RemoteLauncher[]): JSX.Element => (
    <div className="launcher-grid">
      {list.map((l) => (
        <button key={l.key} className="bubble launcher press" onClick={() => onPick(l.key)}>
          <AgentMark launcherKey={l.key} />
          {l.title}
        </button>
      ))}
    </div>
  )
  return (
    <Sheet
      title={t('newTerminal')}
      onClose={onClose}
      leading={
        <button className="text-btn" onClick={onClose}>
          {t('cancel')}
        </button>
      }
    >
      {bypass && (
        <div className="notice" role="note">
          <IWarning size={20} />
          <div className="t-sub">
            <b>{t('bypassTitle')}</b>
            {t('bypass')}
          </div>
        </div>
      )}
      {agents.length > 0 && (
        <>
          <h3 className="sheet-label">{t('agents')}</h3>
          {grid(agents)}
        </>
      )}
      {shells.length > 0 && (
        <>
          <h3 className="sheet-label">{t('shells')}</h3>
          {grid(shells)}
        </>
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
          <button className="text-btn strong" onClick={onClose}>
            {t('done')}
          </button>
        }
      >
        <div className="bubble stack-gap">
          <ul className="list">
            <li className="row">
              <IconMark tone="accent" size={32}>
                <IDesktop size={18} />
              </IconMark>
              <span className="row-main">{t('computer')}</span>
              <span className="row-value">{host}</span>
            </li>
            <li className="row">
              <IconMark tone="blue" size={32}>
                <IPhone size={18} />
              </IconMark>
              <span className="row-main">{t('thisPhone')}</span>
              <span className={`pill ${connState === 'open' ? 'run' : 'idle'}`}>
                <span className="dot" aria-hidden="true" />
                {connState === 'open' ? t('connected') : t('connecting')}
              </span>
            </li>
          </ul>
        </div>
        <div className="bubble">
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
        </div>
        <p className="footnote stack-gap">{footer}</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn press" style={{ color: 'var(--danger)' }} onClick={() => setConfirm(true)}>
          {t('unpair')}
        </button>
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
        clear
      />
      <main className="content detail-body">
        {view.kind === 'handoff' &&
          (handoff === undefined ? (
            <p className="empty">{t('loading')}</p>
          ) : handoff === null ? (
            <div className="empty">
              <IDoc size={44} />
              <p>{t('noHandoff')}</p>
            </div>
          ) : (
            <article className="bubble markdown">
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
              <div className="bubble branch-card">
                <IconMark tone="blue">
                  <IBranch size={20} />
                </IconMark>
                <span className="card-main card-title">{git.branch}</span>
                {git.ahead > 0 && <span className="pill run">↑ {git.ahead}</span>}
                {git.behind > 0 && <span className="pill wait">↓ {git.behind}</span>}
              </div>
              <div className="section-head">
                <h2>{git.files.length ? t('changes', { n: git.files.length }) : t('clean')}</h2>
              </div>
              <div className="files">
                {git.files.map((f) => {
                  const untracked = f.index === '?' || f.workingDir === '?'
                  const staged = !untracked && !!f.index.trim()
                  const flag = untracked ? '?' : (staged ? f.index : f.workingDir).trim() || '•'
                  return (
                    <div key={f.path} className="bubble file">
                      <span className={`git-flag ${staged ? 'staged' : untracked ? 'untracked' : ''}`}>{flag}</span>
                      <span className="git-path">{f.path}</span>
                    </div>
                  )
                })}
              </div>
            </>
          ))}
      </main>
    </div>
  )
}
