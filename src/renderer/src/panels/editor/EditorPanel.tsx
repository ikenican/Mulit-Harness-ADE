/// <reference path="../../../../preload/index.d.ts" />
import { useState, useEffect, useRef, useCallback } from 'react'
import Editor, { DiffEditor, OnMount } from '@monaco-editor/react'
import { bumpGit, closeTab, openFile, useWorkbench } from '@/store'
import './EditorPanel.css'

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    md: 'markdown',
    markdown: 'markdown',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    py: 'python',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hh: 'cpp',
    rs: 'rust',
    go: 'go',
    java: 'java',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    svg: 'xml',
    sql: 'sql',
    ini: 'ini',
    toml: 'ini'
  }
  return map[ext] || 'plaintext'
}

function EmptyEditorState(): JSX.Element {
  return (
    <div className="editor-empty-container">
      <svg
        className="editor-empty-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
      <div className="editor-empty-title">No file open</div>
      <div className="editor-empty-desc">
        Click a file in the Files panel to start editing, or pick a changed file in the Git panel to view its diff.
      </div>
    </div>
  )
}

export default function EditorPanel(): JSX.Element {
  const workbench = useWorkbench() as {
    activeFilePath: string | null
    viewMode: 'edit' | 'diff'
    gitTick: number
    openTabs: string[]
    theme?: 'light' | 'dark'
  }

  const { activeFilePath, viewMode, gitTick, openTabs } = workbench
  const monacoTheme = workbench.theme === 'light' ? 'light' : 'vs-dark'

  // 每個檔一份 model：切換分頁不會弄丟尚未存檔的編輯
  const [models, setModels] = useState<Record<string, { content: string; initial: string }>>({})
  const [isSaving, setIsSaving] = useState<boolean>(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  const model = activeFilePath ? models[activeFilePath] : undefined
  const content = model?.content ?? ''
  const isDirty = !!model && model.content !== model.initial
  const dirtyPaths = new Set(
    Object.entries(models)
      .filter(([, m]) => m.content !== m.initial)
      .map(([p]) => p)
  )

  // Diff mode state
  const [diffData, setDiffData] = useState<{ head: string; work: string }>({
    head: '',
    work: ''
  })

  // Common status
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // References for keyboard commands
  const editorRef = useRef<any>(null)
  const contentRef = useRef<string>('')
  contentRef.current = content

  // Save implementation
  const handleSave = useCallback(async (): Promise<void> => {
    if (!activeFilePath || isSaving) return

    const currentText = editorRef.current
      ? editorRef.current.getValue()
      : contentRef.current

    try {
      setIsSaving(true)
      setError(null)
      await window.api.files.write(activeFilePath, currentText)
      bumpGit()
      setModels((m) => ({
        ...m,
        [activeFilePath]: { content: currentText, initial: currentText }
      }))
      setSaveMessage('Saved')
      setTimeout(() => {
        setSaveMessage(null)
      }, 2000)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Save failed: ${msg}`)
    } finally {
      setIsSaving(false)
    }
  }, [activeFilePath, isSaving])

  const saveRef = useRef(handleSave)
  saveRef.current = handleSave

  // Bind Ctrl+S / Cmd+S in global window
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Monaco Editor Mount
  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current()
    })
  }

  // Load file or diff on activeFilePath or viewMode change
  useEffect(() => {
    if (!activeFilePath) {
      setError(null)
      setLoading(false)
      return
    }

    let isMounted = true

    const loadData = async (): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        if (viewMode === 'edit') {
          // 已有未存檔編輯就不要從磁碟覆蓋回去（gitTick 變動也會跑到這裡）
          const existing = models[activeFilePath]
          if (existing && existing.content !== existing.initial) {
            setLoading(false)
            return
          }
          const text = await window.api.files.read(activeFilePath)
          if (isMounted) {
            setModels((m) => ({ ...m, [activeFilePath]: { content: text, initial: text } }))
          }
        } else if (viewMode === 'diff') {
          const diff = await window.api.git.diff(activeFilePath)
          if (isMounted) {
            setDiffData(diff || { head: '', work: '' })
          }
        }
      } catch (err: unknown) {
        if (isMounted) {
          const msg = err instanceof Error ? err.message : String(err)
          setError(msg)
        }
      } finally {
        if (isMounted) {
          setLoading(false)
        }
      }
    }

    loadData()

    return () => {
      isMounted = false
    }
  }, [activeFilePath, viewMode, gitTick])

  const handleContentChange = (value?: string): void => {
    if (!activeFilePath) return
    const nextVal = value ?? ''
    setModels((m) => ({
      ...m,
      [activeFilePath]: { content: nextVal, initial: m[activeFilePath]?.initial ?? nextVal }
    }))
  }

  // 關分頁；有未存檔編輯先問一次，避免默默丟掉工作
  const handleCloseTab = (path: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    if (dirtyPaths.has(path)) {
      const name = path.split(/[\\/]/).pop()
      if (!window.confirm(`“${name}” has unsaved changes. Close it anyway?`)) return
    }
    setModels((m) => {
      const next = { ...m }
      delete next[path]
      return next
    })
    closeTab(path)
  }

  if (!activeFilePath) {
    return <EmptyEditorState />
  }

  const language = detectLanguage(activeFilePath)
  const fileName = activeFilePath.split(/[\\/]/).pop() || activeFilePath

  return (
    <div className="editor-container">
      {openTabs.length > 0 && (
        <div className="editor-tabs">
          {openTabs.map((p) => {
            const name = p.split(/[\\/]/).pop() || p
            return (
              <div
                key={p}
                className={`editor-tab ${p === activeFilePath ? 'on' : ''}`}
                onClick={() => openFile(p)}
                title={p}
              >
                <span className="editor-tab-name">{name}</span>
                {dirtyPaths.has(p) && <span className="editor-tab-dot" title="Unsaved changes" />}
                <button
                  className="editor-tab-close"
                  onClick={(e) => handleCloseTab(p, e)}
                  aria-label={`Close ${name}`}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}
      <div className="editor-header">
        <div className="editor-header-left">
          <span
            className={`editor-badge ${
              viewMode === 'edit' ? 'badge-edit' : 'badge-diff'
            }`}
          >
            {viewMode === 'edit' ? 'Edit' : 'Diff'}
          </span>
          <div className="editor-filename-wrapper" title={activeFilePath}>
            <span className="editor-filename">{fileName}</span>
            {viewMode === 'edit' && isDirty && (
              <span className="editor-dirty-dot" title="Unsaved changes" />
            )}
          </div>
        </div>

        <div className="editor-header-right">
          {saveMessage && <span className="editor-save-badge">{saveMessage}</span>}
          <span className="editor-lang-tag">{language}</span>
          {viewMode === 'edit' && (
            <button
              className="editor-btn-save"
              onClick={handleSave}
              disabled={isSaving || !isDirty}
              title="Save file (Ctrl+S / Cmd+S)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
              <span>{isSaving ? 'Saving…' : 'Save'}</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="editor-error-bar">
          <span>{error}</span>
          <button
            className="editor-btn-save"
            style={{ padding: '2px 8px', fontSize: '11px' }}
            onClick={() => {
              if (viewMode === 'edit') {
                window.api.files.read(activeFilePath).then((t) => {
                  setModels((m) => ({ ...m, [activeFilePath]: { content: t, initial: t } }))
                  setError(null)
                }).catch(() => {})
              } else {
                window.api.git.diff(activeFilePath).then((d) => {
                  setDiffData(d)
                  setError(null)
                }).catch(() => {})
              }
            }}
          >
            Retry
          </button>
        </div>
      )}

      <div className="editor-body">
        {loading && (
          <div className="editor-loading-overlay">
            <span>Loading…</span>
          </div>
        )}

        {viewMode === 'edit' ? (
          <Editor
            path={activeFilePath}
            value={content}
            language={language}
            theme={monacoTheme}
            onMount={handleEditorDidMount}
            onChange={handleContentChange}
            options={{
              fontSize: 13,
              fontFamily: "'SF Mono', Monaco, Menlo, Consolas, 'Courier New', monospace",
              tabSize: 2,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              minimap: { enabled: true, maxColumn: 80 },
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              wordWrap: 'on',
              renderLineHighlight: 'all',
              roundedSelection: true
            }}
          />
        ) : (
          <DiffEditor
            original={diffData.head}
            modified={diffData.work}
            language={language}
            theme={monacoTheme}
            options={{
              readOnly: true,
              fontSize: 13,
              fontFamily: "'SF Mono', Monaco, Menlo, Consolas, 'Courier New', monospace",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              renderSideBySide: true,
              smoothScrolling: true
            }}
          />
        )}
      </div>
    </div>
  )
}
