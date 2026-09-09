import { useEffect, useState } from 'react'
import FileTreePanel from '@panels/filetree/FileTreePanel'
import GitPanel from '@panels/git/GitPanel'
import EditorPanel from '@panels/editor/EditorPanel'
import PreviewPanel from '@panels/preview/PreviewPanel'
import MemoryPanel from '@panels/memory/MemoryPanel'
import TerminalPanel from '@panels/terminal/TerminalPanel'
import CustomizedPanel from '@panels/customized/CustomizedPanel'
import Splitter from '@/components/Splitter'
import { toggleTheme, useWorkbench } from '@/store'
import {
  clamp,
  DEFAULT_LAYOUT,
  LIMITS,
  loadLayout,
  saveLayout,
  type Dock,
  type LayoutState
} from '@/layout'

type LeftTab = 'files' | 'git'
type CenterTab = 'editor' | 'preview' | 'memory' | 'customized'

// 三欄殼：頂 titlebar｜左（Files/Git）｜中（Editor/Preview/Memory/Customized）｜終端
// 終端可停靠右側或底部。切換停靠「只換 grid-template-areas」，JSX 結構不變 ——
// 若改成兩個分支各自渲染 TerminalPanel，React 會 unmount/remount，你的終端 session 會全被殺掉。
export default function App(): JSX.Element {
  const [left, setLeft] = useState<LeftTab>('files')
  const [center, setCenter] = useState<CenterTab>('editor')
  const { theme } = useWorkbench()

  const [layout, setLayout] = useState<LayoutState>(loadLayout)
  useEffect(() => saveLayout(layout), [layout])

  const isBottom = layout.dock === 'bottom'

  // 上限依目前視窗算，避免把中央區擠沒了
  const maxLeft = (): number =>
    Math.min(LIMITS.leftMax, window.innerWidth - LIMITS.centerMin - (isBottom ? 0 : layout.rightW))
  const maxRight = (): number =>
    Math.min(LIMITS.rightMax, window.innerWidth - LIMITS.centerMin - layout.leftW)
  const maxTerm = (): number => Math.max(LIMITS.termMin, window.innerHeight - 260)

  const nudgeLeft = (dx: number): void =>
    setLayout((l) => ({ ...l, leftW: clamp(l.leftW + dx, LIMITS.leftMin, maxLeft()) }))
  // 右欄在右側，往右拖代表把它縮小
  const nudgeRight = (dx: number): void =>
    setLayout((l) => ({ ...l, rightW: clamp(l.rightW - dx, LIMITS.rightMin, maxRight()) }))
  // 終端在底部，往下拖代表把它縮小
  const nudgeTerm = (dy: number): void =>
    setLayout((l) => ({ ...l, termH: clamp(l.termH - dy, LIMITS.termMin, maxTerm()) }))

  const setDock = (dock: Dock): void => setLayout((l) => ({ ...l, dock }))

  const gridStyle: React.CSSProperties = isBottom
    ? {
        gridTemplateColumns: `${layout.leftW}px 1px 1fr`,
        gridTemplateRows: `1fr 1px ${layout.termH}px`,
        gridTemplateAreas: `"left sp1 center" "left sp1 sp2" "left sp1 term"`
      }
    : {
        gridTemplateColumns: `${layout.leftW}px 1px 1fr 1px ${layout.rightW}px`,
        gridTemplateRows: '1fr',
        gridTemplateAreas: `"left sp1 center sp2 term"`
      }

  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">
          Agent Workbench<span className="dot"> ●</span>
        </span>
        <span className="spacer" />
        <div className="segmented dock-switch">
          <button
            className={!isBottom ? 'on' : ''}
            onClick={() => setDock('right')}
            title="Dock terminals to the right"
          >
            ▨ Right
          </button>
          <button
            className={isBottom ? 'on' : ''}
            onClick={() => setDock('bottom')}
            title="Dock terminals to the bottom"
          >
            ▤ Bottom
          </button>
        </div>
        <button
          className="btn-icon"
          title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? '☀︎' : '☾'}
        </button>
      </header>

      <div className={`workarea dock-${layout.dock}`} style={gridStyle}>
        <aside className="col col-left" style={{ gridArea: 'left' }}>
          <div className="tabbar">
            <div className="segmented">
              <button className={left === 'files' ? 'on' : ''} onClick={() => setLeft('files')}>
                Files
              </button>
              <button className={left === 'git' ? 'on' : ''} onClick={() => setLeft('git')}>
                Git
              </button>
            </div>
          </div>
          <div className="panel-body">
            <div hidden={left !== 'files'} className="fill">
              <FileTreePanel />
            </div>
            <div hidden={left !== 'git'} className="fill">
              <GitPanel />
            </div>
          </div>
        </aside>

        <Splitter
          axis="vertical"
          label="Sidebar width"
          area="sp1"
          onDelta={nudgeLeft}
          onReset={() => setLayout((l) => ({ ...l, leftW: DEFAULT_LAYOUT.leftW }))}
        />

        <main className="col col-center" style={{ gridArea: 'center' }}>
          <div className="tabbar">
            <div className="segmented">
              <button className={center === 'editor' ? 'on' : ''} onClick={() => setCenter('editor')}>
                Editor / Diff
              </button>
              <button
                className={center === 'preview' ? 'on' : ''}
                onClick={() => setCenter('preview')}
              >
                Preview
              </button>
              <button className={center === 'memory' ? 'on' : ''} onClick={() => setCenter('memory')}>
                Memory
              </button>
              <button
                className={center === 'customized' ? 'on' : ''}
                onClick={() => setCenter('customized')}
              >
                Customized
              </button>
            </div>
          </div>
          <div className="panel-body">
            <div hidden={center !== 'editor'} className="fill">
              <EditorPanel />
            </div>
            <div hidden={center !== 'preview'} className="fill">
              <PreviewPanel />
            </div>
            <div hidden={center !== 'memory'} className="fill">
              <MemoryPanel />
            </div>
            <div hidden={center !== 'customized'} className="fill">
              <CustomizedPanel />
            </div>
          </div>
        </main>

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

        <section className="col col-term" style={{ gridArea: 'term' }}>
          <div className="tabbar static">Agent Terminals</div>
          <div className="panel-body">
            <TerminalPanel />
          </div>
        </section>
      </div>
    </div>
  )
}
