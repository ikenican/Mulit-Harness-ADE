import { useState, useEffect, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useWorkbench, closeTab, selectTab } from '@/store'
import MermaidBlock from './MermaidBlock'
import RunnableCode, { isShellLang } from '@/components/RunnableCode'
import './preview.css'

export default function PreviewPanel(): JSX.Element {
  const { activeFilePath, openTabs, gitTick, fileReloadTick, editorDraft } = useWorkbench()
  const wbTheme = (useWorkbench() as { theme?: string }).theme
  const theme: 'light' | 'dark' =
    wbTheme === 'dark' || wbTheme === 'dark-morandi' ? 'dark' : 'light'

  // 記憶體內容快取（避免切換分頁重複讀盤）
  const [cache, setCache] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [manualTick, setManualTick] = useState<number>(0)

  // 檢查路徑是否為支援的預覽格式（支援硬碟檔案與 commit: 虛擬路徑）
  const checkSupported = useCallback((p: string | null): boolean => {
    if (!p) return false
    const cleanPath = p.startsWith('commit:') ? p.split(':').slice(2).join(':') : p
    const ext = cleanPath.split('.').pop()?.toLowerCase() || ''
    return ext === 'md' || ext === 'markdown' || ext === 'html' || ext === 'htm'
  }, [])

  // 預覽分頁直接以全域 openTabs 中所有支援預覽的檔案為單一真相來源，關閉檔案時完全同步
  const previewTabs = useMemo(() => {
    return openTabs.filter((p) => checkSupported(p))
  }, [openTabs, checkSupported])

  // 目標路徑：若當前作用檔為預覽格式則優先選用；若作用檔不支援但有其他已開啟的預覽分頁，則維持選中
  const isCurrentActiveSupported = Boolean(activeFilePath && checkSupported(activeFilePath))
  const targetPath = isCurrentActiveSupported
    ? activeFilePath
    : previewTabs.includes(activeFilePath || '')
    ? activeFilePath
    : previewTabs.length > 0 && (!activeFilePath || !openTabs.includes(activeFilePath))
    ? previewTabs[0]
    : isCurrentActiveSupported
    ? activeFilePath
    : null

  // 判斷當前預覽副檔名與標題（支援 commit: 虛擬標籤解析）
  const isCommit = Boolean(targetPath?.startsWith('commit:'))
  let cleanFilePath = targetPath || ''
  let commitHashTag = ''
  if (isCommit && targetPath) {
    const parts = targetPath.split(':')
    commitHashTag = parts[1] ? `(${parts[1].slice(0, 7)})` : ''
    cleanFilePath = parts.slice(2).join(':')
  }

  const ext = cleanFilePath ? cleanFilePath.split('.').pop()?.toLowerCase() || '' : ''
  const isMd = ext === 'md' || ext === 'markdown'
  const isHtml = ext === 'html' || ext === 'htm'
  const isSupported = isMd || isHtml
  const rawFileName = cleanFilePath ? cleanFilePath.replace(/\\/g, '/').split('/').pop() || cleanFilePath : ''
  const displayFileName = commitHashTag ? `${rawFileName} ${commitHashTag}` : rawFileName

  // 即時編輯器草稿聯動：若當前預覽檔案正在 Editor 中編輯，直接使用最新 draft，打字即時自動預覽！
  const liveEditorText =
    editorDraft &&
    targetPath &&
    (editorDraft.path === targetPath ||
      editorDraft.path.replace(/\\/g, '/').toLowerCase() ===
        targetPath.replace(/\\/g, '/').toLowerCase())
      ? editorDraft.text
      : null

  const content =
    liveEditorText !== null ? liveEditorText : targetPath ? cache[targetPath] || '' : ''

  // 讀取檔案內容（支援一般檔案系統與 Git Commit 歷史節點）
  const loadFile = useCallback(
    async (p: string, force = false) => {
      if (!checkSupported(p)) return
      // 若非強制且快取中已有，才跳過初次讀取
      if (!force && cache[p] !== undefined) return

      setLoading(true)
      setError(null)
      try {
        if (p.startsWith('commit:')) {
          const parts = p.split(':')
          const hash = parts[1]
          const relPath = parts.slice(2).join(':')
          const diff = await window.api.git.commitFileDiff(hash, relPath)
          const text = diff.modified || diff.original || ''
          setCache((prev) => ({ ...prev, [p]: text }))
        } else {
          const text = await window.api.files.read(p)
          setCache((prev) => ({ ...prev, [p]: text }))
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn('Failed to read preview file:', err)
        setError(msg || 'Failed to read file')
      } finally {
        setLoading(false)
      }
    },
    [cache, checkSupported]
  )

  // 1. 初次載入或目標切換時讀取
  useEffect(() => {
    setError(null)
    if (targetPath && isSupported) {
      loadFile(targetPath, false)
    }
  }, [targetPath, isSupported, loadFile])

  // 2. 當存檔（gitTick 變化）、或該檔案外部變更計數遞增時，自動強制從磁碟重載！
  const targetReloadTick = targetPath ? fileReloadTick?.[targetPath] : undefined
  useEffect(() => {
    if (targetPath && isSupported && !targetPath.startsWith('commit:')) {
      loadFile(targetPath, true)
    }
  }, [gitTick, targetReloadTick, targetPath, isSupported, loadFile])

  // 3. 監聽後端工作區檔案熱變更事件（Agent 背景修改檔案時即刻自動重新載入）
  useEffect(() => {
    if (!window.api?.files?.onExternalChange) return
    const unbind = window.api.files.onExternalChange(({ path: changedPath }) => {
      if (!targetPath || targetPath.startsWith('commit:')) return
      const p1 = changedPath.replace(/\\/g, '/').toLowerCase()
      const p2 = targetPath.replace(/\\/g, '/').toLowerCase()
      if (p1 === p2 || p1.endsWith(p2) || p2.endsWith(p1)) {
        loadFile(targetPath, true)
      }
    })
    return unbind
  }, [targetPath, loadFile])

  const handleRefresh = (): void => {
    if (targetPath) {
      loadFile(targetPath, true)
      setManualTick((t) => t + 1)
    }
  }

  const handleCloseTab = (p: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    closeTab(p)
  }

  const handleSelectTab = (p: string): void => {
    selectTab(p)
  }

  // 使用 useMemo 快取 Markdown 渲染結果，避免無關 state 變化造成卡頓
  const renderedMarkdown = useMemo(() => {
    if (!content || isHtml) return null
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre({ children, ...props }) {
            const child = (Array.isArray(children) ? children[0] : children) as {
              props?: { className?: string; children?: unknown }
            } | null
            if (child?.props && isShellLang(child.props.className)) {
              return (
                <RunnableCode code={String(child.props.children ?? '')}>
                  <pre {...props}>{children}</pre>
                </RunnableCode>
              )
            }
            return <pre {...props}>{children}</pre>
          },
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            const language = match ? match[1] : ''
            if (language === 'mermaid') {
              return (
                <MermaidBlock
                  chart={String(children).replace(/\n$/, '')}
                  theme={theme}
                />
              )
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
          a({ href, children, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            )
          }
        }}
      >
        {content}
      </ReactMarkdown>
    )
  }, [content, isHtml, theme])

  // 空狀態：若完全無目標或不支援且無其他預覽分頁
  if (!targetPath) {
    return (
      <div className="preview-panel-container">
        <div className="preview-empty-container">
          <div className="preview-empty-card">
            <div className="preview-empty-icon">
              <svg viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
            <div className="preview-empty-title">Select a .md or .html file to preview</div>
            <p className="preview-empty-desc">
              Pick a Markdown or HTML file in the file tree or tabs to open a live preview.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="preview-panel-container">
      {/* 預覽多檔分頁列（以 openTabs 為準） */}
      {previewTabs.length > 0 && (
        <div className="preview-tabs-bar">
          {previewTabs.map((p) => {
            const isTabCommit = p.startsWith('commit:')
            let tabName = p.replace(/\\/g, '/').split('/').pop() || p
            let tabTag = ''
            if (isTabCommit) {
              const parts = p.split(':')
              const hash = parts[1]
              const relPath = parts.slice(2).join(':')
              tabName = relPath.replace(/\\/g, '/').split('/').pop() || 'Commit'
              tabTag = `(${hash.slice(0, 7)})`
            }
            const isActive = p === targetPath
            return (
              <div
                key={p}
                className={`preview-tab-item ${isActive ? 'active' : ''}`}
                onClick={() => handleSelectTab(p)}
                title={p}
              >
                <span className="preview-tab-title">
                  {tabName} {tabTag && <span style={{ opacity: 0.7, fontSize: '0.9em' }}>{tabTag}</span>}
                </span>
                <button
                  className="preview-tab-close-btn"
                  onClick={(e) => handleCloseTab(p, e)}
                  title="Close preview"
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}

      {!isSupported ? (
        <div className="preview-empty-container">
          <div className="preview-empty-card">
            <div className="preview-empty-icon">
              <svg viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
            <div className="preview-empty-title">Select a .md or .html file to preview</div>
            <p className="preview-empty-desc">
              “{displayFileName}” is not a Markdown (.md) or HTML (.html) file.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* 頂部工具列 */}
            <div className="preview-toolbar">
              <div className="preview-file-info">
                <span className={`preview-badge ${isHtml ? 'html' : 'md'}`}>
                  {isHtml ? 'HTML' : 'Markdown'}
                </span>
                <span className="preview-filename" title={cleanFilePath}>
                  {displayFileName}
                </span>
                <span
                  className="preview-live-tag"
                  title="Live auto-sync active: Automatically updates as you type, on save, or when modified by an Agent"
                >
                  <span className="preview-live-dot" />
                  <span>Live</span>
                </span>
              </div>
              <div className="preview-actions">
                <button
                  className="preview-btn"
                  onClick={handleRefresh}
                  title="Force reload preview from disk"
                  disabled={loading}
                >
                  <svg viewBox="0 0 24 24">
                    <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                  </svg>
                  <span>{loading ? 'Updating…' : 'Refresh'}</span>
                </button>
              </div>
            </div>

          {/* 錯誤提示 */}
          {error && (
            <div className="mermaid-error-box" style={{ margin: '16px 20px 0' }}>
              <div className="mermaid-error-header">
                <span className="mermaid-error-dot" />
                <span>Failed to read file</span>
              </div>
              <div className="mermaid-error-msg">{error}</div>
            </div>
          )}

          {/* 內容區：Markdown 渲染或 HTML 沙箱 */}
          {isHtml ? (
            <div className="preview-html-frame-wrapper">
              <iframe
                key={manualTick}
                sandbox="allow-same-origin"
                srcDoc={content}
                title={`Preview - ${displayFileName}`}
                className="preview-html-frame"
              />
            </div>
          ) : (
            <div className="preview-content">
              <div className="preview-markdown-body">
                {renderedMarkdown}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
