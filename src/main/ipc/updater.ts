import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { autoUpdater, UpdateInfo as ElectronUpdateInfo, ProgressInfo } from 'electron-updater'
import * as fs from 'fs'
import { join, dirname } from 'path'
import { loadSettings } from './settings'
import type { UpdaterStatus, UpdateInfo, UpstreamStatus } from '../../preload/index'
import { UPSTREAM_REPO, compareVersions, isRepoSlug, isValidVersion, upstreamBaseOf } from '../../shared/version'

/**
 * 這個版本的更新來源。fork 版打包時以 extraMetadata 寫進 package.json：
 * updateRepo = fork 自己（autoUpdater 也指向它），upstreamRepo = 原作者。官方版兩者相同，行為和以前一樣。
 */
function readBuildChannel(): { updateRepo: string; upstreamRepo: string; upstreamBase: string | null } {
  let pkg: Record<string, unknown> = {}
  try {
    pkg = JSON.parse(fs.readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
  } catch {
    /* 開發環境或讀不到：當成官方版 */
  }
  const updateRepo = isRepoSlug(pkg.updateRepo) ? pkg.updateRepo : UPSTREAM_REPO
  const upstreamRepo = isRepoSlug(pkg.upstreamRepo) ? pkg.upstreamRepo : UPSTREAM_REPO
  const declared = typeof pkg.upstreamVersion === 'string' && isValidVersion(pkg.upstreamVersion) ? pkg.upstreamVersion : null
  return { updateRepo, upstreamRepo, upstreamBase: upstreamBaseOf(app.getVersion()) || declared }
}

const channel = readBuildChannel()
const isFork = channel.updateRepo.toLowerCase() !== channel.upstreamRepo.toLowerCase()
const releasesUrl = (repo: string): string => `https://github.com/${repo}/releases`

let updaterStatus: UpdaterStatus = {
  currentVersion: app.getVersion() || '0.1.12',
  isPackaged: app.isPackaged,
  isInstalled: false,
  checking: false,
  updateAvailable: false,
  updateDownloaded: false,
  isDownloading: false,
  channelRepo: channel.updateRepo,
  ...(isFork ? { upstream: { repo: channel.upstreamRepo, baseVersion: channel.upstreamBase || '', newer: false } } : {})
}

/**
 * 判斷當前是否為 NSIS 安裝版（而非免安裝綠色資料夾）
 */
export function isInstalledApp(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'win32') {
    try {
      const exeDir = dirname(app.getPath('exe'))
      // 只認 NSIS 解除安裝程式。不可用 isProtectedPath(exeDir)：它對 exe 目錄本身恆為 true，
      // 會把可攜版誤判成安裝版 → 靜默裝一份到 %LOCALAPPDATA%\Programs，重開舊捷徑又回到舊版。
      return (
        fs.existsSync(join(exeDir, 'Uninstall Agent Workbench.exe')) ||
        fs.existsSync(join(exeDir, 'Uninstall.exe'))
      )
    } catch {
      return false
    }
  }
  return true
}

function broadcastStatus(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('updater:statusChange', updaterStatus)
      }
    } catch {}
  }
}

/**
 * 從 GitHub API 直接查詢某個 repo 的最新 Release（免安裝版、非打包環境、autoUpdater 失敗時的備援，以及原作者版本的提示）。
 * 版本號帶 prerelease 尾碼（fork 版 0.1.41-fork.2）時，releases/latest 不一定是最大的版本，所以列出最近幾筆自己比。
 */
async function fetchLatestFromGitHub(repo: string): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
      headers: { 'User-Agent': 'Agent-Workbench-Updater', Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return null
    const list: any[] = await res.json()
    let best: any = null
    for (const r of Array.isArray(list) ? list : []) {
      const v = String(r?.tag_name || '').replace(/^v/, '')
      if (r?.draft || !isValidVersion(v)) continue
      if (!best || compareVersions(String(best.tag_name).replace(/^v/, ''), v) < 0) best = r
    }
    if (!best) return null
    const version = String(best.tag_name).replace(/^v/, '')
    return {
      version,
      releaseName: best.name || `Version ${version}`,
      releaseNotes: best.body || '',
      releaseDate: best.published_at,
      downloadUrl: best.html_url || releasesUrl(repo)
    }
  } catch (e) {
    console.warn(`[Updater] Failed to fetch releases of ${repo}:`, e)
    return null
  }
}

/** fork 版：查原作者有沒有比這個 fork 所基於的版本更新的 release。只提示，不下載也不安裝 */
async function checkUpstream(): Promise<void> {
  const up = updaterStatus.upstream
  if (!up) return
  const latest = await fetchLatestFromGitHub(up.repo)
  const next: UpstreamStatus = { ...up, checkedAt: Date.now() }
  if (!latest) {
    next.error = 'Could not reach the upstream releases.'
  } else {
    next.error = undefined
    next.latestVersion = latest.version
    next.latestReleaseDate = latest.releaseDate
    next.latestUrl = latest.downloadUrl
    next.newer = !!up.baseVersion && compareVersions(up.baseVersion, latest.version) < 0
  }
  updaterStatus.upstream = next
  broadcastStatus()
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
      downloadUrl: releasesUrl(channel.updateRepo)
    }
    broadcastStatus()
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
      downloadUrl: releasesUrl(channel.updateRepo)
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
    // 原作者版本的提示與自己的更新檢查互不影響；不等它，各自廣播
    if (isFork) void checkUpstream()
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
      const ghRelease = await fetchLatestFromGitHub(channel.updateRepo)
      updaterStatus.checking = false
      if (ghRelease) {
        // 備援查詢成功，清除 autoUpdater 的 404 報錯
        updaterStatus.error = undefined
        if (compareVersions(updaterStatus.currentVersion, ghRelease.version) < 0) {
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
      await shell.openExternal(updaterStatus.updateInfo?.downloadUrl || releasesUrl(channel.updateRepo))
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
    const fallback = releasesUrl(channel.updateRepo)
    const url = customUrl || updaterStatus.updateInfo?.downloadUrl || fallback
    // 只開 http(s)：openExternal 會把 file: 或自訂 scheme 交給作業系統處理
    const ok = /^https?:\/\//i.test(url)
    if (!ok) console.warn('[Updater] refused to open non-http url:', url)
    await shell.openExternal(ok ? url : fallback)
  })

  // 應用程式啟動 5 秒後若使用者開啟 autoCheckUpdates，執行一次靜默檢查（僅提示，絕不自動下載）
  setTimeout(() => {
    if (app.isPackaged) {
      try {
        const settings = loadSettings()
        if (settings.autoCheckUpdates === false) {
          console.log('[Updater] Startup check skipped: autoCheckUpdates is disabled.')
          return
        }
      } catch (err) {
        console.warn('[Updater] Failed to read autoCheckUpdates setting:', err)
      }
      performCheck().catch((e) => console.warn('[Updater] startup check failed:', e))
    }
  }, 5000)
}
