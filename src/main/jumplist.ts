import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import {
  getRecentWorkspaces,
  addRecentWorkspace,
  loadSettings,
  isProtectedPath,
  setJumpListUpdater
} from './ipc/settings'
import { getRecentWorkspacesFromDashboard } from './ipc/dashboard'

export interface ParsedCommandLine {
  targetPath?: string
  isNewWindow?: boolean
}

/**
 * 解析 Windows 命令列啟動參數（支援冷啟動與 second-instance）
 */
export function parseCommandLineArgs(
  argv: string[],
  workingDirectory: string = process.cwd()
): ParsedCommandLine {
  let targetPath: string | undefined
  let isNewWindow = false

  for (let i = 1; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw) continue
    const arg = raw.replace(/^["']|["']$/g, '').trim()
    if (!arg) continue

    if (arg === '--new-window') {
      isNewWindow = true
      continue
    }

    if (arg.startsWith('-') || arg.startsWith('--')) {
      continue
    }

    // 在未打包開發環境（electron . / electron-vite）中忽略入口腳本參數
    if (!app.isPackaged) {
      if (
        arg === '.' ||
        arg.endsWith('.js') ||
        arg.endsWith('.ts') ||
        arg.endsWith('.json') ||
        arg.includes('node_modules')
      ) {
        continue
      }
    }

    const candidate = path.isAbsolute(arg)
      ? path.normalize(arg)
      : path.normalize(path.resolve(workingDirectory, arg))

    if (fs.existsSync(candidate) && !isProtectedPath(candidate)) {
      try {
        const stat = fs.statSync(candidate)
        if (stat.isDirectory()) {
          targetPath = candidate
          break
        } else if (stat.isFile()) {
          targetPath = path.dirname(candidate)
          break
        }
      } catch {}
    }
  }

  return { targetPath, isNewWindow }
}

/**
 * 更新 Windows 工作列 Jump List（最近專案資料夾與新視窗任務）
 */
export function updateJumpList(): void {
  if (process.platform !== 'win32') return

  try {
    const s = loadSettings()
    const isZh = s.language === 'zh-TW' || app.getLocale().startsWith('zh')
    const recentCategoryTitle = isZh ? '最近開啟的資料夾' : 'Recent Folders'
    const newWindowText = isZh ? '開啟新視窗' : 'New Window'
    const newWindowDesc = isZh ? '開啟全新的專案視窗' : 'Open a new project window'

    // 取得 Windows 使用者已主動從 JumpList 移除的項目清單（依 Windows API 規範避免重加被拒）
    const removedPaths = new Set<string>()
    try {
      const jumpSettings = app.getJumpListSettings()
      if (jumpSettings && Array.isArray(jumpSettings.removedItems)) {
        for (const item of jumpSettings.removedItems) {
          if (item.path) removedPaths.add(path.normalize(item.path).toLowerCase())
          if (item.description) removedPaths.add(path.normalize(item.description).toLowerCase())
          if (item.args) {
            const m = item.args.match(/["']([^"']+)["']/)
            if (m && m[1]) removedPaths.add(path.normalize(m[1]).toLowerCase())
          }
        }
      }
    } catch (e) {
      console.warn('[JumpList] Failed to query getJumpListSettings:', e)
    }

    // 取得最近工作區清單，若筆數較少則自 Dashboard / Claude 歷史會話中探索補充
    let recentList = getRecentWorkspaces()
    if (recentList.length < 7) {
      const discovered = getRecentWorkspacesFromDashboard()
      const seen = new Set(recentList.map((p) => path.normalize(p).toLowerCase()))
      for (const d of discovered) {
        const key = path.normalize(d).toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          recentList.push(d)
        }
        if (recentList.length >= 10) break
      }
    }

    const validRecent = recentList.filter((dir) => {
      const norm = path.normalize(dir).toLowerCase()
      return !removedPaths.has(norm) && fs.existsSync(dir) && !isProtectedPath(dir)
    })

    const appPath = app.getAppPath()
    const isPackaged = app.isPackaged

    const recentItems: Electron.JumpListItem[] = validRecent.slice(0, 10).map((dir) => {
      const title = path.basename(dir) || dir
      const description = dir.length > 255 ? dir.slice(0, 252) + '...' : dir
      const args = isPackaged ? `"${dir}"` : `"${appPath}" "${dir}"`

      return {
        type: 'task',
        title,
        description,
        program: process.execPath,
        args,
        iconPath: process.execPath,
        iconIndex: 0
      }
    })

    const categories: Electron.JumpListCategory[] = []

    // 1. 最近開啟的資料夾（自訂分類）
    if (recentItems.length > 0) {
      categories.push({
        type: 'custom',
        name: recentCategoryTitle,
        items: recentItems
      })
    }

    // 2. 工作（Tasks：開啟新視窗）
    const newWindowArgs = isPackaged ? '--new-window' : `"${appPath}" --new-window`
    const tasksCategory: Electron.JumpListCategory = {
      type: 'tasks',
      items: [
        {
          type: 'task',
          title: newWindowText,
          description: newWindowDesc,
          program: process.execPath,
          args: newWindowArgs,
          iconPath: process.execPath,
          iconIndex: 0
        }
      ]
    }
    categories.push(tasksCategory)

    const res = app.setJumpList(categories)
    if (res !== 'ok') {
      console.warn(`[JumpList] app.setJumpList returned: ${res}`)
      if (res === 'customCategoryAccessDeniedError') {
        // 使用者在 Windows 隱私權設定關閉了 JumpList 最近項目，降級僅設定 Tasks
        try {
          app.setJumpList([tasksCategory])
        } catch {}
      }
    }
  } catch (err) {
    console.error('[JumpList] Error updating Windows JumpList:', err)
  }
}

/**
 * 初始化 Windows JumpList 機制與掛接設定異動監聽
 */
export function initJumpList(): void {
  if (process.platform !== 'win32') return
  setJumpListUpdater(updateJumpList)
  updateJumpList()
}
