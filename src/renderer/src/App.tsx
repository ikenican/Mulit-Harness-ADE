import { useState } from 'react'
import FileTreePanel from '@panels/filetree/FileTreePanel'
import GitPanel from '@panels/git/GitPanel'
import EditorPanel from '@panels/editor/EditorPanel'
import PreviewPanel from '@panels/preview/PreviewPanel'
import MemoryPanel from '@panels/memory/MemoryPanel'
import TerminalPanel from '@panels/terminal/TerminalPanel'
import CustomizedPanel from '@panels/customized/CustomizedPanel'
import { toggleTheme, useWorkbench } from '@/store'

type LeftTab = 'files' | 'git'
type CenterTab = 'editor' | 'preview' | 'memory' | 'customized'

// 三欄殼：頂 titlebar｜左（Files/Git）｜中（Editor/Preview/Memory）｜右（CLI 終端殼）
// 這個檔由 Master 擁有，worker 只實作各自 panel，不動這裡。
export default function App(): JSX.Element {
  const [left, setLeft] = useState<LeftTab>('files')
  const [center, setCenter] = useState<CenterTab>('editor')
  const { theme } = useWorkbench()

  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">
          Agent Workbench<span className="dot"> ●</span>
        </span>
        <span className="spacer" />
        <button
          className="btn-icon"
          title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? '☀︎' : '☾'}
        </button>
      </header>

      <div className="workarea">
        <aside className="col col-left">
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

        <main className="col col-center">
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

        <section className="col col-right">
          <div className="tabbar static">Agent Terminals</div>
          <div className="panel-body">
            <TerminalPanel />
          </div>
        </section>
      </div>
    </div>
  )
}
