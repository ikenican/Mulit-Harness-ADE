/// <reference path="../../../../preload/index.d.ts" />
import { useState, useEffect, useCallback } from 'react'
import { openFile, useWorkbench, setWorkspaceRoot as setGlobalWorkspaceRoot, bumpGit } from '@/store'
import './FileTreePanel.css'

interface FsEntry {
  name: string
  path: string
  isDir: boolean
}

function ChevronIcon({ expanded }: { expanded: boolean }): JSX.Element {
  return (
    <svg
      className={`filetree-chevron ${expanded ? 'expanded' : ''}`}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function FolderIcon({ open }: { open: boolean }): JSX.Element {
  return open ? (
    <svg
      className="filetree-icon folder"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <polygon points="2 10 22 10 20 20 4 20" />
    </svg>
  ) : (
    <svg
      className="filetree-icon folder"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function FileIcon(): JSX.Element {
  return (
    <svg
      className="filetree-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

function OpenFolderIcon(): JSX.Element {
  return (
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
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function RefreshIcon(): JSX.Element {
  return (
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
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  )
}

interface TreeNodeProps {
  entry: FsEntry
  depth: number
  expandedPaths: Set<string>
  loadingPaths: Set<string>
  childrenMap: Record<string, FsEntry[]>
  activeFilePath: string | null
  onToggleFolder: (path: string) => void
  onOpenFile: (path: string) => void
}

function TreeNode({
  entry,
  depth,
  expandedPaths,
  loadingPaths,
  childrenMap,
  activeFilePath,
  onToggleFolder,
  onOpenFile
}: TreeNodeProps): JSX.Element {
  const isExpanded = entry.isDir && expandedPaths.has(entry.path)
  const isLoading = entry.isDir && loadingPaths.has(entry.path)
  const children = childrenMap[entry.path]
  const isActive = !entry.isDir && activeFilePath === entry.path

  const handleClick = (): void => {
    if (entry.isDir) {
      onToggleFolder(entry.path)
    } else {
      onOpenFile(entry.path)
    }
  }

  const indent = 10 + depth * 14

  return (
    <div>
      <div
        className={`filetree-node-row ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: `${indent}px` }}
        onClick={handleClick}
        title={entry.path}
      >
        {entry.isDir ? (
          <ChevronIcon expanded={isExpanded} />
        ) : (
          <span className="filetree-spacer" />
        )}
        {entry.isDir ? <FolderIcon open={isExpanded} /> : <FileIcon />}
        <span className="filetree-name">{entry.name}</span>
      </div>

      {isExpanded && (
        <div className="filetree-sublist">
          {isLoading && (
            <div
              className="filetree-status-row"
              style={{ paddingLeft: `${indent + 26}px` }}
            >
              Loading…
            </div>
          )}
          {!isLoading && children && children.length === 0 && (
            <div
              className="filetree-status-row"
              style={{ paddingLeft: `${indent + 26}px` }}
            >
              (empty folder)
            </div>
          )}
          {!isLoading &&
            children &&
            children.map((child) => (
              <TreeNode
                key={child.path}
                entry={child}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                loadingPaths={loadingPaths}
                childrenMap={childrenMap}
                activeFilePath={activeFilePath}
                onToggleFolder={onToggleFolder}
                onOpenFile={onOpenFile}
              />
            ))}
        </div>
      )}
    </div>
  )
}

export default function FileTreePanel(): JSX.Element {
  const [workspaceRoot, setWorkspaceRoot] = useState<string>('')
  const [rootEntries, setRootEntries] = useState<FsEntry[]>([])
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [childrenMap, setChildrenMap] = useState<Record<string, FsEntry[]>>({})
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const { activeFilePath } = useWorkbench()

  const loadTree = useCallback(async (dir?: string) => {
    try {
      setLoading(true)
      setError(null)
      const targetRoot = dir || (await window.api.files.workspaceRoot())
      setWorkspaceRoot(targetRoot)
      setGlobalWorkspaceRoot(targetRoot)
      const entries = await window.api.files.list(targetRoot)
      setRootEntries(entries)
      setExpandedPaths(new Set())
      setChildrenMap({})
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Cannot read directory: ${msg}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTree()
  }, [loadTree])

  const handlePickWorkspace = async (): Promise<void> => {
    try {
      const newRoot = await window.api.files.pickWorkspace()
      if (newRoot) {
        setGlobalWorkspaceRoot(newRoot)
        bumpGit()
        await loadTree(newRoot)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Failed to pick workspace: ${msg}`)
    }
  }

  const handleToggleFolder = async (folderPath: string): Promise<void> => {
    if (expandedPaths.has(folderPath)) {
      setExpandedPaths((prev) => {
        const next = new Set(prev)
        next.delete(folderPath)
        return next
      })
      return
    }

    // Expand
    setExpandedPaths((prev) => new Set(prev).add(folderPath))

    // Lazy load children if not already loaded
    if (!childrenMap[folderPath]) {
      setLoadingPaths((prev) => new Set(prev).add(folderPath))
      try {
        const children = await window.api.files.list(folderPath)
        setChildrenMap((prev) => ({ ...prev, [folderPath]: children }))
      } catch (err: unknown) {
        console.error('Failed to list folder:', err)
        setChildrenMap((prev) => ({ ...prev, [folderPath]: [] }))
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev)
          next.delete(folderPath)
          return next
        })
      }
    }
  }

  const handleOpenFile = (filePath: string): void => {
    openFile(filePath)
  }

  const folderName = workspaceRoot
    ? workspaceRoot.split(/[\\/]/).filter(Boolean).pop() || workspaceRoot
    : 'Workspace'

  return (
    <div className="filetree-container">
      <div className="filetree-header">
        <div className="filetree-header-info" title={workspaceRoot}>
          <span className="filetree-header-title">{folderName}</span>
        </div>
        <div className="filetree-actions">
          <button
            className="filetree-btn"
            onClick={handlePickWorkspace}
            title="Choose and open a folder"
          >
            <OpenFolderIcon />
            <span>Open Folder</span>
          </button>
          <button
            className="filetree-btn filetree-btn-icon"
            onClick={() => loadTree(workspaceRoot)}
            title="Refresh file tree"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      <div className="filetree-body">
        {loading && (
          <div className="filetree-center-msg">
            <span>Loading…</span>
          </div>
        )}

        {error && (
          <div className="filetree-center-msg">
            <span className="error-text">{error}</span>
            <button
              className="filetree-btn"
              onClick={() => loadTree(workspaceRoot)}
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && rootEntries.length === 0 && (
          <div className="filetree-center-msg">
            <span>This workspace is empty</span>
          </div>
        )}

        {!loading &&
          !error &&
          rootEntries.map((entry) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              childrenMap={childrenMap}
              activeFilePath={activeFilePath}
              onToggleFolder={handleToggleFolder}
              onOpenFile={handleOpenFile}
            />
          ))}
      </div>
    </div>
  )
}
