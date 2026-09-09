import { useState, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useWorkbench } from '@/store'
import MermaidBlock from './MermaidBlock'
import RunnableCode, { isShellLang } from '@/components/RunnableCode'
import './preview.css'

export default function PreviewPanel(): JSX.Element {
  const { activeFilePath, gitTick } = useWorkbench()
  const theme = ((useWorkbench() as { theme?: string }).theme === 'light' ? 'light' : 'dark') as
    | 'light'
    | 'dark'

  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [manualTick, setManualTick] = useState<number>(0)

  // 判斷副檔名
  const ext = activeFilePath ? activeFilePath.split('.').pop()?.toLowerCase() || '' : ''
  const isMd = ext === 'md' || ext === 'markdown'
  const isHtml = ext === 'html' || ext === 'htm'
  const isSupported = isMd || isHtml

  const filename = activeFilePath ? activeFilePath.replace(/\\/g, '/').split('/').pop() : ''

  const loadFile = useCallback(async () => {
    if (!activeFilePath || !isSupported) {
      setContent('')
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const text = await window.api.files.read(activeFilePath)
      setContent(text)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('Failed to read preview file:', err)
      setError(msg || 'Failed to read file')
      setContent('')
    } finally {
      setLoading(false)
    }
  }, [activeFilePath, isSupported])

  useEffect(() => {
    loadFile()
  }, [loadFile, gitTick, manualTick])

  const handleRefresh = (): void => {
    setManualTick((t) => t + 1)
  }

  // 空狀態：未選檔或非 .md/.html
  if (!activeFilePath || !isSupported) {
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
              {activeFilePath
                ? `“${filename}” is selected. This panel renders Markdown (.md) and HTML (.html) live.`
                : 'Pick a Markdown or HTML file in the file tree to open a live preview.'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="preview-panel-container">
      {/* 頂部工具列 */}
      <div className="preview-toolbar">
        <div className="preview-file-info">
          <span className={`preview-badge ${isHtml ? 'html' : 'md'}`}>
            {isHtml ? 'HTML' : 'Markdown'}
          </span>
          <span className="preview-filename" title={activeFilePath}>
            {filename}
          </span>
        </div>
        <div className="preview-actions">
          <button
            className="preview-btn"
            onClick={handleRefresh}
            title="Reload preview"
            disabled={loading}
          >
            <svg viewBox="0 0 24 24">
              <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
            </svg>
            <span>Refresh</span>
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
            title={`Preview - ${filename}`}
            className="preview-html-frame"
          />
        </div>
      ) : (
        <div className="preview-content">
          <div className="preview-markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                // shell 類 code block 右上角給「送到終端」
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
          </div>
        </div>
      )}
    </div>
  )
}
