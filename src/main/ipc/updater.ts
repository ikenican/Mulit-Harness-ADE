import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { autoUpdater, UpdateInfo as ElectronUpdateInfo, ProgressInfo } from 'electron-updater'
import * as fs from 'fs'
import { join, dirname } from 'path'
import { isProtectedPath } from './settings'
import type { UpdaterStatus, UpdateInfo } from '../../preload/index'

let updaterStatus: UpdaterStatus = {
  currentVersion: app.getVersion() || '0.1.6',
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
  updaterStatus.currentVersion = app.getVersion() || '0.1.4'
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

function formatUpdaterError(msg: string): string {
  if (!msg) return ''
  if (msg.includes('Cannot find latest.yml') || msg.includes('404')) {
    return 'Online update manifest (latest.yml) is not yet published for this release.'
  }
  if (msg.includes('net::ERR_INTERNET_DISCONNECTED') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
    return 'Network connection failed. Please check your internet connection.'
  }
  const firstLine = msg.split('\n')[0]
  return firstLine.length > 120 ? firstLine.slice(0, 120) + '...' : firstLine
}

  autoUpdater.on('error', (err: Error) => {
    console.warn('[Updater] autoUpdater error:', err.message)
    updaterStatus.checking = false
    updaterStatus.isDownloading = false
    updaterStatus.error = formatUpdaterError(err.message)
    broadcastStatus()
  })

  // IPC Handlers
  ipcMain.handle('updater:getStatus', (): UpdaterStatus => {
    updaterStatus.isInstalled = isInstalledApp()
    return updaterStatus
  })

  const performCheck = async (): Promise<UpdaterStatus> => {
    updaterStatus.checking = true
    updaterStatus.error = undefined
    updaterStatus.isInstalled = isInstalledApp()
    broadcastStatus()

    // 1. 若為打包狀態的安裝版，嘗試透過 autoUpdater 檢查
    if (app.isPackaged && updaterStatus.isInstalled) {
      try {
        const checkPromise = autoUpdater.checkForUpdates()
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Update check timed out')), 8000)
        )
        const result = await Promise.race([checkPromise, timeoutPromise])
        if (result) {
          // autoUpdater 成功取得更新資訊
          return updaterStatus
        }
      } catch (err: unknown) {
        console.warn('[Updater] autoUpdater.checkForUpdates failed, falling back to GitHub API:', err)
      }
    }

    // 2. 免安裝版、開發環境或 autoUpdater 失敗（如線上缺少 latest.yml 404）時，走 GitHub Releases API 備援查詢
    try {
      const ghRelease = await fetchLatestFromGitHub()
      updaterStatus.checking = false
      if (ghRelease) {
        // 備援查詢成功，清除 autoUpdater 的 404 報錯
        updaterStatus.error = undefined
        if (compareSemver(updaterStatus.currentVersion, ghRelease.version) < 0) {
          updaterStatus.updateAvailable = true
          updaterStatus.updateInfo = ghRelease
        } else {
          updaterStatus.updateAvailable = false
        }
      } else {
        // 若 GitHub API 也沒查到，且先前已有 error 則保留，否則標記
        if (!updaterStatus.error) {
          updaterStatus.updateAvailable = false
        }
      }
      broadcastStatus()
      return updaterStatus
    } catch (err: unknown) {
      updaterStatus.checking = false
      const msg = err instanceof Error ? err.message : String(err)
      updaterStatus.error = formatUpdaterError(msg)
      broadcastStatus()
      return updaterStatus
    }
  }

  ipcMain.handle('updater:check', performCheck)

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
      // isSilent = true: 採用 /S 靜默安裝，不彈出安裝引導畫面
      // isForceRunAfter = true: 靜默安裝完成後自動重啟程式
      autoUpdater.quitAndInstall(true, true)
    }
  })

  ipcMain.handle('updater:openRelease', async (_e, customUrl?: string): Promise<void> => {
    const url = customUrl || updaterStatus.updateInfo?.downloadUrl || 'https://github.com/zkylek1212-k/Mulit-Harness-ADE/releases'
    await shell.openExternal(url)
  })

  // 應用程式啟動 5 秒後自動靜默檢查一次更新。
  // 不可用 ipcMain.emit('updater:check')：emit 只觸發 ipcMain.on 的 listener，
  // 碰不到 ipcMain.handle 註冊的 invoke handler，等於整段開機自動檢查從未執行過。
  setTimeout(() => {
    if (app.isPackaged) {
      performCheck().catch((e) => console.warn('[Updater] startup check failed:', e))
    }
  }, 5000)
}
