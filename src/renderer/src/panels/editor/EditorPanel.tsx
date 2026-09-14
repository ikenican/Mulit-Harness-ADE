/// <reference path="../../../../preload/index.d.ts" />
import { useState, useEffect, useRef, useCallback } from 'react'
import Editor, { DiffEditor, OnMount } from '@monaco-editor/react'
import {
  bumpGit,
  closeTab,
  openFile,
  useWorkbench,
  clearAgentModified,
  setEditorDraft,
  clearEditorDraft,
  type GitCommitDiffTarget
} from '@/store'
import { useTranslation } from '@/i18n'
import DocumentViewer, { isDocumentFile } from './DocumentViewer'
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
  const { t } = useTranslation()
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
      <div className="editor-empty-title">{t('editor.noFileOpen')}</div>
      <div className="editor-empty-desc">
        {t('editor.noFileOpenDesc')}
      </div>
    </div>
  )
}

function defineMorandiThemes(monaco: any): void {
  monaco.editor.defineTheme('morandi-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '2c3136', background: 'ece7df' },
      { token: 'comment', foreground: '8a929a', fontStyle: 'italic' },
      { token: 'keyword', foreground: '53787b', fontStyle: 'bold' },
      { token: 'string', foreground: '628367' },
      { token: 'number', foreground: 'af6e5d' },
      { token: 'regexp', foreground: 'af6e5d' },
      { token: 'type', foreground: '53787b' },
      { token: 'class', foreground: '53787b' },
      { token: 'function', foreground: '406568' },
      { token: 'variable', foreground: '2c3136' },
      { token: 'constant', foreground: '9e7352' },
      { token: 'delimiter', foreground: '788089' }
    ],
    colors: {
      'editor.background': '#ece7df',
      'editor.foreground': '#2c3136',
      'editorCursor.foreground': '#53787b',
      'editor.lineHighlightBackground': '#e2ddd4',
      'editorLineNumber.foreground': '#989fa6',
      'editorLineNumber.activeForeground': '#2c3136',
      'editor.selectionBackground': '#cfc7b9',
      'editor.inactiveSelectionBackground': '#ded8cd',
      'editorIndentGuide.background': '#dcd6ca',
      'editorIndentGuide.activeBackground': '#b5ad9e',
      'editorWhitespace.foreground': '#d2ccc0'
    }
  })

  monaco.editor.defineTheme('morandi-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'e2ded6', background: '1c2023' },
      { token: 'comment', foreground: '717a82', fontStyle: 'italic' },
      { token: 'keyword', foreground: '79a3a3', fontStyle: 'bold' },
      { token: 'string', foreground: '8fae92' },
      { token: 'number', foreground: 'cf8d7e' },
      { token: 'regexp', foreground: 'cf8d7e' },
      { token: 'type', foreground: '79a3a3' },
      { token: 'class', foreground: '79a3a3' },
      { token: 'function', foreground: '92b5b5' },
      { token: 'variable', foreground: 'e2ded6' },
      { token: 'constant', foreground: 'd4a37e' },
      { token: 'delimiter', foreground: 'a0a7ad' }
    ],
    colors: {
      'editor.background': '#1c2023',
      'editor.foreground': '#e2ded6',
      'editorCursor.foreground': '#79a3a3',
      'editor.lineHighlightBackground': '#252a2f',
      'editorLineNumber.foreground': '#646d76',
      'editorLineNumber.activeForeground': '#e2ded6',
      'editor.selectionBackground': '#3a444c',
      'editor.inactiveSelectionBackground': '#2d353b',
      'editorIndentGuide.background': '#2b3137',
      'editorIndentGuide.activeBackground': '#454e56',
      'editorWhitespace.foreground': '#31373e'
    }
  })
}

function getMonacoTheme(theme?: string): string {
  switch (theme) {
    case 'light':
      return 'light'
    case 'light-morandi':
      return 'morandi-light'
    case 'dark-morandi':
      return 'morandi-dark'
    case 'dark':
    default:
      return 'vs-dark'
  }
}

export default function EditorPanel(): JSX.Element {
  const {
    activeFilePath,
    viewMode,
    gitTick,
    openTabs,
    theme,
    agentModifiedFiles,
    fileReloadTick,
    activeCommitDiff
  } = useWorkbench()
  const { t } = useTranslation()
  const monacoTheme = getMonacoTheme(theme)

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
      setEditorDraft(activeFilePath, currentText)
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

    // 若為 Office 或 PDF 等二進位文件，不進行文字讀取，由 DocumentViewer 處理
    if (isDocumentFile(activeFilePath)) {
      setLoading(false)
      setError(null)
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
            setEditorDraft(activeFilePath, text)
            setModels((m) => ({ ...m, [activeFilePath]: { content: text, initial: text } }))
            if (agentModifiedFiles?.has(activeFilePath)) {
              setSaveMessage('Updated by Agent')
              setTimeout(() => setSaveMessage(null), 2200)
            }
          }
        } else if (viewMode === 'diff') {
          if (activeCommitDiff) {
            const { commitHash, filePath, parentHash } = activeCommitDiff
            const d = await window.api.git.commitFileDiff(commitHash, filePath, parentHash)
            if (isMounted) setDiffData({ head: d.original, work: d.modified })
          } else {
            const diff = await window.api.git.diff(activeFilePath)
            if (isMounted) setDiffData(diff || { head: '', work: '' })
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
  }, [activeFilePath, viewMode, gitTick, activeCommitDiff, fileReloadTick?.[activeFilePath || '']])

  const handleContentChange = (value?: string): void => {
    if (!activeFilePath) return
    const nextVal = value ?? ''
    setModels((m) => ({
      ...m,
      [activeFilePath]: { content: nextVal, initial: m[activeFilePath]?.initial ?? nextVal }
    }))
    setEditorDraft(activeFilePath, nextVal)
  }

  // 關分頁；有未存檔編輯先問一次，避免默默丟掉工作
  const handleCloseTab = (path: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    if (dirtyPaths.has(path)) {
      const name = path.split(/[\\/]/).pop()
      if (!window.confirm(`“${name}” has unsaved changes. Close it anyway?`)) return
    }
    clearEditorDraft(path)
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

  const diffPath = activeCommitDiff?.filePath || activeFilePath
  const language = detectLanguage(diffPath)
  const fileName = diffPath.split(/[\\/]/).pop() || diffPath

  return (
    <div className="editor-container">
      {openTabs.length > 0 && (
        <div className="editor-tabs">
          {openTabs.map((p) => {
            const name = p.split(/[\\/]/).pop() || p
            const isAgentMod = agentModifiedFiles?.has(p)
            return (
              <div
                key={p}
                className={`editor-tab ${p === activeFilePath ? 'on' : ''} ${isAgentMod ? 'agent-modified' : ''}`}
                onClick={() => {
                  openFile(p)
                  clearAgentModified(p)
                }}
                title={isAgentMod ? `${p} (Recently modified by Agent)` : p}
              >
                <span className="editor-tab-name">{name}</span>
                {isAgentMod && (
                  <span className="editor-tab-agent-badge" title="Modified by Agent">
                    Agent
                  </span>
                )}
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

      {activeFilePath && isDocumentFile(activeFilePath) && viewMode === 'edit' ? (
        <DocumentViewer filePath={activeFilePath} />
      ) : (
        <>
          <div className="editor-header">
            <div className="editor-header-left">
              <span
                className={`editor-badge ${
                  viewMode === 'edit' ? 'badge-edit' : 'badge-diff'
                }`}
              >
                {viewMode === 'edit' ? t('editor.editMode') : t('editor.diffMode')}
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
                  <span>{isSaving ? t('common.saving') : t('common.save')}</span>
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
                  } else if (activeCommitDiff) {
                    window.api.git
                      .commitFileDiff(
                        activeCommitDiff.commitHash,
                        activeCommitDiff.filePath,
                        activeCommitDiff.parentHash
                      )
                      .then((d) => {
                        setDiffData({ head: d.original, work: d.modified })
                        setError(null)
                      })
                      .catch(() => {})
                  } else {
                    window.api.git.diff(activeFilePath).then((d) => {
                      setDiffData(d)
                      setError(null)
                    }).catch(() => {})
                  }
                }}
              >
                {t('common.retry')}
              </button>
            </div>
          )}

          <div className="editor-body">
            {loading && (
              <div className="editor-loading-overlay">
                <span>{t('common.loading')}</span>
              </div>
            )}

            {viewMode === 'edit' ? (
              <Editor
                path={activeFilePath}
                value={content}
                language={language}
                theme={monacoTheme}
                beforeMount={defineMorandiThemes}
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
                beforeMount={defineMorandiThemes}
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
        </>
      )}
    </div>
  )
}
