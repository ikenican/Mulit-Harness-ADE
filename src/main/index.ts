import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerFileHandlers } from './ipc/files'
import { registerGitHandlers } from './ipc/git'
import { registerPtyHandlers } from './ipc/pty'
import { registerNotifyHandlers } from './ipc/notify'
import { registerExtHandlers } from './ipc/ext'
import { registerConnHandlers } from './ipc/conn'

// 目前工作區根目錄；files handler 會用到，pickWorkspace 可更新。
export const workspace = { root: process.cwd() }

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite dev server / 生產打包載入
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerFileHandlers()
  registerGitHandlers()
  registerPtyHandlers()
  registerNotifyHandlers()
  registerExtHandlers()
  registerConnHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
