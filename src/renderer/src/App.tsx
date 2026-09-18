import { useEffect, useState } from 'react'
import FileTreePanel from '@panels/filetree/FileTreePanel'
import GitPanel from '@panels/git/GitPanel'
import EditorPanel from '@panels/editor/EditorPanel'
import PreviewPanel from '@panels/preview/PreviewPanel'
import MemoryPanel from '@panels/memory/MemoryPanel'
import TerminalPanel from '@panels/terminal/TerminalPanel'
import DashboardPanel from '@panels/dashboard/DashboardPanel'
import TestBrowserPanel from '@panels/browser/TestBrowserPanel'
import SettingsModal from '@/components/SettingsModal'
import Splitter from '@/components/Splitter'
import {
  IconSidebarCollapse,
  IconSidebarExpand,
  IconDockRight,
  IconDockBottom,
  IconSettings,
  IconMaximize,
  IconMinimize,
  IconClose
} from '@/components/Icons'
import { toggleCenterMaximized, useWorkbench, openSettings, closeSettings, setSidebarTab, setWorkspaceRoot } from '@/store'
import { useTranslation } from '@/i18n'
import {
  clamp,
  DEFAULT_LAYOUT,
  LIMITS,
  loadLayout,
  saveLayout,
  type Dock,
  type LayoutState
} from '@/layout'

type CenterTab = 'editor' | 'preview' | 'browser' | 'memory'

export default function App(): JSX.Element {
  const isDetachedWindow =
    typeof window !== 'undefined' && window.location.search.includes('mode=terminal-detached')

  // 若是以獨立視窗啟動的終端模式，整面直接呈現全螢幕 TerminalPanel
  if (isDetachedWindow) {
    return (
      <div
        className="app detached-term-app"
        style={{ height: '100vh', width: '100vw', overflow: 'hidden' }}
      >
        <TerminalPanel />
      </div>
    )
  }

  const [center, setCenter] = useState<CenterTab>('editor')
  const [browserOpened, setBrowserOpened] = useState(false)
  const { centerMaximized, terminalOpenSession, settingsModal, sidebarTab } = useWorkbench()
  const { t } = useTranslation()

  // 若以 ?workspace= 參數開啟獨立專案視窗，初始化工作區與側邊欄；若未指定工作區，預設停留在 Dashboard
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const wsParam = urlParams.get('workspace')
    if (wsParam) {
      setWorkspaceRoot(wsParam)
      setSidebarTab('files')
    } else {
      setSidebarTab('dashboard')
    }
  }, [])

  // 全域快捷鍵：Ctrl+Shift+N (Cmd+Shift+N) 開啟新專案視窗（如同 VS Code）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        e.preventDefault()
        if (window.api?.window?.openProjectWindow) {
          window.api.window.openProjectWindow()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // 記錄已造訪過的面板，實現「按需掛載（Mount-On-Demand）+ 狀態保留（Keep-Alive）」
  // 啟動時不掛載未造訪的次要面板（如 Git、Preview、Memory），大幅縮短首屏載入時間與消除開機子行程搶佔
  const [visitedSidebarTabs, setVisitedSidebarTabs] = useState<Set<string>>(
    () => new Set([sidebarTab || 'dashboard'])
  )
  const [visitedCenterTabs, setVisitedCenterTabs] = useState<Set<string>>(
    () => new Set([center || 'editor'])
  )

  useEffect(() => {
    if (sidebarTab) {
      setVisitedSidebarTabs((prev) => (prev.has(sidebarTab) ? prev : new Set(prev).add(sidebarTab)))
    }
  }, [sidebarTab])

  useEffect(() => {
    if (center) {
      setVisitedCenterTabs((prev) => (prev.has(center) ? prev : new Set(prev).add(center)))
    }
  }, [center])

  useEffect(() => {
    if (center === 'browser') {
      setBrowserOpened(true)
    }
  }, [center])

  const [layout, setLayout] = useState<LayoutState>(loadLayout)
  useEffect(() => saveLayout(layout), [layout])

  // 監聽跨面板請求開啟/聚焦終端：若指定 ensureRightDock 且目前非右側停靠，自動切換至右側停靠
  useEffect(() => {
    if (!terminalOpenSession) return
    if (terminalOpenSession.ensureRightDock && layout.dock !== 'right') {
      setLayout((l) => ({
        ...l,
        dock: 'right',
        rightW: Math.max(l.rightW, LIMITS.rightMin)
      }))
    }
  }, [terminalOpenSession, layout.dock])

  // 切換側邊欄標籤時，若側邊欄原本為摺疊狀態，自動展開以利立即檢視內容
  useEffect(() => {
    if (layout.leftCollapsed && sidebarTab) {
      setLayout((l) => ({
        ...l,
        leftCollapsed: false,
        leftW: Math.max(l.leftW, LIMITS.leftMin)
      }))
    }
  }, [sidebarTab])

  const isBottom = layout.dock === 'bottom'
  const isCenterMaximized = Boolean(centerMaximized)
  const isLeftCollapsed = isCenterMaximized || Boolean(layout.leftCollapsed || layout.leftW === 0)

  // 上限依目前視窗算，避免把中央區擠沒了
  const maxLeft = (): number =>
    Math.min(LIMITS.leftMax, window.innerWidth - LIMITS.centerMin - (isBottom ? 0 : layout.rightW))
  const maxRight = (): number =>
    Math.min(LIMITS.rightMax, window.innerWidth - LIMITS.centerMin - (isLeftCollapsed ? 0 : layout.leftW))
  const maxTerm = (): number => Math.max(LIMITS.termMin, window.innerHeight - 200)

  const nudgeLeft = (dx: number): void =>
    setLayout((l) => {
      const target = (l.leftCollapsed ? 0 : l.leftW) + dx
      if (target < 90) {
        return { ...l, leftCollapsed: true, leftW: 0 }
      }
      return {
        ...l,
        leftCollapsed: false,
        leftW: clamp(target, LIMITS.leftMin, maxLeft())
      }
    })

  // 右欄在右側，往右拖代表把它縮小
  const nudgeRight = (dx: number): void =>
    setLayout((l) => ({ ...l, rightW: clamp(l.rightW - dx, LIMITS.rightMin, maxRight()) }))
  // 終端在底部，往下拖代表把它縮小
  const nudgeTerm = (dy: number): void =>
    setLayout((l) => ({ ...l, termH: clamp(l.termH - dy, LIMITS.termMin, maxTerm()) }))

  const setDock = (dock: Dock): void => setLayout((l) => ({ ...l, dock }))

  const effectiveLeftW = isLeftCollapsed ? 0 : layout.leftW
  const sp1W = isLeftCollapsed ? '0px' : '1px'

  const gridStyle: React.CSSProperties = isCenterMaximized
    ? {
        gridTemplateColumns: '1fr',
        gridTemplateRows: '1fr',
        gridTemplateAreas: `"center"`
      }
    : isBottom
    ? {
        gridTemplateColumns: `${effectiveLeftW}px ${sp1W} 1fr`,
        gridTemplateRows: `1fr 1px ${layout.termH}px`,
        gridTemplateAreas: `"left sp1 center" "left sp1 sp2" "left sp1 term"`
      }
    : {
        gridTemplateColumns: `${effectiveLeftW}px ${sp1W} 1fr 1px ${layout.rightW}px`,
        gridTemplateRows: '1fr',
        gridTemplateAreas: `"left sp1 center sp2 term"`
      }

  return (
    <div className="app">
      {/* 頂層統整式無縫視窗 Header（整合 Windows/macOS 標題列與全域控制項） */}
      <header className="app-unified-header">
        <div className="app-header-left">
          <span className="app-brand">
            Agent Workbench<span className="dot">●</span>
          </span>
          {!isLeftCollapsed && (
            <button
              className="btn-collapse-left"
              onClick={() => setLayout((l) => ({ ...l, leftCollapsed: true }))}
              title={t('header.collapseSidebar')}
            >
              <IconSidebarCollapse size={13} />
            </button>
          )}
          {isLeftCollapsed && !isCenterMaximized && (
            <button
              className="btn-expand-left"
              onClick={() =>
                setLayout((l) => ({
                  ...l,
                  leftCollapsed: false,
                  leftW: l.leftW >= LIMITS.leftMin ? l.leftW : DEFAULT_LAYOUT.leftW
                }))
              }
              title={t('header.expandSidebar')}
            >
              <IconSidebarExpand size={13} />
              <span>{t('header.sidebar')}</span>
            </button>
          )}
        </div>

        <div className="app-header-center">
          <div className="segmented">
            <button className={center === 'editor' ? 'on' : ''} onClick={() => setCenter('editor')}>
              {t('header.editor')}
            </button>
            <button
              className={center === 'preview' ? 'on' : ''}
              onClick={() => setCenter('preview')}
            >
              {t('header.preview')}
            </button>
            <button className={center === 'memory' ? 'on' : ''} onClick={() => setCenter('memory')}>
              {t('header.memory')}
            </button>
            <button
              className={center === 'browser' ? 'on' : ''}
              onClick={() => setCenter('browser')}
            >
              {t('header.browser')}
            </button>
          </div>
        </div>

        <div className="app-header-right">
          {/* Focus / Maximize Center View */}
          <button
            className={`btn-icon ${isCenterMaximized ? 'active' : ''}`}
            title={isCenterMaximized ? t('header.exitFocus') : t('header.focusWorkspace')}
            onClick={toggleCenterMaximized}
          >
            {isCenterMaximized ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>

          <div className="segmented dock-switch">
            <button
              className={!isBottom ? 'on' : ''}
              onClick={() => setDock('right')}
              title={t('header.dockRight')}
            >
              <IconDockRight size={13} />
            </button>
            <button
              className={isBottom ? 'on' : ''}
              onClick={() => setDock('bottom')}
              title={t('header.dockBottom')}
            >
              <IconDockBottom size={13} />
            </button>
          </div>

          <button
            className="btn-icon"
            title={t('header.settingsTooltip')}
            onClick={() => openSettings()}
          >
            <IconSettings size={14} />
          </button>
        </div>
      </header>

      {/* 工作區（各欄起始 Y 座標完全齊平，底線絕對水平對齊） */}
      <div className={`workarea dock-${layout.dock}`} style={gridStyle}>
        <aside
          className="col col-left"
          style={{
            gridArea: 'left',
            display: isLeftCollapsed ? 'none' : 'flex',
            minWidth: isLeftCollapsed ? 0 : LIMITS.leftMin
          }}
        >
          <div className="tabbar">
            <div className="segmented left-segmented">
              <button className={sidebarTab === 'dashboard' ? 'on' : ''} onClick={() => setSidebarTab('dashboard')}>
                {t('sidebarTabs.dashboard')}
              </button>
              <button className={sidebarTab === 'files' ? 'on' : ''} onClick={() => setSidebarTab('files')}>
                {t('sidebarTabs.files')}
              </button>
              <button className={sidebarTab === 'git' ? 'on' : ''} onClick={() => setSidebarTab('git')}>
                {t('sidebarTabs.git')}
              </button>
            </div>
          </div>
          <div className="panel-body">
            {visitedSidebarTabs.has('dashboard') && (
              <div hidden={sidebarTab !== 'dashboard'} className="fill">
                <DashboardPanel />
              </div>
            )}
            {visitedSidebarTabs.has('files') && (
              <div hidden={sidebarTab !== 'files'} className="fill">
                <FileTreePanel />
              </div>
            )}
            {visitedSidebarTabs.has('git') && (
              <div hidden={sidebarTab !== 'git'} className="fill">
                <GitPanel />
              </div>
            )}
          </div>
        </aside>

        {!isLeftCollapsed && (
          <Splitter
            axis="vertical"
            label="Sidebar width"
            area="sp1"
            onDelta={nudgeLeft}
            onReset={() =>
              setLayout((l) => ({
                ...l,
                leftCollapsed: false,
                leftW: DEFAULT_LAYOUT.leftW
              }))
            }
          />
        )}

        <main className="col col-center" style={{ gridArea: 'center' }}>
          <div className="panel-body">
            {visitedCenterTabs.has('editor') && (
              <div hidden={center !== 'editor'} className="fill">
                <EditorPanel />
              </div>
            )}
            {visitedCenterTabs.has('preview') && (
              <div hidden={center !== 'preview'} className="fill">
                <PreviewPanel />
              </div>
            )}
            {visitedCenterTabs.has('memory') && (
              <div hidden={center !== 'memory'} className="fill">
                <MemoryPanel />
              </div>
            )}
            {browserOpened && (
              <div
                className="fill"
                style={{
                  display: center === 'browser' ? 'flex' : 'none',
                  height: '100%',
                  width: '100%'
                }}
              >
                <TestBrowserPanel onClose={() => setCenter('editor')} />
              </div>
            )}
          </div>
        </main>

        {!isCenterMaximized && (
          <Splitter
            axis={isBottom ? 'horizontal' : 'vertical'}
            label={isBottom ? 'Terminal height' : 'Terminal width'}
            area="sp2"
            onDelta={isBottom ? nudgeTerm : nudgeRight}
            onReset={() =>
              setLayout((l) =>
                isBottom
                  ? { ...l, termH: DEFAULT_LAYOUT.termH }
                  : { ...l, rightW: DEFAULT_LAYOUT.rightW }
              )
            }
          />
        )}

        <section
          className="col col-term"
          style={{
            gridArea: 'term',
            display: isCenterMaximized ? 'none' : 'flex',
            minWidth: !isBottom ? LIMITS.rightMin : 0
          }}
        >
          <div className="panel-body">
            <div className="fill">
              <TerminalPanel />
            </div>
          </div>
        </section>
      </div>

      <SettingsModal
        isOpen={settingsModal.isOpen}
        onClose={closeSettings}
        initialTab={settingsModal.tab}
      />
    </div>
  )
}
