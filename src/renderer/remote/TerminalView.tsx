import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { RemoteSession, ServerMessage } from '../../shared/remoteProtocol'
import type { RemoteConnection } from './conn'
import { t } from './i18n'

// 手機上的終端畫面。
//
// 預設「鏡像」：xterm 的欄列數跟桌面 pty 一致，只把字縮小到塞得進螢幕寬度，
// 桌面畫面完全不受影響。按「符合螢幕」才會真的把 pty resize 成手機尺寸（桌面會跟著變窄），
// 離開畫面或再按一次就還原成原本的大小。
//
// 輸入不直接打進 xterm（iOS 軟鍵盤對 xterm 的隱藏 textarea 很不穩），改用下方輸入框 + 特殊鍵列。

const KEYS: Array<{ label: string; seq: string }> = [
  { label: 'esc', seq: '\x1b' },
  { label: 'tab', seq: '\t' },
  { label: '⇧tab', seq: '\x1b[Z' },
  { label: '^C', seq: '\x03' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: 'y', seq: 'y' },
  { label: 'n', seq: 'n' },
  { label: '^D', seq: '\x04' },
  { label: '/', seq: '/' }
]

function termTheme(): Record<string, string> {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  return dark
    ? { background: '#000000', foreground: '#e5e5ea', cursor: '#e5e5ea', selectionBackground: '#3a3a3c' }
    : { background: '#ffffff', foreground: '#1c1c1e', cursor: '#1c1c1e', selectionBackground: '#d1d1d6' }
}

/** 等寬字的「字寬 / 字級」比例，用來算要多小的字才塞得進 cols 欄 */
let charRatio = 0
function monoCharRatio(fontFamily: string): number {
  if (charRatio) return charRatio
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return 0.6
  ctx.font = `100px ${fontFamily}`
  charRatio = ctx.measureText('W'.repeat(10)).width / 1000 || 0.6
  return charRatio
}

const FONT = "ui-monospace, 'SF Mono', Menlo, monospace"

/** 從 xterm 畫面讀最後幾行非空白文字，給審批卡片顯示提示內容 */
function screenTail(term: Terminal, lines: number): string {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = buf.baseY + buf.cursorY; y >= 0 && out.length < lines; y--) {
    const line = buf.getLine(y)?.translateToString(true).trimEnd()
    if (line) out.unshift(line)
  }
  return out.join('\n')
}

export default function TerminalView({
  conn,
  session,
  exitCode,
  onBack
}: {
  conn: RemoteConnection
  session: RemoteSession
  exitCode: number | undefined
  onBack: () => void
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const originalSize = useRef<{ cols: number; rows: number } | null>(null)
  const stickBottom = useRef(true)
  const [fit, setFit] = useState(false)
  const [text, setText] = useState('')
  const [tail, setTail] = useState('')
  const id = session.id

  // 依目前 pty 欄數把字縮到剛好塞進螢幕寬
  const fitFont = (): void => {
    const term = termRef.current
    const wrap = wrapRef.current
    if (!term || !wrap) return
    const width = wrap.clientWidth - 8
    const size = Math.max(5, Math.min(13, Math.floor((width / (term.cols * monoCharRatio(FONT))) * 10) / 10))
    if (term.options.fontSize !== size) term.options.fontSize = size
  }

  const scrollToBottom = (): void => {
    const wrap = wrapRef.current
    if (wrap && stickBottom.current) wrap.scrollTop = wrap.scrollHeight
  }

  useEffect(() => {
    const term = new Terminal({
      cols: session.cols,
      rows: session.rows,
      fontFamily: FONT,
      fontSize: 9,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 5000,
      theme: termTheme()
    })
    termRef.current = term
    term.open(hostRef.current!)
    fitFont()

    const refreshTail = (): void => setTail(screenTail(term, 8))

    const off = conn.onMessage((m: ServerMessage) => {
      if (m.t === 'snapshot' && m.id === id) {
        term.reset()
        term.resize(m.cols, m.rows)
        fitFont()
        term.write(m.data, () => {
          refreshTail()
          scrollToBottom()
        })
      } else if (m.t === 'data' && m.id === id) {
        term.write(m.d, () => {
          refreshTail()
          scrollToBottom()
        })
      } else if (m.t === 'resized' && m.id === id) {
        term.resize(m.cols, m.rows)
        fitFont()
      }
    })
    // 連上（或背景回來重連）就重新 attach：伺服器會重送 snapshot
    const offState = conn.onState((s) => {
      if (s === 'open') conn.send({ t: 'attach', id })
    })
    if (conn.state === 'open') conn.send({ t: 'attach', id })

    const onResize = (): void => fitFont()
    window.addEventListener('resize', onResize)

    return () => {
      off()
      offState()
      window.removeEventListener('resize', onResize)
      conn.send({ t: 'detach', id })
      // 有接管尺寸就還給桌面
      if (originalSize.current) {
        conn.send({ t: 'resize', id, ...originalSize.current })
        originalSize.current = null
      }
      term.dispose()
      termRef.current = null
    }
  }, [id])

  const toggleFit = (): void => {
    const wrap = wrapRef.current
    if (!wrap) return
    if (!fit) {
      originalSize.current = { cols: session.cols, rows: session.rows }
      const fontSize = 11
      const cols = Math.floor((wrap.clientWidth - 8) / (fontSize * monoCharRatio(FONT)))
      const rows = Math.floor((wrap.clientHeight - 8) / (fontSize * 1.2))
      conn.send({ t: 'resize', id, cols, rows })
      setFit(true)
    } else {
      if (originalSize.current) conn.send({ t: 'resize', id, ...originalSize.current })
      originalSize.current = null
      setFit(false)
    }
  }

  const sendRaw = (seq: string): void => {
    stickBottom.current = true
    conn.send({ t: 'input', id, data: seq })
  }

  // 文字與 Enter 分兩次送：部分 CLI（例如 Claude Code）會把同一批到達的「文字+換行」當成貼上，
  // 變成插入換行而不是送出。多行文字用 bracketed paste 包起來，避免每行都被當成一次送出。
  const submit = (): void => {
    const value = text
    setText('')
    if (!value) return sendRaw('\r')
    const payload = value.includes('\n') ? `\x1b[200~${value}\x1b[201~` : value
    sendRaw(payload)
    window.setTimeout(() => sendRaw('\r'), 60)
  }

  const kill = (): void => {
    if (window.confirm(t('killConfirm', { title: session.title }))) {
      conn.send({ t: 'kill', id })
      onBack()
    }
  }

  const exited = exitCode !== undefined

  return (
    <div className="term-screen">
      <header className="bar">
        <button className="bar-btn" onClick={onBack} aria-label={t('back')}>
          ‹ {t('back')}
        </button>
        <div className="bar-title">
          <span>{session.title}</span>
          <small>{session.workspaceName}</small>
        </div>
        <div className="bar-actions">
          <button className={`chip ${fit ? 'on' : ''}`} onClick={toggleFit} disabled={exited}>
            {t('fit')}
          </button>
          <button className="chip danger" onClick={kill} disabled={exited} aria-label={t('kill')}>
            ✕
          </button>
        </div>
      </header>

      <div
        className="term-wrap"
        ref={wrapRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        <div ref={hostRef} className="term-host" />
      </div>

      {exited && <div className="exit-note">{t('exited', { code: exitCode })}</div>}

      {session.needsApproval && !exited && (
        <div className="approval-card" role="alert">
          <div className="approval-head">⏳ {t('approvalTitle', { title: session.title })}</div>
          <pre className="approval-tail">{tail}</pre>
          <div className="approval-actions">
            <button className="btn primary" onClick={() => sendRaw('1')}>
              1
            </button>
            <button className="btn" onClick={() => sendRaw('2')}>
              2
            </button>
            <button className="btn" onClick={() => sendRaw('3')}>
              3
            </button>
            <button className="btn" onClick={() => sendRaw('\r')}>
              ⏎
            </button>
            <button className="btn" onClick={() => sendRaw('\x1b')}>
              esc
            </button>
          </div>
        </div>
      )}

      {!exited && (
        <div className="input-dock">
          <div className="keys" role="toolbar">
            {KEYS.map((k) => (
              <button key={k.label} className="key" onClick={() => sendRaw(k.seq)}>
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
              placeholder={t('composer')}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="send"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <button type="submit" className="send" aria-label={t('send')}>
              ↑
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
