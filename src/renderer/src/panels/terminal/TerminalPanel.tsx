import React, { useEffect, useState, useRef, useMemo } from 'react'
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
  term: Terminal
  fitAddon: FitAddon
  ptyId?: string
  disposables: (() => void)[]
  isExited: boolean
  needsApproval: boolean
}

const BUILTIN_CLIS = ['claude', 'codex', 'antigravity'] as const

export default function TerminalPanel(): JSX.Element {
  const { theme } = useWorkbench()
  const [launchers, setLaunchers] = useState<CliLauncher[]>([])
  const [selectedLauncher, setSelectedLauncher] = useState<string>('')
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)

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

  const handleNewTerminal = (): void => {
    const sessionId = crypto.randomUUID()
    const term = new Terminal({
      theme: termTheme,
      fontFamily: "'SF Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 12,
      cursorBlink: true
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    const title = launchers.find((l) => l.id === selectedLauncher)?.name || selectedLauncher

    setSessions((prev) => [
      ...prev,
      {
        id: sessionId,
        title,
        term,
        fitAddon,
        disposables: [],
        isExited: false,
        needsApproval: false
      }
    ])
    setActiveSessionId(sessionId)
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
          title="選擇要啟動的 CLI"
        >
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
        </select>
        <button className="btn btn-primary" onClick={handleNewTerminal}>
          ＋ 新終端
        </button>
        {pendingCount > 0 && (
          <span className="term-pending-summary" title="有終端在等你審批">
            ● {pendingCount} 待審批
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
              title={s.needsApproval ? '這個終端在等你審批' : s.title}
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
            尚無終端。選一個 CLI 後按「＋ 新終端」，它會在工作區目錄啟動。
          </div>
        )}
        {sessions.map((s) => (
          <TerminalInstance
            key={s.id}
            session={s}
            isActive={s.id === activeSessionId}
            launcherKey={launchers.find((l) => l.name === s.title)?.id || s.title}
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
    if ((BUILTIN_CLIS as readonly string[]).includes(launcherKey)) {
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
              window.api.notify.show('需要你的審批', `${session.title} 正在等待回應`)
            }
          }
        })

        const unsubExit = window.api.pty.onExit(ptyId, (code) => {
          approvalRef.current = false
          setSessions((prev) =>
            prev.map((s) =>
              s.id === session.id
                ? { ...s, isExited: true, needsApproval: false, title: `${s.title}（已結束 ${code}）` }
                : s
            )
          )
          window.api.notify.show('任務結束', `${session.title} 已結束（exit ${code}）`)
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
        session.term.write(`\r\n\x1b[31m啟動失敗：${msg}\x1b[0m\r\n`)
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
