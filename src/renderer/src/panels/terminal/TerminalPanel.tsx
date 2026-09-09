import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import { useWorkbench } from '@/store'
import { looksLikeApprovalPrompt } from './approvalDetect'
import type { CliLauncher } from '../../../../preload/index'

interface TerminalSession {
  id: string
  title: string
  /** 啟動用的 key：launcher yaml 的 id，或內建 CLI／shell 的名稱 */
  launcherKey: string
  term: Terminal
  fitAddon: FitAddon
  ptyId?: string
  disposables: (() => void)[]
  isExited: boolean
  needsApproval: boolean
}

const BUILTIN_CLIS = ['claude', 'codex', 'antigravity'] as const

// 一般 shell：不是 agent，但常需要在同一個工作區開一個來跑指令。
// 實際執行檔由 main 端 resolveCommand 依平台決定。
const isWindows = navigator.userAgent.includes('Windows')
const BUILTIN_SHELLS: { id: string; label: string }[] = isWindows
  ? [
      { id: 'powershell', label: 'PowerShell' },
      { id: 'cmd', label: 'Command Prompt' }
    ]
  : [
      { id: 'bash', label: 'bash' },
      { id: 'pwsh', label: 'PowerShell (pwsh)' }
    ]

const SHELL_IDS = BUILTIN_SHELLS.map((s) => s.id)
/** 直接以指令啟動（非 launcher yaml）的項目 */
const DIRECT_IDS: string[] = [...BUILTIN_CLIS, ...SHELL_IDS]

/**
 * 以 bracketed paste 包裝：終端與 readline 會把中間內容當成「貼上」，
 * 換行不會被解讀成 Enter。少了這層，多行內容會被一行一行送出去執行。
 */
function wrapPaste(text: string): string {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  return `\x1b[200~${clean}\x1b[201~`
}

/** 取終端內容：優先使用者選取範圍，沒有就抓可視區尾端數行 */
function readTerm(term: Terminal, maxLines = 60): string {
  const sel = term.getSelection()
  if (sel && sel.trim()) return sel.trim()
  const buf = term.buffer.active
  const end = buf.baseY + buf.cursorY
  const lines: string[] = []
  for (let i = Math.max(0, end - maxLines); i <= end; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export default function TerminalPanel(): JSX.Element {
  const { theme, terminalDispatch } = useWorkbench()
  const [launchers, setLaunchers] = useState<CliLauncher[]>([])
  const [selectedLauncher, setSelectedLauncher] = useState<string>('')
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  // 讓非同步的送出流程讀得到最新 sessions（ptyId 是 spawn 後才填的）
  const sessionsRef = useRef<TerminalSession[]>([])
  sessionsRef.current = sessions
  const lastDispatch = useRef(0)

  /**
   * 送文字到指定 session。剛建立的終端 ptyId 還沒回來，短暫重試等它就緒。
   * ponytail: 輪詢上限 6 秒；要更精準得把 spawn 完成事件拉到 panel 層，目前不值得。
   */
  const sendToSession = useCallback((sessionId: string, text: string): void => {
    const tryOnce = (attempt = 0): void => {
      const s = sessionsRef.current.find((x) => x.id === sessionId)
      if (s?.ptyId) {
        window.api.pty.write(s.ptyId, wrapPaste(text))
        return
      }
      if (attempt < 40) setTimeout(() => tryOnce(attempt + 1), 150)
    }
    tryOnce()
  }, [])

  const termTheme = useMemo(() => {
    return theme === 'dark'
      ? { background: '#1c1c1e', foreground: '#f5f5f7', cursor: '#f5f5f7' }
      : { background: '#ffffff', foreground: '#1d1d1f', cursor: '#1d1d1f' }
  }, [theme])

  useEffect(() => {
    sessions.forEach((s) => {
      s.term.options.theme = termTheme
    })
  }, [termTheme, sessions])

  useEffect(() => {
    window.api.pty.launchers().then((list) => {
      setLaunchers(list)
      setSelectedLauncher(list.length > 0 ? list[0].id : 'claude')
    })
  }, [])

  const handleNewTerminal = (launcherOverride?: string): string => {
    const key = launcherOverride || selectedLauncher
    const sessionId = crypto.randomUUID()
    const term = new Terminal({
      theme: termTheme,
      fontFamily: "'SF Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 12,
      cursorBlink: true
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    const title =
      launchers.find((l) => l.id === key)?.name ||
      BUILTIN_SHELLS.find((s) => s.id === key)?.label ||
      key

    setSessions((prev) => [
      ...prev,
      {
        id: sessionId,
        title,
        launcherKey: key,
        term,
        fitAddon,
        disposables: [],
        isExited: false,
        needsApproval: false
      }
    ])
    setActiveSessionId(sessionId)
    return sessionId
  }

  // 外部（如 Markdown code block）送指令進來：目標 shell 就找/開一個 shell 分頁
  useEffect(() => {
    if (!terminalDispatch || terminalDispatch.nonce === lastDispatch.current) return
    lastDispatch.current = terminalDispatch.nonce

    if (terminalDispatch.target === 'active' && activeSessionId) {
      sendToSession(activeSessionId, terminalDispatch.text)
      return
    }
    const shell = sessionsRef.current.find(
      (s) => !s.isExited && SHELL_IDS.includes(s.launcherKey)
    )
    const id = shell ? shell.id : handleNewTerminal(BUILTIN_SHELLS[0].id)
    setActiveSessionId(id)
    sendToSession(id, terminalDispatch.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalDispatch])

  /** 把「目前分頁的選取內容（或尾端數行）」送到另一個 session */
  const sendActiveTo = (targetId: string): void => {
    const src = sessionsRef.current.find((s) => s.id === activeSessionId)
    if (!src) return
    const text = readTerm(src.term)
    if (!text) return
    sendToSession(targetId, text)
    setActiveSessionId(targetId)
  }

  const closeTerminal = (id: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === id)
      if (idx === -1) return prev
      const session = prev[idx]

      if (session.ptyId) window.api.pty.kill(session.ptyId)
      session.disposables.forEach((d) => d())
      session.term.dispose()

      const next = [...prev]
      next.splice(idx, 1)

      if (activeSessionId === id) {
        setActiveSessionId(next.length > 0 ? next[Math.max(0, idx - 1)].id : null)
      }
      return next
    })
  }

  // 切到某分頁即視為使用者已看到，清掉紅點
  const selectSession = (id: string): void => {
    setActiveSessionId(id)
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, needsApproval: false } : s)))
  }

  const pendingCount = sessions.filter((s) => s.needsApproval).length

  return (
    <div className="term-root">
      <div className="term-toolbar">
        <select
          className="term-select"
          value={selectedLauncher}
          onChange={(e) => setSelectedLauncher(e.target.value)}
          title="Choose which CLI to launch"
        >
          <optgroup label="Agent CLI">
            {launchers.length > 0
              ? launchers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))
              : BUILTIN_CLIS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
          </optgroup>
          <optgroup label="Shell">
            {BUILTIN_SHELLS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </optgroup>
        </select>
        <button className="btn btn-primary" onClick={() => handleNewTerminal()}>
          ＋ New Terminal
        </button>
        {/* 把目前分頁的選取內容（或尾端輸出）送到另一個 session：
            agent→shell、shell→agent、agent→agent 都是同一個機制 */}
        {sessions.length > 1 && activeSessionId && (
          <select
            className="term-select term-sendto"
            value=""
            onChange={(e) => {
              if (e.target.value) sendActiveTo(e.target.value)
              e.target.value = ''
            }}
            title="Paste this terminal's selection (or its last output) into another terminal"
          >
            <option value="">Send to…</option>
            {sessions
              .filter((s) => s.id !== activeSessionId && !s.isExited)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
          </select>
        )}
        {pendingCount > 0 && (
          <span className="term-pending-summary" title="A terminal is waiting for your approval">
            ● {pendingCount} awaiting approval
          </span>
        )}
      </div>

      {sessions.length > 0 && (
        <div className="term-tabs">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`term-tab ${activeSessionId === s.id ? 'on' : ''} ${
                s.isExited ? 'exited' : ''
              }`}
              onClick={() => selectSession(s.id)}
              title={s.needsApproval ? 'This terminal is waiting for your approval' : s.title}
            >
              {s.needsApproval && <span className="term-dot" />}
              <span className="term-tab-title">{s.title}</span>
              <button className="term-tab-close" onClick={(e) => closeTerminal(s.id, e)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div ref={containerRef} className="term-stage">
        {sessions.length === 0 && (
          <div className="panel-stub">
            No terminals yet. Pick a CLI and press “＋ New Terminal” — it starts in the workspace directory.
          </div>
        )}
        {sessions.map((s) => (
          <TerminalInstance
            key={s.id}
            session={s}
            isActive={s.id === activeSessionId}
            launcherKey={s.launcherKey}
            setSessions={setSessions}
          />
        ))}
      </div>
    </div>
  )
}

function TerminalInstance({
  session,
  isActive,
  launcherKey,
  setSessions
}: {
  session: TerminalSession
  isActive: boolean
  launcherKey: string
  setSessions: React.Dispatch<React.SetStateAction<TerminalSession[]>>
}): JSX.Element {
  const elRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  // ptyId 存 ref：setSessions 會產生新物件，閉包裡的 session 永遠拿不到 ptyId，
  // 之前 resize 因此從未真正送出。
  const ptyIdRef = useRef<string | null>(null)
  const approvalRef = useRef(false)
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive

  useEffect(() => {
    if (!elRef.current || mounted.current) return
    mounted.current = true

    session.term.open(elRef.current)
    session.fitAddon.fit()

    const opts: Parameters<typeof window.api.pty.spawn>[0] = {
      cols: session.term.cols,
      rows: session.term.rows
    }
    if (DIRECT_IDS.includes(launcherKey)) {
      opts.command = launcherKey
    } else {
      opts.launcherId = launcherKey
    }

    window.api.pty
      .spawn(opts)
      .then((ptyId) => {
        ptyIdRef.current = ptyId
        setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, ptyId } : s)))

        const unsubData = window.api.pty.onData(ptyId, (data) => {
          session.term.write(data)

          // 待審批偵測：false→true 才提醒，避免同一個提示連發通知
          if (!approvalRef.current && looksLikeApprovalPrompt(data)) {
            approvalRef.current = true
            setSessions((prev) =>
              prev.map((s) => (s.id === session.id ? { ...s, needsApproval: true } : s))
            )
            if (!isActiveRef.current) {
              window.api.notify.show('Approval needed', `${session.title} is waiting for a response`)
            }
          }
        })

        const unsubExit = window.api.pty.onExit(ptyId, (code) => {
          approvalRef.current = false
          setSessions((prev) =>
            prev.map((s) =>
              s.id === session.id
                ? { ...s, isExited: true, needsApproval: false, title: `${s.title} (exited ${code})` }
                : s
            )
          )
          window.api.notify.show('Task finished', `${session.title} exited with code ${code}`)
        })

        // 使用者一輸入就代表他在回應，清掉待審批狀態
        const termDataDisp = session.term.onData((data) => {
          if (approvalRef.current) {
            approvalRef.current = false
            setSessions((prev) =>
              prev.map((s) => (s.id === session.id ? { ...s, needsApproval: false } : s))
            )
          }
          window.api.pty.write(ptyId, data)
        })

        session.disposables.push(unsubData, unsubExit, () => termDataDisp.dispose())
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        session.term.write(`\r\n\x1b[31mFailed to start: ${msg}\x1b[0m\r\n`)
      })

    const ro = new ResizeObserver(() => {
      try {
        session.fitAddon.fit()
        if (ptyIdRef.current) {
          window.api.pty.resize(ptyIdRef.current, session.term.cols, session.term.rows)
        }
      } catch {
        /* 尺寸為 0 時 fit 會丟例外，忽略 */
      }
    })
    ro.observe(elRef.current)
    session.disposables.push(() => ro.disconnect())
  }, [])

  useEffect(() => {
    if (!isActive || !mounted.current) return
    setTimeout(() => {
      try {
        session.fitAddon.fit()
        if (ptyIdRef.current) {
          window.api.pty.resize(ptyIdRef.current, session.term.cols, session.term.rows)
        }
        session.term.focus()
      } catch {
        /* 忽略 */
      }
    }, 0)
  }, [isActive])

  return <div ref={elRef} className={`term-surface ${isActive ? 'on' : ''}`} />
}
