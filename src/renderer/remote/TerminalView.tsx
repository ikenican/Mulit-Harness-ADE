import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { RemoteSession, ServerMessage } from '../../shared/remoteProtocol'
import type { RemoteConnection } from './conn'
import { t } from './i18n'
import { parsePrompt, type ParsedPrompt } from './prompt'
import { IArrowUp, IMore, IStop } from './icons'
import { ConfirmSheet, Menu, NavBar } from './ui'
import { currentTheme, onThemeChange } from './theme'
import { FilePane, StatusPane } from './WorkspacePanes'

// 手機上的終端畫面。
//
// 保留桌面的字元座標；手機以原生捲動查看歷史及超出寬度的內容。
//
// 輸入不直接打進 xterm（iOS 軟鍵盤對 xterm 的隱藏 textarea 很不穩），改用下方輸入框與按鍵列。

const KEYS: Array<{ label: string; name: string; seq: string }> = [
  { label: 'esc', name: 'Escape', seq: '\x1b' },
  { label: 'tab', name: 'Tab', seq: '\t' },
  { label: '⇧tab', name: 'Shift Tab', seq: '\x1b[Z' },
  { label: '⌃C', name: 'Control C', seq: '\x03' },
  { label: '↑', name: 'Up', seq: '\x1b[A' },
  { label: '↓', name: 'Down', seq: '\x1b[B' },
  { label: '←', name: 'Left', seq: '\x1b[D' },
  { label: '→', name: 'Right', seq: '\x1b[C' }
]

const FONT = "ui-monospace, 'SF Mono', Menlo, monospace"

function termTheme(): Record<string, string> {
  const dark = currentTheme() === 'dark'
  return dark
    ? { background: '#00000000', foreground: '#e2ded6', cursor: '#79a3a3', selectionBackground: '#30363c' }
    : { background: '#00000000', foreground: '#202428', cursor: '#486a6d', selectionBackground: '#dfd9cf' }
}

function screenText(term: Terminal, lines = 24): string {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = Math.max(0, buf.baseY + buf.cursorY - lines); y <= buf.baseY + buf.cursorY; y++) {
    out.push(buf.getLine(y)?.translateToString(true) ?? '')
  }
  return out.join('\n')
}

export default function TerminalView({
  conn,
  session,
  hostName,
  exitCode,
  onBack
}: {
  conn: RemoteConnection
  session: RemoteSession
  hostName: string
  exitCode: number | undefined
  onBack: () => void
}): JSX.Element {
  const id = session.id
  const scrollRef = useRef<HTMLDivElement>(null)
  const spaceRef = useRef<HTMLDivElement>(null)
  const xtermHost = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const opened = useRef(false)
  const followOutput = useRef(true)
  const fitAddon = useRef<FitAddon | null>(null)
  const [mode, setMode] = useState<'status' | 'term' | 'file' | 'preview'>('term')
  const [filePath, setFilePath] = useState('')
  const [preview, setPreview] = useState<{ url: string | null; error: string | null }>({ url: null, error: null })
  const [prompt, setPrompt] = useState<ParsedPrompt | null>(null)
  const [answered, setAnswered] = useState(false)
  const [menu, setMenu] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [text, setText] = useState('')
  const modeRef = useRef(mode)
  modeRef.current = mode

  const syncScroll = useCallback((): void => {
    const term = termRef.current
    const scroll = scrollRef.current
    const space = spaceRef.current
    const screen = term?.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!term || !scroll || !space || !screen || modeRef.current !== 'term') return
    const cellHeight = screen.offsetHeight / term.rows
    if (!cellHeight) return
    // Only vertical scrolling for history. The terminal width fits the phone screen.
    space.style.height = `${term.buffer.active.baseY * cellHeight + Math.max(screen.offsetHeight + 20, scroll.clientHeight)}px`
    if (followOutput.current && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 2) {
      scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight
    }
    term.scrollToLine(Math.round(scroll.scrollTop / cellHeight))
  }, [])

  const applyFit = useCallback((): void => {
    const term = termRef.current
    const scroll = scrollRef.current
    const host = xtermHost.current
    if (!term || !scroll || !host || !opened.current || modeRef.current !== 'term') return
    const dims = fitAddon.current?.proposeDimensions()
    const screen = host.querySelector<HTMLElement>('.xterm-screen')
    const cellWidth = screen && term.cols ? (screen.offsetWidth / term.cols) : 7.2
    const cellHeight = screen && term.rows ? (screen.offsetHeight / term.rows) : 15
    const width = Math.max(80, scroll.clientWidth - 20)
    const height = Math.max(80, scroll.clientHeight)
    const cols = dims?.cols ? Math.max(10, dims.cols) : Math.max(10, Math.floor(width / (cellWidth || 7.2)))
    const rows = Math.max(5, Math.floor(height / (cellHeight || 15)))
    if (term.cols !== cols || term.rows !== rows) {
      term.resize(cols, rows)
    }
    syncScroll()
  }, [syncScroll])

  const onScroll = (): void => {
    const scroll = scrollRef.current
    if (!scroll) return
    followOutput.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2
    syncScroll()
  }

  // 輸出很密時合併成每 120ms 重畫一次
  const refreshTimer = useRef<number | null>(null)
  const refresh = useCallback((): void => {
    if (refreshTimer.current) return
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null
      const term = termRef.current
      if (!term) return
      setPrompt(parsePrompt(screenText(term)))
    }, 120)
  }, [])

  useEffect(() => {
    const term = new Terminal({
      fontFamily: FONT,
      fontSize: 12,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 5000,
      allowTransparency: true, // 讓後面的玻璃透出來
      theme: termTheme()
    })
    termRef.current = term
    const addon = new FitAddon()
    term.loadAddon(addon)
    fitAddon.current = addon
    followOutput.current = true
    const rendered = term.onRender(syncScroll)
    // CLI redraws may erase saved lines. Keep the mobile history available to read.
    const keepHistory = term.parser.registerCsiHandler({ final: 'J' }, params => params[0] === 3)

    const off = conn.onMessage((m: ServerMessage) => {
      if (m.t === 'snapshot' && m.id === id) {
        term.reset()
        applyFit()
        term.write(m.data, () => {
          syncScroll()
          refresh()
        })
      } else if (m.t === 'data' && m.id === id) {
        term.write(m.d, () => { syncScroll(); refresh() })
      } else if (m.t === 'resized' && m.id === id) {
        // Desktop window resized. Mobile keeps its own fitted cols.
        syncScroll()
        refresh()
      } else if (m.t === 'preview' && m.id === id) {
        setPreview({ url: m.url, error: m.url ? null : m.error || 'preview unavailable' })
      }
    })
    // 連上（或從背景回來重連）就重新 attach：伺服器會重送 snapshot
    const offState = conn.onState((s) => {
      if (s === 'open') conn.send({ t: 'attach', id })
    })
    if (conn.state === 'open') conn.send({ t: 'attach', id })
    const offTheme = onThemeChange(() => {
      term.options.theme = termTheme()
    })

    return () => {
      off()
      offState()
      rendered.dispose()
      keepHistory.dispose()
      offTheme()
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      conn.send({ t: 'detach', id })
      term.dispose()
      termRef.current = null
      fitAddon.current = null
      opened.current = false
    }
  }, [id, applyFit, syncScroll])

  // 第一次切到「終端」才真的把 xterm 掛上 DOM（在隱藏狀態下 open 會量不到字寬）
  useEffect(() => {
    const term = termRef.current
    if (mode === 'term' && term && xtermHost.current && !opened.current) {
      term.open(xtermHost.current)
      opened.current = true
    }
    if (mode === 'term') applyFit()
  }, [mode, applyFit])

  // The body changes on rotation and when the mobile keyboard/dock opens.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(applyFit, 100)
    })
    if (scrollRef.current) observer.observe(scrollRef.current)
    document.fonts.addEventListener('loadingdone', applyFit)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
      document.fonts.removeEventListener('loadingdone', applyFit)
    }
  }, [applyFit])

  // 新的審批出現就重新可以按
  useEffect(() => {
    if (session.needsApproval) setAnswered(false)
  }, [session.needsApproval])

  const send = (seq: string): void => {
    conn.send({ t: 'input', id, data: seq })
  }

  // 文字與 Enter 分兩次送：Claude Code 會把同一批到達的「文字＋換行」當成貼上，變成插入換行而不是送出。
  // 多行文字用 bracketed paste 包起來。
  const submit = (): void => {
    const value = text
    setText('')
    if (!value) return send('\r')
    send(value.includes('\n') ? `\x1b[200~${value}\x1b[201~` : value)
    window.setTimeout(() => send('\r'), 60)
  }

  const answer = (key: string): void => {
    setAnswered(true)
    send(key)
  }

  const exited = exitCode !== undefined
  const showApproval = session.needsApproval && !exited && !answered
  // 只有這個終端真的印出過 dev server 網址才有預覽可看
  const canPreview = !!session.devPort
  // 每次點「預覽」都換一張新 ticket：ticket 是一次性的，重進來要重發
  const openPreview = (): void => {
    setPreview({ url: null, error: null })
    setMode('preview')
    conn.send({ t: 'preview', id })
  }

  return (
    <div className="session">
      <NavBar
        title={session.title}
        subtitle={session.workspaceName}
        backLabel={hostName}
        onBack={onBack}
        trailing={
          <button className="circle-btn press" aria-label={t('more')} aria-haspopup="menu" onClick={() => setMenu(true)} disabled={exited}>
            <IMore size={22} />
          </button>
        }
      >
        <div
          className="segmented"
          role="group"
          data-index={mode === 'status' ? 0 : mode === 'term' ? 1 : mode === 'file' ? 2 : 3}
          style={{ '--seg': canPreview ? 4 : 3 } as React.CSSProperties}
        >
          <button aria-pressed={mode === 'status'} onClick={() => setMode('status')}>
            {t('status')}
          </button>
          <button aria-pressed={mode === 'term'} onClick={() => setMode('term')}>
            {t('terminal')}
          </button>
          <button aria-pressed={mode === 'file'} onClick={() => { setFilePath(''); setMode('file') }}>
            {t('file')}
          </button>
          {canPreview && (
            <button aria-pressed={mode === 'preview'} onClick={openPreview}>
              {t('preview')}
            </button>
          )}
        </div>
      </NavBar>

      <div
        className="session-body terminal-body"
        hidden={mode !== 'term'}
      >
        <div className="output">
          <div className="xterm-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className="terminal-scroll-space" ref={spaceRef}>
              <div
                className="xterm-box"
                ref={xtermHost}
                // Let the browser scroll with inertia instead of xterm's touchmove handler.
                onTouchStartCapture={(e) => e.stopPropagation()}
                onTouchMoveCapture={(e) => e.stopPropagation()}
                onWheelCapture={(e) => e.stopPropagation()}
              />
            </div>
          </div>
        </div>
      </div>

      {mode === 'status' && <div className="workspace-pane"><StatusPane conn={conn} windowId={session.windowId}
        onFile={path => { setFilePath(path); setMode('file') }} onPreview={canPreview ? openPreview : undefined} /></div>}
      {mode === 'file' && <div className="workspace-pane"><FilePane key={filePath} conn={conn} windowId={session.windowId} initialPath={filePath} /></div>}

      {/* 成品預覽：桌面把終端印出的 dev server 代理成 https 送過來，所以這裡放 iframe 就好 */}
      {canPreview && (
        <div className="preview-pane" hidden={mode !== 'preview'}>
          {preview.url ? (
            <iframe key={preview.url} src={preview.url} className="preview-frame" title={t('preview')} />
          ) : (
            <p className="empty">{preview.error || t('loading')}</p>
          )}
        </div>
      )}

      {exited ? (
        <div className="ended" role="status">
          <span className="pill idle">
            <IStop size={14} /> {t('exited', { code: exitCode })}
          </span>
        </div>
      ) : (
        <div className="dock">
          <div className="dock-inner">
            {showApproval && <Approval title={session.title} prompt={prompt} onAnswer={answer} />}
            <div className="keys" role="toolbar" aria-label={t('otherKeys')}>
              {KEYS.map((k) => (
                <button key={k.label} className="key press" aria-label={k.name} onClick={() => send(k.seq)}>
                  {k.label}
                </button>
              ))}
            </div>
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault()
                submit()
              }}
            >
                <textarea
                  value={text}
                  rows={1}
                  aria-label={t('composer')}
                  placeholder={t('composer')}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="send"
                  onChange={(e) => {
                    setText(e.target.value)
                    e.target.style.height = 'auto'
                    e.target.style.height = `${e.target.scrollHeight}px`
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      submit()
                    }
                  }}
                />
                <button type="submit" className="send press" aria-label={t('send')}>
                  <IArrowUp size={20} />
                </button>
            </form>
          </div>
        </div>
      )}

      {menu && (
        <Menu
          onClose={() => setMenu(false)}
          items={[
            { label: t('endSession'), destructive: true, icon: <IStop size={20} />, onSelect: () => setConfirmEnd(true) }
          ]}
        />
      )}
      {confirmEnd && (
        <ConfirmSheet
          title={t('endConfirmTitle', { title: session.title })}
          message={t('endConfirmBody')}
          action={t('endSession')}
          onCancel={() => setConfirmEnd(false)}
          onConfirm={() => {
            setConfirmEnd(false)
            conn.send({ t: 'kill', id })
            onBack()
          }}
        />
      )}
    </div>
  )
}

/**
 * 審批面板：這個 App 的招牌。把 CLI 畫面上的問題、要執行的內容、每個選項的原文
 * 直接做成按鈕——在手機上一眼看懂要答應什麼，點一下就回覆。
 * CLI 目前選取的預設選項用主要樣式；解析不出選項時退回數字鍵。
 */
function Approval({
  title,
  prompt,
  onAnswer
}: {
  title: string
  prompt: ParsedPrompt | null
  onAnswer: (key: string) => void
}): JSX.Element {
  const options = prompt?.options.length
    ? prompt.options
    : ['1', '2', '3'].map((k, i) => ({ key: k, label: k, selected: i === 0 }))
  const primary = options.findIndex((o) => o.selected)
  return (
    <section className="approval" role="alertdialog" aria-labelledby="approval-q">
      <span className="pill wait">
        <span className="dot" />
        {t('wants', { title })}
      </span>
      {prompt?.question && (
        <p id="approval-q" className="approval-q">
          {prompt.question}
        </p>
      )}
      {prompt && prompt.details.length > 0 && <pre className="approval-details">{prompt.details.join('\n')}</pre>}
      <div className="choices">
        {options.map((o, i) => (
          <button key={o.key + i} className={`choice press ${i === (primary === -1 ? 0 : primary) ? 'prominent' : ''}`} onClick={() => onAnswer(o.key)}>
            <kbd aria-hidden="true">{o.key === '\x1b' ? 'esc' : o.key}</kbd>
            <span>{o.label}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
