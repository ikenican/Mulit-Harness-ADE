import { app, BrowserWindow, shell, ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { join } from 'path'
import {
  registerFileHandlers,
  attachWindowToWorkspace,
  detachWindowFromWorkspace
} from './ipc/files'
import { registerGitHandlers } from './ipc/git'
import { registerPtyHandlers, cleanupPtyForWindow } from './ipc/pty'
import { registerNotifyHandlers } from './ipc/notify'
import { registerExtHandlers } from './ipc/ext'
import { registerConnHandlers } from './ipc/conn'
import { registerSettingsHandlers, getLastWorkspace, isProtectedPath, saveLastWorkspace } from './ipc/settings'
import { registerDashboardHandlers } from './ipc/dashboard'
import { registerUpdaterHandlers } from './ipc/updater'

function determineInitialWorkspace(): string {
  const last = getLastWorkspace()
  if (last && fs.existsSync(last) && !isProtectedPath(last)) return last

  const cwd = process.cwd()
  if (cwd && !isProtectedPath(cwd) && fs.existsSync(cwd)) {
    return cwd
  }

  try {
    const docs = app.getPath('documents')
    if (docs && fs.existsSync(docs)) return docs
    const home = app.getPath('home')
    if (home && fs.existsSync(home)) return home
  } catch {}

  return cwd
}

export interface ProjectWindowEntry {
  window: BrowserWindow
  workspaceRoot: string
}

const projectWindows = new Map<number, ProjectWindowEntry>()
let defaultWorkspaceRoot = determineInitialWorkspace()

/**
 * 依 IPC 來源事件解析發起呼叫的視窗所屬的工作區。
 * 若無事件或非專案視窗，則退回至目前聚焦視窗或預設工作區。
 */
export function getWorkspaceForEvent(
  event?: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent
): string {
  if (event) {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && projectWindows.has(win.id)) {
      return projectWindows.get(win.id)!.workspaceRoot
    }
  }

  const focused = BrowserWindow.getFocusedWindow()
  if (focused && projectWindows.has(focused.id)) {
    return projectWindows.get(focused.id)!.workspaceRoot
  }

  return defaultWorkspaceRoot
}

/**
 * 更新特定視窗的工作區綁定與標題
 */
export function setWorkspaceForWindow(win: BrowserWindow, newPath: string): void {
  const entry = projectWindows.get(win.id)
  if (entry) {
    entry.workspaceRoot = newPath
  } else {
    projectWindows.set(win.id, { window: win, workspaceRoot: newPath })
  }
  defaultWorkspaceRoot = newPath
  saveLastWorkspace(newPath)

  try {
    const name = path.basename(newPath)
    win.setTitle(`${name} — Agent Workbench`)
  } catch {}
}

/**
 * 取得所有使用中的專案視窗
 */
export function getAllProjectWindows(): ProjectWindowEntry[] {
  return Array.from(projectWindows.values()).filter((e) => !e.window.isDestroyed())
}

/**
 * 取得目前聚焦或最近啟用的專案視窗
 */
export function getActiveProjectWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && projectWindows.has(focused.id) && !focused.isDestroyed()) {
    return focused
  }
  const all = getAllProjectWindows()
  return all.length > 0 ? all[0].window : null
}

// 相容舊有單例 workspace 物件呼叫
export const workspace = {
  get root(): string {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && projectWindows.has(focused.id)) {
      return projectWindows.get(focused.id)!.workspaceRoot
    }
    return defaultWorkspaceRoot
  },
  set root(val: string) {
    defaultWorkspaceRoot = val
  }
}

let terminalWindow: BrowserWindow | null = null

export function createWindow(initialWorkspace?: string): BrowserWindow {
  const ws = initialWorkspace && fs.existsSync(initialWorkspace)
    ? path.resolve(initialWorkspace)
    : determineInitialWorkspace()

  const folderName = path.basename(ws) || 'Agent Workbench'

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: `${folderName} — Agent Workbench`,
    backgroundColor: '#161618',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? {
            color: '#1e1e20',
            symbolColor: '#f5f5f7',
            height: 38
          }
        : false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  const winId = win.id
  const webContentsId = win.webContents.id

  projectWindows.set(winId, { window: win, workspaceRoot: ws })
  defaultWorkspaceRoot = ws

  // 掛載該視窗專屬的工作區檔案監聽
  attachWindowToWorkspace(winId, ws)

  const showWindow = (): void => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      win.show()
      win.focus()
    }
  }

  win.once('ready-to-show', () => {
    showWindow()
  })
  win.webContents.once('dom-ready', () => {
    setTimeout(showWindow, 50)
  })
  win.webContents.once('did-finish-load', () => {
    setTimeout(showWindow, 50)
  })
  // 兜底保證：避免 Windows/Chromium 首屏繪製延遲導致視窗隱形
  setTimeout(showWindow, 500)

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Main] did-fail-load: ${errorCode} ${errorDescription} ${validatedURL}`)
  })
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer log L${level}] ${message} (${sourceId}:${line})`)
  })
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 在視窗關閉前（DOM 與 WebContents 尚未銷毀）執行 PTY 行程終止與工作區清理
  win.on('close', () => {
    try {
      cleanupPtyForWindow(webContentsId)
    } catch (e) {
      console.error('[Main] error cleaning up pty on close:', e)
    }
    const entry = projectWindows.get(winId)
    if (entry) {
      try {
        detachWindowFromWorkspace(winId, entry.workspaceRoot)
      } catch (e) {
        console.error('[Main] error detaching window from workspace:', e)
      }
    }
    projectWindows.delete(winId)
  })

  win.on('closed', () => {
    projectWindows.delete(winId)
    if (projectWindows.size === 0) {
      if (terminalWindow && !terminalWindow.isDestroyed()) {
        try {
          terminalWindow.close()
        } catch {}
      }
    }
  })

  // electron-vite dev server / 生產打包載入，附帶 ?workspace= 參數
  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    url.searchParams.set('workspace', ws)
    console.log('[Main] loading ELECTRON_RENDERER_URL:', url.toString())
    win.loadURL(url.toString())
  } else {
    const htmlPath = join(__dirname, '../renderer/index.html')
    console.log('[Main] loading file:', htmlPath, 'workspace:', ws)
    win.loadFile(htmlPath, {
      query: { workspace: ws }
    })
  }

  return win
}

/**
 * 開啟專案視窗（若已開啟則聚焦既有視窗，否則建立新視窗）
 */
export function openProjectWindow(targetWorkspace?: string): BrowserWindow {
  if (targetWorkspace && fs.existsSync(targetWorkspace)) {
    const normTarget = path.normalize(path.resolve(targetWorkspace)).toLowerCase()
    for (const entry of projectWindows.values()) {
      if (!entry.window.isDestroyed()) {
        const normEntry = path.normalize(path.resolve(entry.workspaceRoot)).toLowerCase()
        if (normEntry === normTarget) {
          if (entry.window.isMinimized()) entry.window.restore()
          entry.window.show()
          entry.window.focus()
          return entry.window
        }
      }
    }
  }

  return createWindow(targetWorkspace)
}

function createTerminalWindow(): void {
  if (terminalWindow && !terminalWindow.isDestroyed()) {
    terminalWindow.focus()
    return
  }

  terminalWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    title: 'Agent Terminals - Agent Workbench',
    backgroundColor: '#161618',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? {
            color: '#161618',
            symbolColor: '#f5f5f7',
            height: 38
          }
        : false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })

  const showTerminal = (): void => {
    if (terminalWindow && !terminalWindow.isDestroyed() && !terminalWindow.isVisible()) {
      terminalWindow.show()
      terminalWindow.focus()
    }
  }
  terminalWindow.once('ready-to-show', showTerminal)
  terminalWindow.webContents.once('dom-ready', () => setTimeout(showTerminal, 50))
  terminalWindow.webContents.once('did-finish-load', () => {
    setTimeout(showTerminal, 50)
  })
  setTimeout(showTerminal, 500)

  terminalWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  terminalWindow.on('closed', () => {
    terminalWindow = null
    const activeWin = getActiveProjectWindow()
    if (activeWin && !activeWin.isDestroyed()) {
      try {
        if (!activeWin.webContents.isDestroyed()) {
          activeWin.webContents.send('terminal:attached')
        }
      } catch {}
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    terminalWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?mode=terminal-detached`)
  } else {
    terminalWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { mode: 'terminal-detached' }
    })
  }
}

function registerWindowHandlers(): void {
  ipcMain.handle('window:openTerminalWindow', () => {
    createTerminalWindow()
    return true
  })

  ipcMain.handle('window:closeTerminalWindow', () => {
    if (terminalWindow && !terminalWindow.isDestroyed()) {
      terminalWindow.close()
    }
    return true
  })

  ipcMain.handle('window:openProjectWindow', (_e, workspacePath?: string) => {
    openProjectWindow(workspacePath)
    return true
  })

  ipcMain.handle('window:setTitleBarTheme', (event, theme: 'light' | 'dark') => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed() && process.platform === 'win32') {
      const isDark = theme === 'dark'
      win.setTitleBarOverlay({
        color: isDark ? '#1e1e20' : '#ffffff',
        symbolColor: isDark ? '#f5f5f7' : '#1d1d1f',
        height: 38
      })
      return true
    }
    return false
  })
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    // 檢查是否從命令列傳入了欲開啟的目錄路徑
    let targetPath: string | undefined
    for (let i = 1; i < commandLine.length; i++) {
      const arg = commandLine[i]
      if (arg && !arg.startsWith('-') && !arg.startsWith('--')) {
        const candidate = path.isAbsolute(arg)
          ? arg
          : path.resolve(workingDirectory || process.cwd(), arg)
        if (fs.existsSync(candidate) && !isProtectedPath(candidate)) {
          targetPath = candidate
          break
        }
      }
    }

    if (targetPath) {
      openProjectWindow(targetPath)
    } else {
      const win = getActiveProjectWindow()
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    }
  })

  app.whenReady().then(() => {
    registerFileHandlers()
    registerGitHandlers()
    registerPtyHandlers()
    registerNotifyHandlers()
    registerExtHandlers()
    registerConnHandlers()
    registerSettingsHandlers()
    registerDashboardHandlers()
    registerUpdaterHandlers()
    registerWindowHandlers()
    createWindow()

    app.on('activate', () => {
      if (projectWindows.size === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
