import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { RemoteSession, ServerMessage } from '../../shared/remoteProtocol'
import type { RemoteConnection } from './conn'
import { t } from './i18n'
import { parsePrompt, type ParsedPrompt } from './prompt'
import { IArrowUp, IEllipsis, IHand, IStop } from './icons'
import { ConfirmSheet, Menu, NavBar } from './ui'

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
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  return dark
    ? { background: '#0b0b0f', foreground: '#e5e5ea', cursor: '#e5e5ea', selectionBackground: '#3a3a3c' }
    : { background: '#fbfbfd', foreground: '#1c1c1e', cursor: '#1c1c1e', selectionBackground: '#d1d1d6' }
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
  const [mode, setMode] = useState<'read' | 'term'>('read')
  const [lines, setLines] = useState<Line[]>([])
  const [prompt, setPrompt] = useState<ParsedPrompt | null>(null)
  const [answered, setAnswered] = useState(false)
  const [fit, setFit] = useState(false)
  const [menu, setMenu] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [text, setText] = useState('')
  const modeRef = useRef(mode)
  modeRef.current = mode

  const fitFont = useCallback((): void => {
    const term = termRef.current
    const body = bodyRef.current
    if (!term || !body || !opened.current) return
    const size = Math.max(6, Math.min(14, Math.floor(((body.clientWidth - 12) / (term.cols * monoCharRatio())) * 10) / 10))
    if (term.options.fontSize !== size) term.options.fontSize = size
  }, [])

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
      }
    })
    // 連上（或從背景回來重連）就重新 attach：伺服器會重送 snapshot
    const offState = conn.onState((s) => {
      if (s === 'open') conn.send({ t: 'attach', id })
    })
    if (conn.state === 'open') conn.send({ t: 'attach', id })
    window.addEventListener('resize', fitFont)

    return () => {
      off()
      offState()
      window.removeEventListener('resize', fitFont)
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      conn.send({ t: 'detach', id })
      // 接管過尺寸就還給電腦
      if (originalSize.current) conn.send({ t: 'resize', id, ...originalSize.current })
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
    if (mode === 'read' && term) setLines(readBuffer(term))
    stick.current = true
    requestAnimationFrame(toBottom)
  }, [mode])

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
    const body = bodyRef.current
    if (!body) return
    if (!fit) {
      originalSize.current = { cols: session.cols, rows: session.rows }
      const px = 12 * monoCharRatio()
      conn.send({
        t: 'resize',
        id,
        cols: Math.max(40, Math.floor((body.clientWidth - 32) / px)),
        rows: Math.max(12, Math.floor((body.clientHeight - 12) / 17))
      })
      setFit(true)
    } else {
      if (originalSize.current) conn.send({ t: 'resize', id, ...originalSize.current })
      originalSize.current = null
      setFit(false)
    }
  }

  const exited = exitCode !== undefined
  const showApproval = session.needsApproval && !exited && !answered

  return (
    <div className="session">
      <NavBar
        title={session.title}
        subtitle={session.workspaceName}
        backLabel={hostName}
        onBack={onBack}
        trailing={
          <button className="icon-btn" aria-label={t('more')} aria-haspopup="menu" onClick={() => setMenu(true)} disabled={exited}>
            <IEllipsis size={24} />
          </button>
        }
      >
        <div className="segmented" role="group">
          <button aria-pressed={mode === 'read'} onClick={() => setMode('read')}>
            {t('read')}
          </button>
          <button aria-pressed={mode === 'term'} onClick={() => setMode('term')}>
            {t('terminal')}
          </button>
        </div>
      </NavBar>

      <div
        className="session-body"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        <div className="reader" hidden={mode !== 'read'} aria-live="off">
          {lines.map((l, i) => (l.kind === 'rule' ? <div key={i} className="rule" /> : <div key={i} className="ln">{l.text}</div>))}
        </div>
        <div className="xterm-box" hidden={mode !== 'term'} ref={xtermHost} />
      </div>

      {exited ? (
        <div className="ended" role="status">
          <IStop size={18} /> {t('exited', { code: exitCode })}
        </div>
      ) : (
        <div className="dock glass">
          <div className="dock-inner">
            {showApproval && <Approval title={session.title} prompt={prompt} onAnswer={answer} />}
            <div className="keys" role="toolbar" aria-label={t('otherKeys')}>
              {KEYS.map((k) => (
                <button key={k.label} className="key" aria-label={k.name} onClick={() => send(k.seq)}>
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
              <div className="composer-field">
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
                <button type="submit" className="send" aria-label={t('send')}>
                  <span>
                    <IArrowUp size={18} />
                  </span>
                </button>
              </div>
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
      <div className="approval-kicker">
        <IHand size={16} />
        {t('wants', { title })}
      </div>
      {prompt?.question && (
        <p id="approval-q" className="approval-q">
          {prompt.question}
        </p>
      )}
      {prompt && prompt.details.length > 0 && <pre className="approval-details">{prompt.details.join('\n')}</pre>}
      <div className="choices">
        {options.map((o, i) => (
          <button key={o.key + i} className={`choice ${i === (primary === -1 ? 0 : primary) ? 'prominent' : ''}`} onClick={() => onAnswer(o.key)}>
            <kbd aria-hidden="true">{o.key === '\x1b' ? 'esc' : o.key}</kbd>
            <span>{o.label}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
