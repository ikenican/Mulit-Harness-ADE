import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { autoUpdater, UpdateInfo as ElectronUpdateInfo, ProgressInfo } from 'electron-updater'
import * as fs from 'fs'
import { join, dirname } from 'path'
import { isProtectedPath } from './settings'
import type { UpdaterStatus, UpdateInfo } from '../../preload/index'

let updaterStatus: UpdaterStatus = {
  currentVersion: app.getVersion() || '0.1.3',
  isPackaged: app.isPackaged,
  isInstalled: false,
  checking: false,
  updateAvailable: false,
  updateDownloaded: false,
  isDownloading: false
}

/**
 * 判斷當前是否為 NSIS 安裝版（而非免安裝綠色資料夾）
 */
export function isInstalledApp(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'win32') {
    try {
      const exeDir = dirname(app.getPath('exe'))
      const hasUninstaller =
        fs.existsSync(join(exeDir, 'Uninstall Agent Workbench.exe')) ||
        fs.existsSync(join(exeDir, 'Uninstall.exe'))
      const inProtected = isProtectedPath(exeDir)
      return hasUninstaller || inProtected
    } catch {
      return false
    }
  }
  return true
}

function broadcastStatus(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('updater:statusChange', updaterStatus)
    }
  }
}

/**
 * 從 GitHub API 直接查詢最新 Release（適用於免安裝版、非打包環境或備援）
 */
async function fetchLatestFromGitHub(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch('https://api.github.com/repos/zkylek1212-k/Mulit-Harness-ADE/releases/latest', {
      headers: {
        'User-Agent': 'Agent-Workbench-Updater'
      }
    })
    if (!res.ok) return null
    const data: any = await res.json()
    const tagName = (data.tag_name || '').replace(/^v/, '')
    const body = data.body || ''
    const htmlUrl = data.html_url || 'https://github.com/zkylek1212-k/Mulit-Harness-ADE/releases'
    return {
      version: tagName,
      releaseName: data.name || `Version ${tagName}`,
      releaseNotes: body,
      releaseDate: data.published_at,
      downloadUrl: htmlUrl
    }
  } catch (e) {
    console.warn('[Updater] Failed to fetch latest from GitHub API:', e)
    return null
  }
}

function compareSemver(current: string, target: string): number {
  const cParts = current.replace(/^v/, '').split('.').map((p) => parseInt(p, 10) || 0)
  const tParts = target.replace(/^v/, '').split('.').map((p) => parseInt(p, 10) || 0)
  for (let i = 0; i < Math.max(cParts.length, tParts.length); i++) {
    const c = cParts[i] || 0
    const t = tParts[i] || 0
    if (c < t) return -1
    if (c > t) return 1
  }
  return 0
}

export function registerUpdaterHandlers(): void {
  updaterStatus.currentVersion = app.getVersion() || '0.1.3'
  updaterStatus.isPackaged = app.isPackaged
  updaterStatus.isInstalled = isInstalledApp()

  // 預設關閉自動下載，由使用者點擊或判定後再啟動
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // 監聽 autoUpdater 事件
  autoUpdater.on('checking-for-update', () => {
    updaterStatus.checking = true
    updaterStatus.error = undefined
    broadcastStatus()
  })

  autoUpdater.on('update-available', (info: ElectronUpdateInfo) => {
    updaterStatus.checking = false
    updaterStatus.updateAvailable = true
    updaterStatus.updateInfo = {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseName: info.releaseName ?? undefined,
      downloadUrl: 'https://github.com/zkylek1212-k/Mulit-Harness-ADE/releases'
    }
    broadcastStatus()

    // 若為安裝版且非手動停用，可自動開始下載更新
    if (updaterStatus.isInstalled && !updaterStatus.isDownloading && !updaterStatus.updateDownloaded) {
      updaterStatus.isDownloading = true
      broadcastStatus()
      autoUpdater.downloadUpdate().catch((err) => {
        console.warn('[Updater] Auto download failed:', err)
        updaterStatus.isDownloading = false
        updaterStatus.error = err instanceof Error ? err.message : String(err)
        broadcastStatus()
      })
    }
  })

  autoUpdater.on('update-not-available', () => {
    updaterStatus.checking = false
    updaterStatus.updateAvailable = false
    updaterStatus.isDownloading = false
    broadcastStatus()
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    updaterStatus.isDownloading = true
    updaterStatus.downloadProgress = {
      percent: Math.round(progress.percent * 10) / 10,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    }
    broadcastStatus()
  })

  autoUpdater.on('update-downloaded', (info: ElectronUpdateInfo) => {
    updaterStatus.checking = false
    updaterStatus.isDownloading = false
    updaterStatus.updateDownloaded = true
    updaterStatus.updateInfo = {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseName: info.releaseName ?? undefined,
      downloadUrl: 'https://github.com/zkylek1212-k/Mulit-Harness-ADE/releases'
    }
    broadcastStatus()
  })

  autoUpdater.on('error', (err: Error) => {
    console.warn('[Updater] autoUpdater error:', err.message)
    updaterStatus.checking = false
    updaterStatus.isDownloading = false
    // 遇到非致命錯誤時標記錯誤訊息
    updaterStatus.error = err.message
    broadcastStatus()
  })

  // IPC Handlers
  ipcMain.handle('updater:getStatus', (): UpdaterStatus => {
    updaterStatus.isInstalled = isInstalledApp()
    return updaterStatus
  })

  ipcMain.handle('updater:check', async (): Promise<UpdaterStatus> => {
    updaterStatus.checking = true
    updaterStatus.error = undefined
    updaterStatus.isInstalled = isInstalledApp()
    broadcastStatus()

    // 1. 若為打包狀態的安裝版，嘗試透過 autoUpdater 檢查
    if (app.isPackaged && updaterStatus.isInstalled) {
      try {
        await autoUpdater.checkForUpdates()
        return updaterStatus
      } catch (err: unknown) {
        console.warn('[Updater] autoUpdater.checkForUpdates failed, falling back to GitHub API:', err)
      }
    }

    // 2. 免安裝版、開發環境或 autoUpdater 失敗時，走 GitHub Releases API 備援查詢
    try {
      const ghRelease = await fetchLatestFromGitHub()
      updaterStatus.checking = false
      if (ghRelease && compareSemver(updaterStatus.currentVersion, ghRelease.version) < 0) {
        updaterStatus.updateAvailable = true
        updaterStatus.updateInfo = ghRelease
      } else {
        updaterStatus.updateAvailable = false
      }
      broadcastStatus()
      return updaterStatus
    } catch (err: unknown) {
      updaterStatus.checking = false
      const msg = err instanceof Error ? err.message : String(err)
      updaterStatus.error = msg
      broadcastStatus()
      return updaterStatus
    }
  })

  ipcMain.handle('updater:download', async (): Promise<boolean> => {
    if (!updaterStatus.isInstalled) {
      // 免安裝版直接引導至 GitHub Release 下載
      await shell.openExternal(updaterStatus.updateInfo?.downloadUrl || 'https://github.com/zkylek1212-k/Mulit-Harness-ADE/releases')
      return true
    }

    try {
      updaterStatus.isDownloading = true
      broadcastStatus()
      await autoUpdater.downloadUpdate()
      return true
    } catch (err: unknown) {
      updaterStatus.isDownloading = false
      const msg = err instanceof Error ? err.message : String(err)
      updaterStatus.error = msg
      broadcastStatus()
      return false
    }
  })

  ipcMain.handle('updater:install', (): void => {
    if (updaterStatus.updateDownloaded) {
      autoUpdater.quitAndInstall()
    }
  })

  ipcMain.handle('updater:openRelease', async (_e, customUrl?: string): Promise<void> => {
    const url = customUrl || updaterStatus.updateInfo?.downloadUrl || 'https://github.com/zkylek1212-k/Mulit-Harness-ADE/releases'
    await shell.openExternal(url)
  })

  // 應用程式啟動 5 秒後自動靜默檢查一次更新
  setTimeout(() => {
    if (app.isPackaged) {
      ipcMain.emit('updater:check')
    }
  }, 5000)
}
