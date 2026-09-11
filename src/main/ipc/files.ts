import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import { existsSync } from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { workspace } from '../index'
import type { FsEntry, FileStat, DocToolPaths } from '../../preload'
import { getCustomDocToolPath } from './settings'

const IGNORED = new Set(['.git', 'node_modules', 'out', '.deps'])

// 忽略目錄清單（檔案監控用）
const WATCH_IGNORED_DIRS = [
  '.git',
  'node_modules',
  'out',
  'dist',
  'build',
  '.deps',
  '.workbench',
  '.gemini',
  '.project-memory',
  '.system_generated',
  '.vscode',
  '.idea',
  '.next',
  '.nuxt',
  'coverage'
]

// 支援自動在 Editor 開啟的檔案副檔名
const SUPPORTED_EDITOR_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '.css', '.scss', '.less', '.html', '.htm',
  '.md', '.markdown', '.py', '.rs', '.go', '.java',
  '.c', '.cpp', '.h', '.hpp', '.sh', '.bash', '.zsh',
  '.yaml', '.yml', '.toml', '.ini', '.sql', '.xml', '.svg',
  '.docx', '.xlsx', '.pptx', '.pdf'
])

// 記錄由 IDE 本身觸發的存檔路徑（避免使用者在 Editor 存檔時又被當作外部變更觸發提示）
const suppressedByIdeWrite = new Set<string>()
let workspaceWatcher: fsSync.FSWatcher | null = null
const pendingDebounceTimers = new Map<string, NodeJS.Timeout>()

/**
 * 啟動或重啟工作區檔案變更監聽
 */
export function initWorkspaceWatcher(): void {
  if (workspaceWatcher) {
    try {
      workspaceWatcher.close()
    } catch {
      // ignore
    }
    workspaceWatcher = null
  }

  if (!workspace.root || !existsSync(workspace.root)) return

  try {
    workspaceWatcher = fsSync.watch(workspace.root, { recursive: true }, (_eventType, filename) => {
      if (!filename) return

      // 標準化相對路徑
      const relPath = filename.replace(/\\/g, '/')
      const pathParts = relPath.split('/')

      // 檢查是否命中忽略目錄
      for (const part of pathParts) {
        if (WATCH_IGNORED_DIRS.includes(part.toLowerCase())) {
          return
        }
      }

      // 忽略暫存或鎖定檔
      const lowerRel = relPath.toLowerCase()
      if (
        lowerRel.endsWith('.tmp') ||
        lowerRel.endsWith('.log') ||
        lowerRel.endsWith('.swp') ||
        lowerRel.endsWith('.lock') ||
        lowerRel.endsWith('package-lock.json') ||
        lowerRel.endsWith('pnpm-lock.yaml') ||
        lowerRel.endsWith('yarn.lock')
      ) {
        return
      }

      const ext = path.extname(filename).toLowerCase()
      if (!SUPPORTED_EDITOR_EXTENSIONS.has(ext)) {
        return
      }

      const fullPath = path.resolve(workspace.root, filename)
      const normKey = fullPath.toLowerCase()

      // 若為 IDE 自身的寫入操作，忽略並跳過
      if (suppressedByIdeWrite.has(normKey)) {
        return
      }

      // 防抖 300ms（Agent 多次寫入 chunk 或連續儲存）
      const existingTimer = pendingDebounceTimers.get(normKey)
      if (existingTimer) {
        clearTimeout(existingTimer)
      }

      const timer = setTimeout(() => {
        pendingDebounceTimers.delete(normKey)
        try {
          if (existsSync(fullPath)) {
            const stat = fsSync.statSync(fullPath)
            if (stat.isFile()) {
              // 廣播給所有 BrowserWindow（mainWindow）
              const wins = BrowserWindow.getAllWindows()
              for (const w of wins) {
                if (!w.isDestroyed()) {
                  w.webContents.send('files:externalChange', {
                    path: fullPath,
                    relativePath: relPath,
                    eventType: 'change'
                  })
                }
              }
            }
          }
        } catch {
          // ignore transient access errors
        }
      }, 300)

      pendingDebounceTimers.set(normKey, timer)
    })
  } catch (e) {
    console.warn('[Watcher] Failed to start workspace watcher:', e)
  }
}

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
  // 啟動工作區監控
  initWorkspaceWatcher()

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
      const normKey = safePath.toLowerCase()
      suppressedByIdeWrite.add(normKey)
      setTimeout(() => {
        suppressedByIdeWrite.delete(normKey)
      }, 1000)

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
      initWorkspaceWatcher()
      return workspace.root
    }

    return null
  })

  // Open file with external application (custom tool or system default)
  ipcMain.handle(
    'files:openExternal',
    async (
      _event,
      targetPath: string,
      customToolPath?: string
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const safePath = resolveSafePath(targetPath)
        const ext = path.extname(safePath).toLowerCase()

        let toolExe: string | null = customToolPath?.trim() || null

        if (!toolExe) {
          if (ext === '.docx' || ext === '.doc') {
            toolExe = getCustomDocToolPath('word')
          } else if (ext === '.xlsx' || ext === '.xls') {
            toolExe = getCustomDocToolPath('excel')
          } else if (ext === '.pptx' || ext === '.ppt') {
            toolExe = getCustomDocToolPath('powerpoint')
          } else if (ext === '.pdf') {
            toolExe = getCustomDocToolPath('pdf')
          }
        }

        if (toolExe && existsSync(toolExe)) {
          spawn(toolExe, [safePath], {
            detached: true,
            stdio: 'ignore'
          }).unref()
          return { ok: true }
        }

        const err = await shell.openPath(safePath)
        if (err) {
          return { ok: false, error: err }
        }
        return { ok: true }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: msg }
      }
    }
  )

  // Show item in OS file explorer / Finder
  ipcMain.handle('files:showInFolder', async (_event, targetPath: string): Promise<void> => {
    const safePath = resolveSafePath(targetPath)
    shell.showItemInFolder(safePath)
  })

  // Get file stats (size, modified time, isFile)
  ipcMain.handle('files:stat', async (_event, targetPath: string): Promise<FileStat> => {
    const safePath = resolveSafePath(targetPath)
    const st = await fs.stat(safePath)
    return {
      size: st.size,
      mtime: st.mtime.toISOString(),
      isFile: st.isFile()
    }
  })

  // Pick executable path via native file dialog
  ipcMain.handle('files:pickExecutable', async (_event, title?: string): Promise<string | null> => {
    const isWin = process.platform === 'win32'
    const filters = isWin
      ? [
          { name: 'Executables (*.exe, *.cmd, *.bat)', extensions: ['exe', 'cmd', 'bat'] },
          { name: 'All Files (*.*)', extensions: ['*'] }
        ]
      : [{ name: 'All Files (*)', extensions: ['*'] }]

    const res = await dialog.showOpenDialog({
      title: title || 'Select Application Executable',
      properties: ['openFile'],
      filters
    })

    if (!res.canceled && res.filePaths.length > 0) {
      return res.filePaths[0]
    }
    return null
  })

  // Scan and detect installed Office and PDF tools
  ipcMain.handle('files:detectDocTools', async (): Promise<DocToolPaths> => {
    return detectInstalledDocTools()
  })
}

function scanFirstExisting(candidates: string[]): string {
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return ''
}

export function detectInstalledDocTools(): DocToolPaths {
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'

  if (isWin) {
    const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const localApp = process.env['LOCALAPPDATA'] || ''

    const wordCandidates = [
      path.join(progFiles, 'Microsoft Office\\root\\Office16\\WINWORD.EXE'),
      path.join(progFilesX86, 'Microsoft Office\\root\\Office16\\WINWORD.EXE'),
      path.join(progFiles, 'Microsoft Office\\Office16\\WINWORD.EXE'),
      path.join(progFilesX86, 'Microsoft Office\\Office16\\WINWORD.EXE'),
      path.join(progFiles, 'Microsoft Office\\Office15\\WINWORD.EXE'),
      path.join(progFilesX86, 'Microsoft Office\\Office15\\WINWORD.EXE'),
      path.join(localApp, 'Kingsoft\\WPS Office\\ksolaunch.exe')
    ]

    const excelCandidates = [
      path.join(progFiles, 'Microsoft Office\\root\\Office16\\EXCEL.EXE'),
      path.join(progFilesX86, 'Microsoft Office\\root\\Office16\\EXCEL.EXE'),
      path.join(progFiles, 'Microsoft Office\\Office16\\EXCEL.EXE'),
      path.join(progFilesX86, 'Microsoft Office\\Office16\\EXCEL.EXE'),
      path.join(progFiles, 'Microsoft Office\\Office15\\EXCEL.EXE'),
      path.join(progFilesX86, 'Microsoft Office\\Office15\\EXCEL.EXE'),
      path.join(localApp, 'Kingsoft\\WPS Office\\ksolaunch.exe')
    ]

    const pptCandidates = [
      path.join(progFiles, 'Microsoft Office\\root\\Office16\\POWERPNT.EXE'),
      path.join(progFilesX86, 'Microsoft Office\\root\\Office16\\POWERPNT.EXE'),
      path.join(progFiles, 'Microsoft Office\\Office16\\POWERPNT.EXE'),
      path.join(progFilesX86, 'Microsoft Office\\Office16\\POWERPNT.EXE'),
      path.join(progFiles, 'Microsoft Office\\Office15\\POWERPNT.EXE'),
      path.join(progFilesX86, 'Microsoft Office\\Office15\\POWERPNT.EXE'),
      path.join(localApp, 'Kingsoft\\WPS Office\\ksolaunch.exe')
    ]

    const pdfCandidates = [
      path.join(progFiles, 'Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe'),
      path.join(progFilesX86, 'Adobe\\Acrobat Reader DC\\Reader\\AcroRd32.exe'),
      path.join(progFiles, 'SumatraPDF\\SumatraPDF.exe'),
      path.join(localApp, 'SumatraPDF\\SumatraPDF.exe'),
      path.join(progFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(progFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(progFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(progFilesX86, 'Google\\Chrome\\Application\\chrome.exe')
    ]

    return {
      word: scanFirstExisting(wordCandidates),
      excel: scanFirstExisting(excelCandidates),
      powerpoint: scanFirstExisting(pptCandidates),
      pdf: scanFirstExisting(pdfCandidates)
    }
  }

  if (isMac) {
    return {
      word: scanFirstExisting(['/Applications/Microsoft Word.app']),
      excel: scanFirstExisting(['/Applications/Microsoft Excel.app']),
      powerpoint: scanFirstExisting(['/Applications/Microsoft PowerPoint.app']),
      pdf: scanFirstExisting([
        '/System/Applications/Preview.app',
        '/Applications/Adobe Acrobat DC/Adobe Acrobat.app'
      ])
    }
  }

  return {
    word: '',
    excel: '',
    powerpoint: '',
    pdf: ''
  }
}
