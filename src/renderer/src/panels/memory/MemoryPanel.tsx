import { useState, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openFile, useWorkbench } from '@/store'
import './memory.css'

interface MemoryDoc {
  key: string
  label: string
  relPath: string
  content: string
}

/** 從 markdown 抓出「看起來像檔案路徑」的候選：行內程式碼與連結目標 */
function extractPathCandidates(md: string): string[] {
  const out = new Set<string>()
  const push = (raw: string): void => {
    const s = raw.trim().replace(/^\.\//, '')
    // 不含空白、有副檔名或帶目錄分隔，且不是網址
    if (!s || /\s/.test(s) || /^[a-z]+:\/\//i.test(s)) return
    if (!/\.[A-Za-z0-9]{1,8}$/.test(s) && !s.includes('/')) return
    out.add(s)
  }
  for (const m of md.matchAll(/`([^`\n]+)`/g)) push(m[1])
  for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) push(m[1])
  return [...out]
}

const MEMORY_FILES = [
  { key: 'handoff', label: 'handoff.md', relPath: '.project-memory/handoff.md' },
  { key: 'state', label: 'STATE.md', relPath: '.project-memory/STATE.md' },
  { key: 'decisions', label: 'DECISIONS.md', relPath: '.project-memory/DECISIONS.md' }
]

export default function MemoryPanel(): JSX.Element {
  const { gitTick } = useWorkbench()
  const [docs, setDocs] = useState<MemoryDoc[]>([])
  const [activeKey, setActiveKey] = useState<string>('handoff')
  const [loading, setLoading] = useState<boolean>(true)
  const [manualTick, setManualTick] = useState<number>(0)
  const [root, setRoot] = useState<string>('')
  // handoff 內確實存在於工作區的檔案路徑 → 可點擊跳到編輯器
  const [linkablePaths, setLinkablePaths] = useState<Set<string>>(new Set())

  const loadMemoryDocs = useCallback(async () => {
    setLoading(true)
    try {
      let workspaceRoot = ''
      try {
        workspaceRoot = await window.api.files.workspaceRoot()
      } catch (e) {
        console.warn('files.workspaceRoot failed:', e)
      }

      const normalizedRoot = workspaceRoot
        ? workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
        : ''
      setRoot(normalizedRoot)

      const loaded: MemoryDoc[] = []
      for (const item of MEMORY_FILES) {
        const targetPath = normalizedRoot ? `${normalizedRoot}/${item.relPath}` : item.relPath
        // 先問存在再讀：不用例外當流程控制，也不會在 main 端刷 ENOENT
        if (!(await window.api.files.exists(targetPath))) continue
        try {
          const content = await window.api.files.read(targetPath)
          loaded.push({ key: item.key, label: item.label, relPath: item.relPath, content })
        } catch (e) {
          console.warn(`read ${item.relPath} failed:`, e)
        }
      }

      setDocs(loaded)
      if (loaded.length > 0 && !loaded.some((d) => d.key === activeKey)) {
        setActiveKey(loaded[0].key)
      }

      // 驗證候選路徑是否真的存在，只有存在的才做成連結
      if (normalizedRoot && loaded.length > 0) {
        const candidates = extractPathCandidates(loaded.map((d) => d.content).join('\n'))
        const valid = new Set<string>()
        await Promise.all(
          candidates.map(async (rel) => {
            try {
              if (await window.api.files.exists(`${normalizedRoot}/${rel}`)) valid.add(rel)
            } catch {
              /* 逸出工作區的路徑會被 main 擋下，忽略 */
            }
          })
        )
        setLinkablePaths(valid)
      } else {
        setLinkablePaths(new Set())
      }
    } catch (err) {
      console.warn('Failed to load memory docs:', err)
      setDocs([])
    } finally {
      setLoading(false)
    }
  }, [activeKey])

  const jumpTo = useCallback(
    (rel: string): void => {
      if (root) openFile(`${root}/${rel.replace(/^\.\//, '')}`)
    },
    [root]
  )

  useEffect(() => {
    loadMemoryDocs()
  }, [loadMemoryDocs, gitTick, manualTick])

  const handleRefresh = (): void => {
    setManualTick((t) => t + 1)
  }

  // 三份都讀不到時顯示專屬提示卡片
  if (!loading && docs.length === 0) {
    return (
      <div className="memory-panel-container">
        <div className="memory-empty-container">
          <div className="memory-empty-card">
            <div className="memory-empty-icon">
              <svg viewBox="0 0 24 24" strokeWidth="1.5">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M7 15h0" />
                <path d="M2 9.5h20" />
              </svg>
            </div>
            <div className="memory-empty-title">
              尚未安裝 ShareProjectMem（.project-memory/handoff.md 不存在）
            </div>
            <p className="memory-empty-desc">
              ShareProjectMem 是跨官方 CLI（Claude Code / Codex / Antigravity）與跨機協作的共享大腦與交棒核心。
              請確認工作區根目錄已建立 <code>.project-memory/handoff.md</code>。
            </p>
            <button className="memory-btn" onClick={handleRefresh}>
              <svg viewBox="0 0 24 24">
                <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
              </svg>
              <span>重新整理</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  const currentDoc = docs.find((d) => d.key === activeKey) || docs[0]

  return (
    <div className="memory-panel-container">
      {/* 頂部工具列與分頁切換 */}
      <div className="memory-toolbar">
        <div className="memory-tabs">
          {docs.map((doc) => (
            <button
              key={doc.key}
              className={`memory-tab-btn ${currentDoc?.key === doc.key ? 'active' : ''}`}
              onClick={() => setActiveKey(doc.key)}
            >
              {doc.label}
            </button>
          ))}
        </div>

        <div className="memory-actions">
          <span className="memory-badge">ShareProjectMem</span>
          <button
            className="memory-btn"
            onClick={handleRefresh}
            title="重新載入記憶文件"
            disabled={loading}
          >
            <svg viewBox="0 0 24 24">
              <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
            </svg>
            <span>重新整理</span>
          </button>
        </div>
      </div>

      {/* 內容渲染區 */}
      <div className="memory-content">
        {currentDoc ? (
          <div className="memory-markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // 行內程式碼若是工作區內真實存在的檔案 → 做成可點擊，跳到編輯器
                code({ className, children, ...props }) {
                  const text = String(children)
                  if (!className && linkablePaths.has(text.trim().replace(/^\.\//, ''))) {
                    return (
                      <code
                        className="memory-filelink"
                        title={`在編輯器開啟 ${text}`}
                        onClick={() => jumpTo(text)}
                      >
                        {children}
                      </code>
                    )
                  }
                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  )
                },
                a({ href, children, ...props }) {
                  const rel = (href || '').replace(/^\.\//, '')
                  // 指向工作區內檔案的相對連結 → 開編輯器，而不是丟給瀏覽器
                  if (href && !/^[a-z]+:\/\//i.test(href) && linkablePaths.has(rel)) {
                    return (
                      <a
                        className="memory-filelink"
                        title={`在編輯器開啟 ${rel}`}
                        onClick={(e) => {
                          e.preventDefault()
                          jumpTo(rel)
                        }}
                      >
                        {children}
                      </a>
                    )
                  }
                  return (
                    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                      {children}
                    </a>
                  )
                }
              }}
            >
              {currentDoc.content}
            </ReactMarkdown>
          </div>
        ) : null}
      </div>
    </div>
  )
}
