import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Terminal, type IBufferCell } from '@xterm/xterm'
import type { RemoteSession, ServerMessage } from '../../shared/remoteProtocol'
import type { RemoteConnection } from './conn'
import { t } from './i18n'
import { parsePrompt, type ParsedPrompt } from './prompt'
import { IArrowUp, IMore, IStop } from './icons'
import { ConfirmSheet, Menu, NavBar } from './ui'
import { FilePane, StatusPane } from './WorkspacePanes'

// 手機上的終端畫面。
//
// 用桌面字元座標解析 ANSI，再以可讀字級換行；手機只需原生垂直捲動。
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

const ANSI_COLORS = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec']
type OutputRun = { text: string; style: CSSProperties; key: string }
type OutputLine = { text: string; runs: OutputRun[] }

function cellColor(cell: IBufferCell, foreground: boolean): string | undefined {
  const value = foreground ? cell.getFgColor() : cell.getBgColor()
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return `#${value.toString(16).padStart(6, '0')}`
  if (!(foreground ? cell.isFgPalette() : cell.isBgPalette())) return undefined
  if (value < 16) return ANSI_COLORS[value]
  if (value >= 232) return `rgb(${Array(3).fill(8 + (value - 232) * 10).join(',')})`
  const n = value - 16
  return `rgb(${[Math.floor(n / 36), Math.floor(n / 6) % 6, n % 6].map(v => v ? 55 + v * 40 : 0).join(',')})`
}

function cellStyle(cell: IBufferCell): CSSProperties {
  const fg = cellColor(cell, true), bg = cellColor(cell, false)
  return {
    color: cell.isInverse() ? bg || 'var(--term-bg)' : fg,
    backgroundColor: cell.isInverse() ? fg || 'var(--term-fg)' : bg,
    fontWeight: cell.isBold() ? 'bold' : undefined,
    fontStyle: cell.isItalic() ? 'italic' : undefined,
    opacity: cell.isDim() ? 0.6 : undefined,
    visibility: cell.isInvisible() ? 'hidden' : undefined,
    textDecoration: [cell.isUnderline() && 'underline', cell.isStrikethrough() && 'line-through', cell.isOverline() && 'overline'].filter(Boolean).join(' ') || undefined
  }
}

function outputLines(term: Terminal, cursorVisible: boolean): OutputLine[] {
  const buf = term.buffer.active
  const lines: OutputLine[] = []
  const cell = buf.getNullCell()
  let last = buf.length - 1
  // Do not display the unused rows below the prompt as a large empty screen.
  while (last > buf.baseY + buf.cursorY && !buf.getLine(last)?.translateToString(true)) last--
  // ponytail: scan the existing 5000-line buffer at most every 120ms; incremental rows if profiling requires it.
  for (let y = 0; y <= last; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    if (!line.isWrapped || !lines.length) lines.push({ text: '', runs: [] })
    const out = lines[lines.length - 1]
    let end = term.cols
    if (buf.getLine(y + 1)?.isWrapped) {
      // xterm leaves an empty last cell when a wide character wraps; it is not a space.
      while (end > 0 && !line.getCell(end - 1, cell)?.getChars()) end--
    } else {
      while (end > 0 && !line.getCell(end - 1, cell)?.getChars().trim()) end--
    }
    const cursorX = cursorVisible && y === buf.baseY + buf.cursorY ? Math.min(buf.cursorX, term.cols - 1) : -1
    end = Math.max(end, cursorX + 1)
    for (let x = 0; x < end; x++) {
      line.getCell(x, cell)
      if (!cell.getWidth()) continue // second cell of a CJK character
      const text = cell.getChars() || ' '
      const attributes = cell.isAttributeDefault() ? '' : [cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(),
        cell.isBold(), cell.isItalic(), cell.isDim(), cell.isInvisible(), cell.isInverse(), cell.isUnderline(), cell.isStrikethrough(), cell.isOverline()].join(',')
      const cursor = x === cursorX
      const key = attributes + (cursor ? ',cursor' : '')
      const previous = out.runs[out.runs.length - 1]
      if (previous?.key === key) previous.text += text
      else out.runs.push({ text, key, style: { ...(attributes ? cellStyle(cell) : {}),
        boxShadow: cursor ? 'inset 0 0 0 1px var(--accent)' : undefined } })
      out.text += text
    }
  }
  return lines
}

function screenText(term: Terminal, lines = term.rows): string {
  const buf = term.buffer.active
  const out: string[] = []
  // TUIs can park the cursor above the prompt (e.g. on a spinner); read up to the last drawn row instead.
  let end = buf.length - 1
  while (end > 0 && !buf.getLine(end)?.translateToString(true).trim()) end--
  for (let y = Math.max(0, end - lines); y <= end; y++) {
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
  const outputRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const followOutput = useRef(true)
  const scrollPosition = useRef(0)
  const cursorVisible = useRef(true)
  const [output, setOutput] = useState<OutputLine[]>([])
  const [mode, setMode] = useState<'status' | 'term' | 'file' | 'preview'>('term')
  const [filePath, setFilePath] = useState('')
  const [preview, setPreview] = useState<{ url: string | null; error: string | null }>({ url: null, error: null })
  const [promptScreen, setPromptScreen] = useState('')
  const [answered, setAnswered] = useState(false)
  const [menu, setMenu] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [text, setText] = useState('')

  const scrollToLatest = useCallback((): void => {
    const scroll = scrollRef.current
    const output = outputRef.current
    if (!scroll?.clientHeight || !output) return
    // A CLI clear-screen can shorten the output. Do not clamp a reader out of history.
    output.style.minHeight = followOutput.current ? '' : `${scrollPosition.current + scroll.clientHeight + 3}px`
    scroll.scrollTop = followOutput.current ? scroll.scrollHeight : scrollPosition.current
  }, [])

  const onScroll = (): void => {
    const scroll = scrollRef.current
    // Hidden panes have no scroll geometry; retain the reader's position.
    if (scroll?.clientHeight) {
      scrollPosition.current = scroll.scrollTop
      followOutput.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2
      if (followOutput.current && outputRef.current?.style.minHeight) scrollToLatest()
    }
  }

  // 輸出很密時合併成每 120ms 重畫一次
  const refreshTimer = useRef<number | null>(null)
  const refresh = useCallback((): void => {
    if (refreshTimer.current) return
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null
      const term = termRef.current
      if (!term) return
      setOutput(outputLines(term, cursorVisible.current))
      setPromptScreen(screenText(term))
    }, 120)
  }, [])

  useEffect(() => {
    const term = new Terminal({
      cols: session.cols || 120,
      rows: session.rows || 40,
      disableStdin: true,
      // 跟桌面 main 的 headless 畫面同設定（pty.ts）：snapshot 之後照同樣的輸出與 resize 順序處理，畫面就一樣
      scrollback: 5000,
      windowsPty: { backend: 'conpty' }
    })
    termRef.current = term
    followOutput.current = true
    scrollPosition.current = 0
    setOutput([])
    setPromptScreen('')
    cursorVisible.current = true
    const cursorModes = ['h', 'l'].map(final => term.parser.registerCsiHandler({ prefix: '?', final }, params => {
      if (params.includes(25)) cursorVisible.current = final === 'h'
      return false // xterm still processes the mode for the canonical buffer
    }))

    const off = conn.onMessage((m: ServerMessage) => {
      // reset/resize 都排在已收到的輸出後面：reset 不會清掉 xterm 還沒處理的輸出，直接呼叫的話舊輸出會畫到新畫面上
      if (m.t === 'snapshot' && m.id === id) {
        term.write('', () => {
          term.reset()
          cursorVisible.current = true
          if (m.cols && m.rows) term.resize(m.cols, m.rows)
        })
        term.write(m.data, refresh)
      } else if (m.t === 'data' && m.id === id) {
        term.write(m.d, refresh)
      } else if (m.t === 'resized' && m.id === id) {
        term.write('', () => {
          if (m.cols && m.rows) term.resize(m.cols, m.rows)
          refresh()
        })
      } else if (m.t === 'preview' && m.id === id) {
        setPreview({ url: m.url, error: m.url ? null : m.error || 'preview unavailable' })
      }
    })
    // 連上（或從背景回來重連）就重新 attach：伺服器會重送 snapshot
    const offState = conn.onState((s) => {
      if (s === 'open') conn.send({ t: 'attach', id })
    })
    if (conn.state === 'open') conn.send({ t: 'attach', id })

    return () => {
      off()
      offState()
      cursorModes.forEach(handler => handler.dispose())
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = null
      conn.send({ t: 'detach', id })
      term.dispose()
      termRef.current = null
    }
    // Snapshot/resized messages own geometry; state broadcasts must not recreate the parser.
  }, [conn, id, refresh])

  useLayoutEffect(scrollToLatest, [output, mode, scrollToLatest])

  // CSS wraps on rotation/keyboard changes; only the native scroll position needs syncing.
  useEffect(() => {
    const observer = new ResizeObserver(scrollToLatest)
    if (scrollRef.current) observer.observe(scrollRef.current)
    if (outputRef.current) observer.observe(outputRef.current)
    return () => observer.disconnect()
  }, [scrollToLatest])

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
  const prompt = showApproval ? parsePrompt(promptScreen) : null
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
            <div className="terminal-text" ref={outputRef} role="log" aria-live="off" aria-label={t('terminal')}>
              {output.map((line, y) => (
                <div key={y} className={/^[\s─━═┄┅┈┉╌╍-]{8,}$/.test(line.text) ? 'terminal-line terminal-rule' : 'terminal-line'}>
                  {line.runs.length ? line.runs.map((run, x) => <span key={x} style={run.style}>{run.text}</span>) : '\u00a0'}
                </div>
              ))}
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
            {showApproval && <Approval title={session.title} prompt={prompt} screen={promptScreen} onAnswer={answer} />}
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
 * CLI 目前選取的預設選項用主要樣式；解析不出選項時顯示原文，用既有按鍵回覆。
 */
function Approval({
  title,
  prompt,
  screen,
  onAnswer
}: {
  title: string
  prompt: ParsedPrompt | null
  screen: string
  onAnswer: (key: string) => void
}): JSX.Element {
  const options = prompt?.options || []
  const primary = options.findIndex((o) => o.selected)
  return (
    <section className="approval" role="alertdialog" aria-labelledby="approval-q">
      <span id={prompt?.question ? undefined : 'approval-q'} className="pill wait">
        <span className="dot" />
        {t('wants', { title })}
      </span>
      {prompt?.question && (
        <p id="approval-q" className="approval-q">
          {prompt.question}
        </p>
      )}
      {prompt && prompt.details.length > 0 && <pre className="approval-details">{prompt.details.join('\n')}</pre>}
      {!prompt && <>
        <p className="approval-q">{t('promptFallback')}</p>
        <pre className="approval-details">{screen.trim() || t('loading')}</pre>
      </>}
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
