import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { RemoteSession, ServerMessage } from '../../shared/remoteProtocol'
import type { RemoteConnection } from './conn'
import { t } from './i18n'
import { parsePrompt, type ParsedPrompt } from './prompt'
import { IArrowUp, IMore, IStop } from './icons'
import { ConfirmSheet, Menu, NavBar } from './ui'
import { currentTheme, onThemeChange } from './theme'

// 手機上的終端畫面。
//
// 「閱讀」（預設）：從 xterm 的畫面緩衝讀出文字，依手機寬度換行、用正常字級顯示——
//   電腦上的終端是 100 多欄，硬縮到手機寬度字會小到 6px，讀不了。
// 「終端」：原樣鏡像（字縮小塞進螢幕寬），要看表格、進度條等排版時用。
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

let charRatio = 0
function monoCharRatio(): number {
  if (charRatio) return charRatio
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return 0.6
  ctx.font = `100px ${FONT}`
  charRatio = ctx.measureText('W'.repeat(10)).width / 1000 || 0.6
  return charRatio
}

type Line = { kind: 'text'; text: string } | { kind: 'rule' }

const BOX_ONLY = /^[\s│┃║╭╮╰╯┌┐└┘├┤┬┴┼─━═┏┓┗┛▔▁]+$/
const EDGE = /^[\s│┃║]+|[\s│┃║]+$/g

/** 讀出 xterm 緩衝的最後 N 行邏輯行：接回自動折行、去掉框線、多個空行合併 */
function readBuffer(term: Terminal, max = 600): Line[] {
  const buf = term.buffer.active
  const raw: string[] = []
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    const s = line.translateToString(true)
    if (line.isWrapped && raw.length) raw[raw.length - 1] += s
    else raw.push(s)
  }
  while (raw.length && !raw[raw.length - 1].trim()) raw.pop()
  const out: Line[] = []
  for (const r of raw.slice(-max)) {
    if (r.trim() && BOX_ONLY.test(r)) {
      if (out[out.length - 1]?.kind !== 'rule') out.push({ kind: 'rule' })
      continue
    }
    const text = r.replace(EDGE, '')
    const prev = out[out.length - 1]
    if (!text && (!prev || (prev.kind === 'text' && !prev.text) || prev.kind === 'rule')) continue
    out.push({ kind: 'text', text })
  }
  return out
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
  const bodyRef = useRef<HTMLDivElement>(null)
  const xtermHost = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const opened = useRef(false)
  const originalSize = useRef<{ cols: number; rows: number } | null>(null)
  const stick = useRef(true)
  const [mode, setMode] = useState<'read' | 'term' | 'preview'>('read')
  const [preview, setPreview] = useState<{ url: string | null; error: string | null }>({ url: null, error: null })
  const [lines, setLines] = useState<Line[]>([])
  const [prompt, setPrompt] = useState<ParsedPrompt | null>(null)
  const [answered, setAnswered] = useState(false)
  const [fit, setFit] = useState(false)
  const [menu, setMenu] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [text, setText] = useState('')
  const modeRef = useRef(mode)
  modeRef.current = mode
  const fitRef = useRef(false)
  fitRef.current = fit
  const autoFitDone = useRef(false)

  const fitFont = useCallback((): void => {
    const term = termRef.current
    const body = bodyRef.current
    if (!term || !body || !opened.current) return
    const width = (xtermHost.current?.parentElement?.clientWidth || body.clientWidth - 24) - 20
    const size = Math.max(6, Math.min(14, Math.floor((width / (term.cols * monoCharRatio())) * 10) / 10))
    if (term.options.fontSize !== size) term.options.fontSize = size
  }, [])

  /**
   * 把 pty 的欄數改成手機放得下的寬度。
   * 只縮字級沒有用：桌面開的 session 是 120 欄，要塞進手機得用 5px 以下的字，
   * 字級下限是 6px，所以畫面一定會超出去、只能左右拖。真正要改的是欄數。
   * 回傳有沒有真的送出 resize（本來就放得下就不去動電腦的尺寸）。
   */
  const applyFit = useCallback((): boolean => {
    const body = bodyRef.current
    if (!body || !body.clientWidth) return false
    const width = (xtermHost.current?.parentElement?.clientWidth || body.clientWidth - 24) - 20
    const px = 12 * monoCharRatio()
    const cols = Math.max(10, Math.floor(width / px))
    const rows = Math.max(12, Math.floor((body.clientHeight - 12) / 17))
    const current = termRef.current?.cols ?? session.cols
    if (cols >= current) return false
    if (!originalSize.current) originalSize.current = { cols: session.cols, rows: session.rows }
    conn.send({ t: 'resize', id, cols, rows })
    return true
  }, [conn, id, session.cols, session.rows])

  const restoreSize = useCallback((): void => {
    if (originalSize.current) conn.send({ t: 'resize', id, ...originalSize.current })
    originalSize.current = null
  }, [conn, id])

  const toBottom = (): void => {
    const b = bodyRef.current
    if (b && stick.current) b.scrollTop = b.scrollHeight
  }

  // 輸出很密時合併成每 120ms 重畫一次
  const refreshTimer = useRef<number | null>(null)
  const refresh = useCallback((): void => {
    if (refreshTimer.current) return
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null
      const term = termRef.current
      if (!term) return
      if (modeRef.current === 'read') setLines(readBuffer(term))
      setPrompt(parsePrompt(screenText(term)))
      requestAnimationFrame(toBottom)
    }, 120)
  }, [])

  useEffect(() => {
    const term = new Terminal({
      cols: session.cols,
      rows: session.rows,
      fontFamily: FONT,
      fontSize: 9,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 5000,
      allowTransparency: true, // 讓後面的玻璃透出來
      theme: termTheme()
    })
    termRef.current = term

    const off = conn.onMessage((m: ServerMessage) => {
      if (m.t === 'snapshot' && m.id === id) {
        term.reset()
        term.resize(m.cols, m.rows)
        fitFont()
        term.write(m.data, refresh)
      } else if (m.t === 'data' && m.id === id) {
        term.write(m.d, refresh)
      } else if (m.t === 'resized' && m.id === id) {
        term.resize(m.cols, m.rows)
        fitFont()
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
    window.addEventListener('resize', fitFont)
    const offTheme = onThemeChange(() => {
      term.options.theme = termTheme()
    })

    return () => {
      off()
      offState()
      window.removeEventListener('resize', fitFont)
      offTheme()
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      conn.send({ t: 'detach', id })
      // 接管過尺寸就還給電腦
      if (originalSize.current) conn.send({ t: 'resize', id, ...originalSize.current })
      originalSize.current = null
      term.dispose()
      termRef.current = null
      opened.current = false
    }
  }, [id])

  // 第一次切到「終端」才真的把 xterm 掛上 DOM（在隱藏狀態下 open 會量不到字寬）
  useEffect(() => {
    const term = termRef.current
    if (mode === 'term' && term && xtermHost.current && !opened.current) {
      term.open(xtermHost.current)
      opened.current = true
      fitFont()
    }
    // 進終端就自動配合手機寬度，不必先去選單按一次；使用者關掉後不再自動開回來
    if (mode === 'term' && !autoFitDone.current) {
      autoFitDone.current = true
      if (applyFit()) setFit(true)
    }
    if (mode === 'read' && term) setLines(readBuffer(term))
    stick.current = true
    requestAnimationFrame(toBottom)
  }, [mode, applyFit, fitFont])

  // 轉向、鍵盤收合之後寬度變了：fit 開著就重算欄數（節流，避免連續 resize 洗 pty）
  useEffect(() => {
    let timer: number | null = null
    const onResize = (): void => {
      if (!fitRef.current) return
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        applyFit()
      }, 250)
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      if (timer) window.clearTimeout(timer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [applyFit])

  // 新的審批出現就重新可以按
  useEffect(() => {
    if (session.needsApproval) setAnswered(false)
  }, [session.needsApproval])

  const send = (seq: string): void => {
    stick.current = true
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

  const toggleFit = (): void => {
    if (fit) {
      restoreSize()
      setFit(false)
    } else if (applyFit()) {
      setFit(true)
    }
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
          data-index={mode === 'read' ? 0 : mode === 'term' ? 1 : 2}
          style={{ '--seg': canPreview ? 3 : 2 } as React.CSSProperties}
        >
          <button aria-pressed={mode === 'read'} onClick={() => setMode('read')}>
            {t('read')}
          </button>
          <button aria-pressed={mode === 'term'} onClick={() => setMode('term')}>
            {t('terminal')}
          </button>
          {canPreview && (
            <button aria-pressed={mode === 'preview'} onClick={openPreview}>
              {t('preview')}
            </button>
          )}
        </div>
      </NavBar>

      <div
        className="session-body"
        hidden={mode === 'preview'}
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        <div className="output">
          <div className="reader" hidden={mode !== 'read'} aria-live="off">
            {lines.map((l, i) => (l.kind === 'rule' ? <div key={i} className="rule" /> : <div key={i} className="ln">{l.text}</div>))}
          </div>
          <div className="xterm-scroll" hidden={mode !== 'term'}>
            <div className="xterm-box" ref={xtermHost} />
          </div>
        </div>
      </div>

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
            { label: t('fitWidth'), note: t('fitWidthNote'), checked: fit, onSelect: toggleFit },
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
