import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { RemoteGitFile, RemoteSession, RemoteWindow, ServerMessage } from '../../shared/remoteProtocol'
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
import { t } from './i18n'

type View =
  | { kind: 'home' }
  | { kind: 'session'; id: string }
  | { kind: 'handoff'; windowId: number }
  | { kind: 'git'; windowId: number }

const AGENT_COLORS: Record<string, string> = {
  claude: '#D97757',
  codex: '#10A37F',
  antigravity: '#4285F4'
}

function sessionFromHash(): string | null {
  const m = /[#&]s=([\w-]+)/.exec(location.hash)
  return m ? m[1] : null
}

function pairCodeFromHash(): string {
  const m = /[#&]pair=([A-Za-z0-9-]+)/.exec(location.hash)
  return m ? m[1].toUpperCase() : ''
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
  const [code, setCode] = useState(pairCodeFromHash())
  const [name, setName] = useState(/iPad/.test(navigator.userAgent) ? 'iPad' : 'iPhone')
  const [error, setError] = useState<string | null>(notice)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await pair(code, name)
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
    <div className="pair-screen">
      <div className="pair-icon">
        <img src="/remote-icon-180.png" alt="" width={72} height={72} />
      </div>
      <h1>{t('pairTitle')}</h1>
      <p className="muted">{t('pairDesc')}</p>
      <form
        className="group"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="field">
          <span>{t('pairCode')}</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="one-time-code"
            spellCheck={false}
            inputMode="text"
            className="code-input"
          />
        </label>
        <label className="field">
          <span>{t('deviceName')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        <button className="btn primary block" disabled={busy || code.replace(/[^A-Z0-9]/g, '').length < 8}>
          {t('pair')}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {!isStandalone() && <p className="muted small">{t('addToHome')}</p>}
    </div>
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
  const [view, setView] = useState<View>(() => {
    const id = sessionFromHash()
    return id ? { kind: 'session', id } : { kind: 'home' }
  })
  const [exits, setExits] = useState<Record<string, { code: number; title: string }>>({})
  const [sheet, setSheet] = useState<null | { kind: 'new'; windowId: number } | { kind: 'settings' }>(null)
  const [banner, setBanner] = useState<{ id: string; title: string } | null>(null)
  // 已結束的 session 還留在畫面上時，需要保留最後一份資訊
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
          break
        case 'exit':
          setExits((prev) => ({ ...prev, [m.id]: { code: m.code, title: m.title } }))
          break
        case 'approval':
          setBanner({ id: m.id, title: m.title })
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
      if (ev.data?.type === 'open') {
        const id = /[#&]s=([\w-]+)/.exec(String(ev.data.url))?.[1]
        if (id) setView({ kind: 'session', id })
      }
    }
    navigator.serviceWorker?.addEventListener('message', onSwMessage)
    return () => {
      off()
      offState()
      conn.stop()
      navigator.serviceWorker?.removeEventListener('message', onSwMessage)
    }
  }, [conn])

  // 目前畫面的 session：從清單找，找不到（已結束）就沿用最後一份
  const current = view.kind === 'session' ? sessions.find((s) => s.id === view.id) || null : null
  useEffect(() => {
    if (current) setLastSession(current)
  }, [current])

  // 正在看的那個終端的審批提示不用再跳橫幅
  useEffect(() => {
    if (banner && view.kind === 'session' && banner.id === view.id) setBanner(null)
  }, [banner, view])

  const connBanner =
    connState === 'open' ? null : (
      <div className={`conn-banner ${connState}`}>{connState === 'connecting' ? t('connecting') : t('offline')}</div>
    )

  if (view.kind === 'session') {
    const s = current || (lastSession?.id === view.id ? lastSession : null)
    if (s) {
      return (
        <>
          {connBanner}
          <TerminalView
            conn={conn}
            session={s}
            exitCode={exits[s.id]?.code}
            onBack={() => {
              history.replaceState(null, '', '/')
              setView({ kind: 'home' })
            }}
          />
        </>
      )
    }
  }

  if (view.kind === 'handoff' || view.kind === 'git') {
    const w = windows.find((x) => x.id === view.windowId)
    return (
      <>
        {connBanner}
        <DetailView conn={conn} view={view} title={w?.workspaceName || ''} onBack={() => setView({ kind: 'home' })} />
      </>
    )
  }

  const byWindow = new Map<number, RemoteSession[]>()
  for (const s of sessions) byWindow.set(s.windowId, [...(byWindow.get(s.windowId) || []), s])

  return (
    <div className="home">
      {connBanner}
      <header className="large-title">
        <div>
          <h1>Workbench</h1>
          {host && connState === 'open' && <p className="muted small">{t('connectedTo', { host })}</p>}
        </div>
        <button className="icon-btn" onClick={() => setSheet({ kind: 'settings' })} aria-label={t('settings')}>
          ⚙︎
        </button>
      </header>

      {bypass && <div className="bypass-banner">⚠️ {t('bypass')}</div>}

      {banner && (
        <button
          className="approval-banner"
          onClick={() => {
            setView({ kind: 'session', id: banner.id })
            setBanner(null)
          }}
        >
          ⏳ {t('approvalTitle', { title: banner.title })} <span>{t('open')} ›</span>
        </button>
      )}

      {connState === 'open' && windows.length === 0 && <p className="muted center">{t('noWindows')}</p>}

      {windows.map((w) => {
        const list = (byWindow.get(w.id) || []).sort(
          (a, b) => Number(b.needsApproval) - Number(a.needsApproval) || a.startTime - b.startTime
        )
        return (
          <section key={w.id} className="section">
            <div className="section-head">
              <h2>{w.workspaceName}</h2>
              <div className="section-actions">
                <button className="chip" onClick={() => setView({ kind: 'handoff', windowId: w.id })}>
                  {t('handoff')}
                </button>
                <button className="chip" onClick={() => setView({ kind: 'git', windowId: w.id })}>
                  {t('git')}
                </button>
                <button className="chip accent" onClick={() => setSheet({ kind: 'new', windowId: w.id })}>
                  ＋ {t('newSession')}
                </button>
              </div>
            </div>
            <div className="group">
              {list.length === 0 && <div className="row muted">{t('noSessions')}</div>}
              {list.map((s) => (
                <SessionRow key={s.id} s={s} onOpen={() => setView({ kind: 'session', id: s.id })} />
              ))}
            </div>
          </section>
        )
      })}

      {sheet?.kind === 'new' && (
        <Sheet title={t('newSessionTitle')} onClose={() => setSheet(null)}>
          {bypass && <div className="bypass-banner inset">⚠️ {t('bypass')}</div>}
          <div className="group">
            {(windows.find((w) => w.id === sheet.windowId)?.launchers || []).map((l) => (
              <button
                key={l.key}
                className="row button-row"
                onClick={() => conn.send({ t: 'spawn', windowId: sheet.windowId, launcherKey: l.key })}
              >
                <Badge launcherKey={l.key} title={l.title} />
                <span className="row-title">{l.title}</span>
                <span className="muted small">{l.kind}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {sheet?.kind === 'settings' && (
        <SettingsSheet
          token={token}
          host={host}
          onClose={() => setSheet(null)}
          onUnpair={() => {
            conn.stop()
            onUnauthorized()
          }}
        />
      )}
    </div>
  )
}

function Badge({ launcherKey, title }: { launcherKey: string; title: string }): JSX.Element {
  return (
    <span className="badge" style={{ background: AGENT_COLORS[launcherKey] || '#8e8e93' }}>
      {title.slice(0, 1).toUpperCase()}
    </span>
  )
}

function SessionRow({ s, onOpen }: { s: RemoteSession; onOpen: () => void }): JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 2000)
    return () => window.clearInterval(id)
  }, [])
  const status = s.needsApproval ? 'waiting' : now - s.lastOutputAt < 4000 ? 'active' : 'idle'
  return (
    <button className="row button-row" onClick={onOpen}>
      <Badge launcherKey={s.launcherKey} title={s.title} />
      <span className="row-title">{s.title}</span>
      <span className={`status ${status}`}>{t(status)}</span>
      <span className="chevron">›</span>
    </button>
  )
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h3>{title}</h3>
          <button className="bar-btn" onClick={onClose}>
            {t('close')}
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function SettingsSheet({
  token,
  host,
  onClose,
  onUnpair
}: {
  token: string
  host: string
  onClose: () => void
  onUnpair: () => void
}): JSX.Element {
  const [push, setPush] = useState<'unsupported' | 'denied' | 'on' | 'off' | 'busy'>('off')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    pushState()
      .then(setPush)
      .catch(() => setPush('unsupported'))
  }, [])

  const toggle = async (): Promise<void> => {
    setError(null)
    const was = push
    setPush('busy')
    try {
      if (was === 'on') await disablePush(token)
      else await enablePush(token)
      setPush(await pushState())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPush(await pushState().catch(() => 'off' as const))
    }
  }

  const canPush = pushSupported() && isStandalone()

  return (
    <Sheet title={t('settings')} onClose={onClose}>
      {host && <p className="muted small inset">{t('connectedTo', { host })}</p>}
      <div className="group">
        <div className="row">
          <span className="row-title">{t('notifications')}</span>
          {push === 'on' && <span className="status active">{t('notifOn')}</span>}
        </div>
        <div className="row muted small">
          {!canPush ? t('notifNeedsHome') : push === 'denied' ? t('notifDenied') : t('notifDesc')}
        </div>
        {canPush && push !== 'denied' && (
          <button className="row button-row accent-text" disabled={push === 'busy'} onClick={() => void toggle()}>
            {push === 'on' ? t('notifDisable') : t('notifEnable')}
          </button>
        )}
      </div>
      {error && <p className="error inset">{error}</p>}
      <div className="group">
        <button
          className="row button-row danger-text"
          onClick={() => {
            if (window.confirm(t('unpairConfirm'))) onUnpair()
          }}
        >
          {t('unpair')}
        </button>
      </div>
    </Sheet>
  )
}

// —— Handoff / Git ——

function DetailView({
  conn,
  view,
  title,
  onBack
}: {
  conn: RemoteConnection
  view: { kind: 'handoff' | 'git'; windowId: number }
  title: string
  onBack: () => void
}): JSX.Element {
  const [handoff, setHandoff] = useState<string | null | undefined>(undefined)
  const [git, setGit] = useState<{ branch: string | null; ahead: number; behind: number; files: RemoteGitFile[]; error?: string } | null>(null)

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
      <header className="bar">
        <button className="bar-btn" onClick={onBack}>
          ‹ {t('back')}
        </button>
        <div className="bar-title">
          <span>{view.kind === 'git' ? t('git') : t('handoff')}</span>
          <small>{title}</small>
        </div>
        <div className="bar-actions" />
      </header>
      <div className="detail-body">
        {view.kind === 'handoff' &&
          (handoff === undefined ? (
            <p className="muted center">{t('connecting')}</p>
          ) : handoff === null ? (
            <p className="muted center">{t('noHandoff')}</p>
          ) : (
            <article className="markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{handoff}</ReactMarkdown>
            </article>
          ))}
        {view.kind === 'git' &&
          (!git ? (
            <p className="muted center">{t('connecting')}</p>
          ) : git.error ? (
            <p className="error inset">{git.error}</p>
          ) : (
            <>
              <p className="git-branch">
                ⎇ <b>{git.branch}</b>
                {git.ahead > 0 && <span> ↑{git.ahead}</span>}
                {git.behind > 0 && <span> ↓{git.behind}</span>}
              </p>
              <div className="group">
                {git.files.length === 0 && <div className="row muted">{t('clean')}</div>}
                {git.files.map((f) => (
                  <div className="row git-row" key={f.path}>
                    <span className={`git-flag x${f.index.trim() ? 1 : 0}`}>{(f.index + f.workingDir).trim() || '?'}</span>
                    <span className="git-path">{f.path}</span>
                  </div>
                ))}
              </div>
            </>
          ))}
      </div>
    </div>
  )
}
