import { ipcMain, dialog } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { workspace } from '../index'
import type { FsEntry } from '../../preload'

const IGNORED = new Set(['.git', 'node_modules', 'out', '.deps'])

/**
 * Validates that the requested target path is strictly inside workspace.root.
 * Throws an error if the path traverses or escapes outside the workspace boundary.
 */
function resolveSafePath(targetPath: string): string {
  if (!workspace.root) {
    throw new Error('Workspace root is not defined')
  }

  const rootResolved = path.resolve(workspace.root)
  const targetResolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(rootResolved, targetPath)

  const normRoot = path.normalize(rootResolved).toLowerCase()
  const normTarget = path.normalize(targetResolved).toLowerCase()
  const normRootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep

  if (normTarget !== normRoot && !normTarget.startsWith(normRootWithSep)) {
    throw new Error(
      `Access denied: path "${targetPath}" resolves outside workspace root "${workspace.root}"`
    )
  }

  return targetResolved
}

export function registerFileHandlers(): void {
  // Read file as UTF-8 string
  ipcMain.handle('files:read', async (_event, targetPath: string): Promise<string> => {
    const safePath = resolveSafePath(targetPath)
    return await fs.readFile(safePath, 'utf-8')
  })

  // Write file content (ensure parent directory exists)
  ipcMain.handle(
    'files:write',
    async (_event, targetPath: string, content: string): Promise<void> => {
      const safePath = resolveSafePath(targetPath)
      await fs.mkdir(path.dirname(safePath), { recursive: true })
      await fs.writeFile(safePath, content, 'utf-8')
    }
  )

  // List directory entries: directories first, sorted by name; ignore .git/node_modules/out/.deps
  ipcMain.handle('files:list', async (_event, dirPath: string): Promise<FsEntry[]> => {
    const safePath = resolveSafePath(dirPath)
    const entries = await fs.readdir(safePath, { withFileTypes: true })

    const filtered = entries.filter((e) => !IGNORED.has(e.name))
    filtered.sort((a, b) => {
      const aIsDir = a.isDirectory()
      const bIsDir = b.isDirectory()
      if (aIsDir !== bIsDir) {
        return aIsDir ? -1 : 1
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    return filtered.map((e) => ({
      name: e.name,
      path: path.join(safePath, e.name),
      isDir: e.isDirectory()
    }))
  })

  // 存在檢查：給「可能不存在」的路徑用（如 .project-memory/*.md），
  // 避免用 files:read 的例外當流程控制而在 main 端刷出 ENOENT 噪音。
  ipcMain.handle('files:exists', async (_event, targetPath: string): Promise<boolean> => {
    try {
      await fs.access(resolveSafePath(targetPath))
      return true
    } catch {
      return false
    }
  })

  // Return current workspace root path
  ipcMain.handle('files:workspaceRoot', async (): Promise<string> => {
    return workspace.root
  })

  // Pick workspace folder via native dialog; update workspace.root if selected
  ipcMain.handle('files:pickWorkspace', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: workspace.root
    })

    if (!result.canceled && result.filePaths.length > 0) {
      workspace.root = result.filePaths[0]
      return workspace.root
    }

    return null
  })
}
