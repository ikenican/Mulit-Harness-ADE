import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useWorkbench, openDiff, openInBrowser, clearAllAgentModified, openSettings } from '@/store'
import { useTranslation } from '@/i18n'
import { IconZap, IconHandoff, IconFolder, IconGitClone, IconTerminalBox, IconSettings } from '@/components/Icons'
import DashboardPanel from '@panels/dashboard/DashboardPanel'
import FileTreePanel from '@panels/filetree/FileTreePanel'
import GitPanel from '@panels/git/GitPanel'
import './vibeRail.css'

interface Props {
  /** 點變更檔／檔案後切到中央 Code 分頁 */
  onOpenCode: () => void
}

const HANDOFF_SECTIONS: Record<string, string> = {
  Done: 'vibe.handoffDone',
  'Not done': 'vibe.handoffNotDone',
  'Next agent should': 'vibe.handoffNext'
}

/** 取 handoff.md 開頭的 `- Key: value` 與指定 `## 小節` */
function parseHandoff(md: string): { meta: Record<string, string>; sections: [string, string][] } {
  const meta: Record<string, string> = {}
  for (const m of md.matchAll(/^- (Updated|Agent|Task): (.+)$/gm)) meta[m[1]] = m[2].trim()
  const sections: [string, string][] = []
  for (const block of md.split(/^## /m).slice(1)) {
    const nl = block.indexOf('\n')
    const title = (nl < 0 ? block : block.slice(0, nl)).trim()
    const body = nl < 0 ? '' : block.slice(nl + 1).trim()
    if (title in HANDOFF_SECTIONS && body) sections.push([title, body])
  }
  return { meta, sections }
}

type PaneId = 'sessions' | 'status' | 'handoff' | 'files' | 'git'
const PANE_ORDER: PaneId[] = ['sessions', 'status', 'handoff', 'files', 'git']
const PANE_ICONS: Record<PaneId, (p: { size?: number }) => JSX.Element> = {
  sessions: IconTerminalBox,
  status: IconZap,
  handoff: IconHandoff,
  files: IconFolder,
  git: IconGitClone
}

/**
 * Vibe 模式最左側直列圖示列：Status／Handoff／Files／Git。
 * 點圖示在旁邊懸浮彈出面板（可拖右下角調整大小）；再點一次、點外面或按 Esc 收起。
 */
export default function VibeRail({ onOpenCode }: Props): JSX.Element {
  const {
    agentBusy,
    liveAgentSessionIds,
    agentModifiedFiles,
    detectedDevUrl,
    workspaceRoot,
    fileTreeTick,
    activeFilePath
  } = useWorkbench()
  const { t } = useTranslation()
  const [openPane, setOpenPane] = useState<PaneId | null>(null)
  // pinned＝點擊固定；未固定＝游標懸停預覽（移開就淡出）
  const [pinned, setPinned] = useState(false)
  const [fading, setFading] = useState(false)
  const [handoff, setHandoff] = useState<string | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  const show = (id: PaneId, pin: boolean): void => {
    clearTimeout(timer.current)
    setFading(false)
    setOpenPane(id)
    setPinned(pin)
  }
  // 淡出動畫（150ms）跑完才卸載
  const close = (): void => {
    clearTimeout(timer.current)
    setFading(true)
    setPinned(false)
    timer.current = setTimeout(() => {
      setOpenPane(null)
      setFading(false)
    }, 150)
  }
  // 懸停：稍等一下才開，游標只是劃過圖示列時不會閃出一堆面板
  const hoverOpen = (id: PaneId): void => {
    if (pinned) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => show(id, false), openPane ? 0 : 120)
  }
  const hoverLeave = (): void => {
    if (pinned) return
    clearTimeout(timer.current)
    timer.current = setTimeout(close, 200)
  }
  const cancelLeave = (): void => {
    if (!pinned && openPane && !fading) clearTimeout(timer.current)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  // 固定後：點面板外或按 Esc 收起
  useEffect(() => {
    if (!openPane) return
    const onDown = (e: PointerEvent): void => {
      if (!railRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [openPane])

  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')

  // Agent 寫 handoff.md 時會觸發 external change → agentModifiedFiles 變動 → 重讀
  useEffect(() => {
    if (!root) return setHandoff(null)
    const path = `${root}/.project-memory/handoff.md`
    let alive = true
    window.api.files
      .exists(path)
      .then((ok) => (ok ? window.api.files.read(path) : null))
      .then((text) => alive && setHandoff(text))
      .catch(() => alive && setHandoff(null))
    return () => {
      alive = false
    }
  }, [root, fileTreeTick, agentModifiedFiles])

  // 使用者在 Files / Git 窗格點了檔案才切到 Code 分頁；Agent 自動開檔（也會改 activeFilePath）不跳走
  const filesClickAt = useRef(0)
  useEffect(() => {
    if (activeFilePath && Date.now() - filesClickAt.current < 1500) onOpenCode()
  }, [activeFilePath])

  // 點擊：固定；已固定的同一個再點一次＝關閉
  const clickPane = (id: PaneId): void => (pinned && openPane === id ? close() : show(id, true))

  const changed = [...agentModifiedFiles]
  const rel = (p: string): string => {
    const n = p.replace(/\\/g, '/')
    return root && n.toLowerCase().startsWith(root.toLowerCase() + '/') ? n.slice(root.length + 1) : p
  }
  const status = agentBusy
    ? t('vibe.agentWorking')
    : liveAgentSessionIds.length > 0
      ? t('vibe.agentIdle', { n: liveAgentSessionIds.length })
      : t('vibe.noAgent')
  const parsed = handoff ? parseHandoff(handoff) : null

  const titles: Record<PaneId, string> = {
    sessions: t('vibe.sessionsTitle'),
    status: t('vibe.statusTitle'),
    handoff: t('vibe.handoffTitle'),
    files: t('vibe.filesTitle'),
    git: t('vibe.gitTitle')
  }
  const extras: Partial<Record<PaneId, JSX.Element | null>> = {
    status: (
      <span className={`vibe-agent ${agentBusy ? 'busy' : ''}`}>
        <span className="vibe-dot" />
        {status}
      </span>
    ),
    handoff: parsed?.meta.Updated ? (
      <span className="vibe-meta">
        {parsed.meta.Agent} · {parsed.meta.Updated}
      </span>
    ) : null
  }

  const body = (id: PaneId): JSX.Element => {
    switch (id) {
      case 'status':
        return (
          <div className="vibe-card-body">
            {detectedDevUrl && (
              <div className="vibe-row">
                <span className="vibe-label">{t('vibe.devServer')}</span>
                <button className="vibe-pill vibe-url" onClick={() => openInBrowser(detectedDevUrl.url)}>
                  ▶ {detectedDevUrl.url.replace(/^http:\/\//, '')}
                </button>
              </div>
            )}
            <div className="vibe-row">
              <span className="vibe-label">{t('vibe.changedFiles', { n: changed.length })}</span>
              {changed.length > 0 && (
                <button className="vibe-link" onClick={clearAllAgentModified}>
                  {t('vibe.clear')}
                </button>
              )}
            </div>
            {changed.map((p) => (
              <button
                key={p}
                className="vibe-file"
                title={p}
                onClick={() => {
                  openDiff(p)
                  onOpenCode()
                }}
              >
                {rel(p)}
              </button>
            ))}
          </div>
        )
      case 'handoff':
        return (
          <div className="vibe-card-body vibe-md">
            {!parsed ? (
              <span className="vibe-label">{t('vibe.noHandoff')}</span>
            ) : (
              <>
                {parsed.meta.Task && <p className="vibe-task">{parsed.meta.Task}</p>}
                {parsed.sections.map(([title, text]) => (
                  <div key={title}>
                    <h4>{t(HANDOFF_SECTIONS[title])}</h4>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                  </div>
                ))}
              </>
            )}
          </div>
        )
      case 'sessions':
        return (
          <div className="vibe-embed">
            <div className="fill">
              <DashboardPanel sessionsOnly />
            </div>
          </div>
        )
      case 'files':
        return (
          <div className="vibe-embed" onPointerDownCapture={() => (filesClickAt.current = Date.now())}>
            <div className="fill">
              <FileTreePanel />
            </div>
          </div>
        )
      case 'git':
        return (
          <div className="vibe-embed" onPointerDownCapture={() => (filesClickAt.current = Date.now())}>
            <div className="fill">
              <GitPanel />
            </div>
          </div>
        )
    }
  }

  return (
    <div
      className="vibe-rail"
      ref={railRef}
      style={{ gridArea: 'rail' }}
      onMouseLeave={hoverLeave}
      onMouseEnter={cancelLeave}
    >
      {PANE_ORDER.map((id) => {
        const Icon = PANE_ICONS[id]
        const badge =
          id === 'status' ? (agentBusy ? 'busy' : changed.length > 0 ? String(changed.length) : null) : null
        return (
          <button
            key={id}
            className={`vibe-rail-btn ${openPane === id ? (pinned ? 'on' : 'peek') : ''}`}
            title={titles[id]}
            onMouseEnter={() => hoverOpen(id)}
            onClick={() => clickPane(id)}
          >
            <Icon size={18} />
            <span className="vibe-rail-label">{titles[id]}</span>
            {badge === 'busy' && <span className="vibe-rail-badge busy" />}
            {badge && badge !== 'busy' && <span className="vibe-rail-badge">{badge}</span>}
          </button>
        )
      })}

      {/* 設定鈕固定在圖示列最下方（左下角） */}
      <button
        className="vibe-rail-btn vibe-rail-settings"
        title={t('header.settingsTooltip')}
        onMouseEnter={() => !pinned && openPane && close()}
        onClick={() => {
          close()
          openSettings()
        }}
      >
        <IconSettings size={18} />
        <span className="vibe-rail-label">{t('vibe.settingsTitle')}</span>
      </button>

      {openPane && (
        <section
          className={`vibe-flyout flyout-${openPane} ${fading ? 'fading' : ''} ${pinned ? 'pinned' : ''}`}
          // 懸停預覽時，在面板裡點一下就等同固定
          onPointerDown={() => !pinned && setPinned(true)}
        >
          <header className="vibe-card-head">
            <span>{titles[openPane]}</span>
            <span className="vibe-head-spacer" />
            {extras[openPane]}
            <button className="vibe-flyout-close" onClick={close} aria-label="Close">
              ✕
            </button>
          </header>
          {body(openPane)}
        </section>
      )}
    </div>
  )
}
