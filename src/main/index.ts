import { app, BrowserWindow, shell, ipcMain } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import { registerFileHandlers } from './ipc/files'
import { registerGitHandlers } from './ipc/git'
import { registerPtyHandlers } from './ipc/pty'
import { registerNotifyHandlers } from './ipc/notify'
import { registerExtHandlers } from './ipc/ext'
import { registerConnHandlers } from './ipc/conn'
import { registerSettingsHandlers, getLastWorkspace, isProtectedPath } from './ipc/settings'
import { registerDashboardHandlers } from './ipc/dashboard'
import { registerUpdaterHandlers } from './ipc/updater'

function determineInitialWorkspace(): string {
  const last = getLastWorkspace()
  if (last) return last

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

// 目前工作區根目錄；files handler 會用到，pickWorkspace 可更新。
export const workspace = { root: determineInitialWorkspace() }

let mainWindow: BrowserWindow | null = null
let terminalWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
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

  const showWindow = (): void => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show()
      mainWindow.focus()
    }
  }

  mainWindow.once('ready-to-show', () => {
    showWindow()
  })
  mainWindow.webContents.once('dom-ready', () => {
    setTimeout(showWindow, 50)
  })
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(showWindow, 50)
  })
  // 兜底保證：避免 Windows/Chromium 首屏繪製延遲導致視窗隱形
  setTimeout(showWindow, 500)

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Main] did-fail-load: ${errorCode} ${errorDescription} ${validatedURL}`)
  })
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer log L${level}] ${message} (${sourceId}:${line})`)
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    if (terminalWindow && !terminalWindow.isDestroyed()) {
      terminalWindow.close()
    }
  })

  // electron-vite dev server / 生產打包載入
  if (process.env['ELECTRON_RENDERER_URL']) {
    console.log('[Main] loading ELECTRON_RENDERER_URL:', process.env['ELECTRON_RENDERER_URL'])
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    const htmlPath = join(__dirname, '../renderer/index.html')
    console.log('[Main] loading file:', htmlPath)
    mainWindow.loadFile(htmlPath)
  }
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:attached')
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

  ipcMain.handle('window:setTitleBarTheme', (_e, theme: 'light' | 'dark') => {
    if (mainWindow && !mainWindow.isDestroyed() && process.platform === 'win32') {
      const isDark = theme === 'dark'
      mainWindow.setTitleBarOverlay({
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
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
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
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
