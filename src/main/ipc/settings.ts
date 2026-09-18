import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import { join, dirname, resolve, basename } from 'path'
import { execFile, exec } from 'child_process'
import { promisify } from 'util'
import { workspace } from '../index'
import { findCli } from '../ext/paths'
import type { AgentId, WorkbenchSettings } from '../../preload/index'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)
const SETTINGS_REL = '.workbench/settings.json'

/**
 * 判斷指定路徑是否為系統保護目錄或應用程式安裝目錄（非正常使用者專案工作區）
 */
export function isProtectedPath(targetPath: string): boolean {
  if (!targetPath) return true
  try {
    const norm = resolve(targetPath).toLowerCase()
    if (process.platform === 'win32') {
      const progFiles = (process.env['ProgramFiles'] || 'C:\\Program Files').toLowerCase()
      const progFilesX86 = (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase()
      const winDir = (process.env['SystemRoot'] || 'C:\\Windows').toLowerCase()
      if (
        norm === progFiles ||
        norm.startsWith(progFiles + '\\') ||
        norm === progFilesX86 ||
        norm.startsWith(progFilesX86 + '\\') ||
        norm === winDir ||
        norm.startsWith(winDir + '\\')
      ) {
        return true
      }
    }
    if (app && app.isPackaged) {
      const appDir = dirname(app.getPath('exe')).toLowerCase()
      if (norm === appDir || norm.startsWith(appDir + '\\') || norm.startsWith(appDir + '/')) {
        return true
      }
    }
    return false
  } catch {
    return true
  }
}

/**
 * 使用者全域設定檔路徑（儲存於 Electron userData，保證永久具備寫入權限與跨專案通用）
 */
export function getGlobalSettingsPath(): string {
  try {
    return join(app.getPath('userData'), 'settings.json')
  } catch {
    return join(process.env['APPDATA'] || process.cwd(), 'agent-workbench', 'settings.json')
  }
}

/**
 * 工作區專案特定設定檔路徑（若工作區非系統保護目錄則回傳）
 */
export function getWorkspaceSettingsPath(): string | null {
  try {
    if (!workspace || !workspace.root || isProtectedPath(workspace.root)) {
      return null
    }
    return join(workspace.root, SETTINGS_REL)
  } catch {
    return null
  }
}

export function loadSettings(): WorkbenchSettings {
  let parsedGlobal: any = {}
  try {
    const gp = getGlobalSettingsPath()
    if (fs.existsSync(gp)) {
      const raw = fs.readFileSync(gp, 'utf8')
      parsedGlobal = JSON.parse(raw)
    }
  } catch (err) {
    console.warn('[Settings] Failed to load global settings:', err)
  }

  let parsedWs: any = {}
  try {
    const wp = getWorkspaceSettingsPath()
    if (wp && fs.existsSync(wp)) {
      const raw = fs.readFileSync(wp, 'utf8')
      parsedWs = JSON.parse(raw)
    }
  } catch (err) {
    console.warn('[Settings] Failed to load workspace settings:', err)
  }

  const parsed = {
    ...parsedGlobal,
    ...parsedWs,
    cliPaths: {
      ...(parsedGlobal.cliPaths || {}),
      ...(parsedWs.cliPaths || {})
    },
    cliEnabled: {
      ...(parsedGlobal.cliEnabled || {}),
      ...(parsedWs.cliEnabled || {})
    },
    docToolPaths: {
      ...(parsedGlobal.docToolPaths || {}),
      ...(parsedWs.docToolPaths || {})
    },
    cliTestResults: {
      ...(parsedGlobal.cliTestResults || {}),
      ...(parsedWs.cliTestResults || {})
    },
    docToolTestResults: {
      ...(parsedGlobal.docToolTestResults || {}),
      ...(parsedWs.docToolTestResults || {})
    }
  }

  const isWin = process.platform === 'win32'

  // 檢查自訂路徑：若路徑是絕對路徑但實體檔案不存在（例如換機器後的路徑），自動清空回歸自動偵測
  const sanitizePath = (p: unknown): string => {
    if (!p || typeof p !== 'string') return ''
    const trimmed = p.trim()
    if (!trimmed) return ''
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      let exists = fs.existsSync(trimmed)
      if (!exists && isWin) {
        exists =
          fs.existsSync(`${trimmed}.cmd`) ||
          fs.existsSync(`${trimmed}.exe`) ||
          fs.existsSync(`${trimmed}.bat`) ||
          fs.existsSync(`${trimmed}.ps1`)
      }
      if (!exists) return ''
    }
    return trimmed
  }

  const sanitizeTestResults = (res: unknown): Record<string, any> => {
    if (!res || typeof res !== 'object') return {}
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(res as Record<string, any>)) {
      if (v && typeof v === 'object' && v.ok) {
        const tp = v.testedPath
        if (tp && typeof tp === 'string' && (tp.includes('/') || tp.includes('\\'))) {
          if (!sanitizePath(tp)) continue
        }
        out[k] = v
      }
    }
    return out
  }

  const docToolPaths = {
    word: sanitizePath(parsed.docToolPaths?.word),
    excel: sanitizePath(parsed.docToolPaths?.excel),
    powerpoint: sanitizePath(parsed.docToolPaths?.powerpoint),
    pdf: sanitizePath(parsed.docToolPaths?.pdf),
    ...(parsed.docToolPaths
      ? Object.fromEntries(
          Object.entries(parsed.docToolPaths).map(([k, v]) => [k, sanitizePath(v)])
        )
      : {})
  }

  return {
    cliPaths: {
      claude: sanitizePath(parsed.cliPaths?.claude),
      antigravity: sanitizePath(parsed.cliPaths?.antigravity),
      codex: sanitizePath(parsed.cliPaths?.codex),
      powershell: sanitizePath(parsed.cliPaths?.powershell),
      cmd: sanitizePath(parsed.cliPaths?.cmd),
      ...(parsed.cliPaths
        ? Object.fromEntries(
            Object.entries(parsed.cliPaths).map(([k, v]) => [k, sanitizePath(v)])
          )
        : {})
    },
    cliEnabled: {
      claude: parsed.cliEnabled?.claude ?? true,
      antigravity: parsed.cliEnabled?.antigravity ?? true,
      codex: parsed.cliEnabled?.codex ?? true,
      powershell: parsed.cliEnabled?.powershell ?? true,
      cmd: parsed.cliEnabled?.cmd ?? true,
      ...(parsed.cliEnabled || {})
    },
    cliTestResults: sanitizeTestResults(parsed.cliTestResults),
    docToolTestResults: sanitizeTestResults(parsed.docToolTestResults),
    cliBypassPermissions: parsed.cliBypassPermissions ?? false,
    docToolPaths,
    autoOpenAgentModifiedFiles: parsed.autoOpenAgentModifiedFiles ?? true,
    language: parsed.language === 'en' || parsed.language === 'zh-TW' ? parsed.language : undefined,
    lastWorkspace: typeof parsed.lastWorkspace === 'string' ? parsed.lastWorkspace : undefined,
    recentWorkspaces: Array.isArray(parsed.recentWorkspaces)
      ? parsed.recentWorkspaces
          .filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0 && !isProtectedPath(p))
          .map((p: string) => resolve(p))
      : undefined,
    autoCheckUpdates: parsed.autoCheckUpdates ?? true,
    autoDownloadUpdates: parsed.autoDownloadUpdates ?? false
  }
}

export function saveSettings(s: WorkbenchSettings): void {
  // 1. 永遠優先寫入使用者全域設定 (userData)，保證非管理員權限與跨專案一致性
  try {
    const gp = getGlobalSettingsPath()
    fs.mkdirSync(dirname(gp), { recursive: true })
    fs.writeFileSync(gp, JSON.stringify(s, null, 2), 'utf8')
  } catch (e) {
    console.error('[Settings] Failed to save global settings to userData:', e)
  }

  // 2. 若當前工作區為有效專案目錄（非系統保護區或應用程式安裝目錄），同步寫入 workspace
  try {
    const wp = getWorkspaceSettingsPath()
    if (wp) {
      fs.mkdirSync(dirname(wp), { recursive: true })
      fs.writeFileSync(wp, JSON.stringify(s, null, 2), 'utf8')
    }
  } catch (e) {
    console.warn('[Settings] Failed to sync settings to workspace folder (non-fatal):', e)
  }
}

export function getLastWorkspace(): string | null {
  try {
    const s = loadSettings()
    if (s.lastWorkspace && fs.existsSync(s.lastWorkspace) && !isProtectedPath(s.lastWorkspace)) {
      return s.lastWorkspace
    }
  } catch {}
  return null
}

export function saveLastWorkspace(dir: string): void {
  try {
    if (!dir || isProtectedPath(dir) || !fs.existsSync(dir)) return
    const s = loadSettings()
    saveSettings({ ...s, lastWorkspace: dir })
  } catch (err) {
    console.warn('[Settings] Failed to save lastWorkspace:', err)
  }
}

let jumpListUpdater: (() => void) | null = null

export function setJumpListUpdater(fn: () => void): void {
  jumpListUpdater = fn
}

export function notifyJumpListUpdate(): void {
  if (jumpListUpdater) {
    try {
      jumpListUpdater()
    } catch (e) {
      console.warn('[Settings] Failed to notify jumpListUpdater:', e)
    }
  }
}

/**
 * 取得最近使用過的工作區路徑清單（按最近使用排序，已過濾無效目錄與保護路徑）
 */
export function getRecentWorkspaces(): string[] {
  try {
    const s = loadSettings()
    const list = s.recentWorkspaces || []
    const results: string[] = []
    const seen = new Set<string>()

    for (const dir of list) {
      if (!dir) continue
      const norm = resolve(dir)
      const key = norm.toLowerCase()
      if (!seen.has(key) && fs.existsSync(norm) && !isProtectedPath(norm)) {
        try {
          if (fs.statSync(norm).isDirectory()) {
            seen.add(key)
            results.push(norm)
          }
        } catch {}
      }
    }

    // 若為空，嘗試以 lastWorkspace 作為兜底
    if (s.lastWorkspace && fs.existsSync(s.lastWorkspace) && !isProtectedPath(s.lastWorkspace)) {
      const normLast = resolve(s.lastWorkspace)
      if (!seen.has(normLast.toLowerCase())) {
        try {
          if (fs.statSync(normLast).isDirectory()) {
            results.push(normLast)
          }
        } catch {}
      }
    }

    return results
  } catch {
    return []
  }
}

let onRecentWorkspaceAdded: ((dir: string) => void) | null = null
export function setOnRecentWorkspaceAdded(fn: (dir: string) => void): void {
  onRecentWorkspaceAdded = fn
}

/**
 * 加入或更新最近專案工作區至清單頂端，並自動限制上限為 20 筆
 */
export function addRecentWorkspace(dir: string): void {
  try {
    if (!dir || isProtectedPath(dir) || !fs.existsSync(dir)) return
    const norm = resolve(dir)
    const stat = fs.statSync(norm)
    if (!stat.isDirectory()) return

    const s = loadSettings()
    const existing = (s.recentWorkspaces || []).filter(
      (p) => resolve(p).toLowerCase() !== norm.toLowerCase() && fs.existsSync(p) && !isProtectedPath(p)
    )
    const updated = [norm, ...existing].slice(0, 20)
    saveSettings({ ...s, recentWorkspaces: updated, lastWorkspace: norm })

    // 若該目錄先前曾被使用者刪除或封存，使用者主動再次開啟時自動解除刪除與封存
    if (onRecentWorkspaceAdded) {
      try {
        onRecentWorkspaceAdded(norm)
      } catch {}
    }

    notifyJumpListUpdate()
  } catch (err) {
    console.warn('[Settings] Failed to add recentWorkspace:', err)
  }
}

/**
 * 從最近專案清單移除特定工作區
 */
export function removeRecentWorkspace(dir: string): string[] {
  try {
    const norm = resolve(dir).toLowerCase()
    const s = loadSettings()
    const updated = (s.recentWorkspaces || []).filter(
      (p) => resolve(p).toLowerCase() !== norm
    )
    saveSettings({ ...s, recentWorkspaces: updated })
    notifyJumpListUpdate()
    return updated
  } catch (err) {
    console.warn('[Settings] Failed to remove recentWorkspace:', err)
    return []
  }
}

/**
 * 清空最近專案清單
 */
export function clearRecentWorkspaces(): void {
  try {
    const s = loadSettings()
    saveSettings({ ...s, recentWorkspaces: [] })
    notifyJumpListUpdate()
  } catch (err) {
    console.warn('[Settings] Failed to clear recentWorkspaces:', err)
  }
}

/**
 * 取得指定 Office / PDF 文件的自訂應用程式路徑（若有設定且實體檔案存在）
 */
export function getCustomDocToolPath(tool: 'word' | 'excel' | 'powerpoint' | 'pdf'): string | null {
  const s = loadSettings()
  const custom = s.docToolPaths?.[tool]?.trim()
  if (!custom) return null
  if (fs.existsSync(custom)) return custom
  return null
}

/**
 * 取得指定 CLI / Agent 的自訂路徑（若有設定且實體檔案存在）
 */
export function getCustomCliPath(id: string): string | null {
  const s = loadSettings()
  const custom = s.cliPaths?.[id]?.trim()
  if (!custom) return null

  // 若使用者輸入的是路徑，檢查實體檔案是否存在
  const isWin = process.platform === 'win32'
  if (fs.existsSync(custom)) {
    return custom
  }
  if (isWin) {
    if (fs.existsSync(`${custom}.cmd`)) return `${custom}.cmd`
    if (fs.existsSync(`${custom}.exe`)) return `${custom}.exe`
    if (fs.existsSync(`${custom}.bat`)) return `${custom}.bat`
    if (fs.existsSync(`${custom}.ps1`)) return `${custom}.ps1`
  }

  // 若為純指令名稱（例如 "claude" 或 "powershell"）
  if (!custom.includes('/') && !custom.includes('\\')) {
    return custom
  }

  return null
}

/**
 * 判斷指定 CLI / Agent 是否啟用（未設定則預設為 true）
 */
export function isCliEnabled(id: string): boolean {
  const s = loadSettings()
  return s.cliEnabled?.[id] !== false
}

/**
 * 判斷是否啟用 CLI 啟動權限略過模式 (Bypass Permissions Mode)
 */
export function isCliBypassPermissions(): boolean {
  const s = loadSettings()
  return !!s.cliBypassPermissions
}

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', async (): Promise<WorkbenchSettings> => {
    return loadSettings()
  })

  ipcMain.handle('settings:set', async (_e, patch: Partial<WorkbenchSettings>): Promise<WorkbenchSettings> => {
    const current = loadSettings()
    const updated: WorkbenchSettings = {
      ...current,
      ...patch,
      cliPaths: {
        ...current.cliPaths,
        ...(patch.cliPaths || {})
      },
      cliEnabled: {
        ...current.cliEnabled,
        ...(patch.cliEnabled || {})
      },
      cliBypassPermissions:
        patch.cliBypassPermissions !== undefined
          ? patch.cliBypassPermissions
          : (current.cliBypassPermissions ?? false),
      docToolPaths: {
        ...(current.docToolPaths || {}),
        ...(patch.docToolPaths || {})
      },
      cliTestResults: patch.cliTestResults !== undefined ? patch.cliTestResults : current.cliTestResults,
      docToolTestResults: patch.docToolTestResults !== undefined ? patch.docToolTestResults : current.docToolTestResults,
      language: patch.language !== undefined ? patch.language : current.language,
      lastWorkspace: patch.lastWorkspace !== undefined ? patch.lastWorkspace : current.lastWorkspace,
      recentWorkspaces: patch.recentWorkspaces !== undefined ? patch.recentWorkspaces : current.recentWorkspaces
    }
    saveSettings(updated)
    if (patch.language !== undefined || patch.recentWorkspaces !== undefined) {
      notifyJumpListUpdate()
    }
    return updated
  })

  ipcMain.handle('settings:getRecentWorkspaces', async (): Promise<string[]> => {
    return getRecentWorkspaces()
  })

  ipcMain.handle('settings:removeRecentWorkspace', async (_e, workspacePath: string): Promise<string[]> => {
    return removeRecentWorkspace(workspacePath)
  })

  ipcMain.handle('settings:clearRecentWorkspaces', async (): Promise<boolean> => {
    clearRecentWorkspaces()
    return true
  })

  ipcMain.handle('settings:testCliPath', async (_e, rawPath: string): Promise<{ ok: boolean; version?: string; error?: string; resolvedPath?: string }> => {
    const cleanPath = rawPath.trim()
    if (!cleanPath) {
      return { ok: false, error: 'Path cannot be empty' }
    }

    try {
      const isWin = process.platform === 'win32'
      let target = cleanPath

      // 若為常見桌面 GUI 文件工具，直接進行執行檔有效性檢查，避免執行 --version 導致視窗彈出與超時
      const lower = target.toLowerCase()
      const isDocGui =
        lower.includes('winword') ||
        lower.includes('excel') ||
        lower.includes('powerpnt') ||
        lower.includes('acrobat') ||
        lower.includes('acrord32') ||
        lower.includes('msedge') ||
        lower.includes('sumatrapdf') ||
        lower.includes('wps')

      if (isDocGui && fs.existsSync(target)) {
        const st = fs.statSync(target)
        if (st.isFile() || target.endsWith('.app')) {
          return { ok: true, version: `Ready (${basename(target)})`, resolvedPath: target }
        }
      }

      if (isWin) {
        if (lower === 'powershell' || lower.endsWith('powershell.exe')) {
          const { stdout } = await execAsync(
            'powershell.exe -NoProfile -Command "Write-Output $PSVersionTable.PSVersion.ToString()"',
            { timeout: 6000, encoding: 'utf8' }
          )
          const version = (stdout || '').trim().split(/\r?\n/)[0]
          return { ok: true, version: version || 'Ready', resolvedPath: 'powershell.exe' }
        }
        if (lower === 'cmd' || lower.endsWith('cmd.exe')) {
          const { stdout } = await execAsync('cmd.exe /c ver', { timeout: 6000, encoding: 'utf8' })
          const version = (stdout || '').trim().split(/\r?\n/)[0]
          return { ok: true, version: version || 'Ready', resolvedPath: 'cmd.exe' }
        }
        if (lower === 'pwsh' || lower.endsWith('pwsh.exe')) {
          const { stdout } = await execAsync('pwsh --version', { timeout: 6000, encoding: 'utf8' })
          const version = (stdout || '').trim().split(/\r?\n/)[0]
          return { ok: true, version: version || 'Ready', resolvedPath: 'pwsh' }
        }

        // 若不是絕對路徑且不帶路徑斜線，先透過 findCli 尋找實體路徑（如 'codex', 'agy', 'claude'）
        if (!target.includes('/') && !target.includes('\\')) {
          const found = findCli(target)
          if (found) target = found
        }

        if (!target.toLowerCase().endsWith('.exe') && !target.toLowerCase().endsWith('.cmd') && !target.toLowerCase().endsWith('.bat') && !target.toLowerCase().endsWith('.ps1')) {
          if (fs.existsSync(`${target}.cmd`)) target = `${target}.cmd`
          else if (fs.existsSync(`${target}.exe`)) target = `${target}.exe`
          else if (fs.existsSync(`${target}.bat`)) target = `${target}.bat`
          else if (fs.existsSync(`${target}.ps1`)) target = `${target}.ps1`
        }

        const tLower = target.toLowerCase()
        if (tLower.endsWith('.ps1')) {
          const { stdout, stderr } = await execFileAsync(
            'powershell.exe',
            ['-ExecutionPolicy', 'Bypass', '-File', target, '--version'],
            { timeout: 6000, encoding: 'utf8' }
          )
          const version = (stdout || stderr || '').trim().split(/\r?\n/)[0]
          return { ok: true, version: version || 'Ready', resolvedPath: target }
        }

        if (tLower.endsWith('.cmd') || tLower.endsWith('.bat')) {
          const { stdout, stderr } = await execFileAsync(
            'cmd.exe',
            ['/c', target, '--version'],
            { timeout: 6000, encoding: 'utf8' }
          )
          const version = (stdout || stderr || '').trim().split(/\r?\n/)[0]
          return { ok: true, version: version || 'Ready', resolvedPath: target }
        }

        if (fs.existsSync(target)) {
          const { stdout, stderr } = await execFileAsync(
            target,
            ['--version'],
            { timeout: 6000, encoding: 'utf8' }
          )
          const version = (stdout || stderr || '').trim().split(/\r?\n/)[0]
          return { ok: true, version: version || 'Ready', resolvedPath: target }
        }
      }

      const { stdout, stderr } = await execAsync(`"${target}" --version`, {
        timeout: 6000,
        encoding: 'utf8'
      })

      const version = (stdout || stderr || '').trim().split(/\r?\n/)[0]
      return { ok: true, version: version || 'Ready', resolvedPath: target }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle('settings:testDocToolPath', async (_e, rawPath: string): Promise<{ ok: boolean; version?: string; error?: string }> => {
    const cleanPath = rawPath.trim()
    if (!cleanPath) {
      return { ok: true, version: 'Will use System Default Application' }
    }

    try {
      const isWin = process.platform === 'win32'
      const isMac = process.platform === 'darwin'
      let target = cleanPath

      if (isWin) {
        const lower = target.toLowerCase()
        if (!lower.endsWith('.exe') && !lower.endsWith('.cmd') && !lower.endsWith('.bat')) {
          if (fs.existsSync(`${target}.exe`)) target = `${target}.exe`
          else if (fs.existsSync(`${target}.cmd`)) target = `${target}.cmd`
          else if (fs.existsSync(`${target}.bat`)) target = `${target}.bat`
        }
      }

      if (!fs.existsSync(target)) {
        return { ok: false, error: 'File not found at specified path' }
      }

      const st = fs.statSync(target)
      if (!st.isFile() && !(isMac && target.endsWith('.app'))) {
        return { ok: false, error: 'Specified path is a directory, not an executable application' }
      }

      const baseName = basename(target)
      return { ok: true, version: `Valid executable (${baseName})` }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }
  })
}
