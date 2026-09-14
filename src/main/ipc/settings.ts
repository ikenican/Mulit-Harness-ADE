import { ipcMain } from 'electron'
import * as fs from 'fs'
import { join, dirname } from 'path'
import { execFile, exec } from 'child_process'
import { promisify } from 'util'
import { workspace } from '../index'
import type { AgentId, WorkbenchSettings } from '../../preload/index'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)
const SETTINGS_REL = '.workbench/settings.json'

function settingsPath(): string {
  return join(workspace.root, SETTINGS_REL)
}

export function loadSettings(): WorkbenchSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw)
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
      cliBypassPermissions: parsed.cliBypassPermissions ?? false,
      docToolPaths,
      autoOpenAgentModifiedFiles: parsed.autoOpenAgentModifiedFiles ?? true,
      language: parsed.language === 'en' || parsed.language === 'zh-TW' ? parsed.language : undefined
    }
  } catch {
    return {
      cliPaths: {
        claude: '',
        antigravity: '',
        codex: '',
        powershell: '',
        cmd: ''
      },
      cliEnabled: {
        claude: true,
        antigravity: true,
        codex: true,
        powershell: true,
        cmd: true
      },
      cliBypassPermissions: false,
      docToolPaths: {
        word: '',
        excel: '',
        powerpoint: '',
        pdf: ''
      },
      autoOpenAgentModifiedFiles: true,
      language: undefined
    }
  }
}

export function saveSettings(s: WorkbenchSettings): void {
  const p = settingsPath()
  fs.mkdirSync(dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8')
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
      language: patch.language !== undefined ? patch.language : current.language
    }
    saveSettings(updated)
    return updated
  })

  ipcMain.handle('settings:testCliPath', async (_e, rawPath: string): Promise<{ ok: boolean; version?: string; error?: string }> => {
    const cleanPath = rawPath.trim()
    if (!cleanPath) {
      return { ok: false, error: 'Path cannot be empty' }
    }

    try {
      const isWin = process.platform === 'win32'
      let cmdStr = ''

      if (isWin) {
        let target = cleanPath
        const lower = target.toLowerCase()

        if (lower === 'powershell' || lower.endsWith('powershell.exe')) {
          cmdStr = 'powershell.exe -NoProfile -Command "Write-Output $PSVersionTable.PSVersion.ToString()"'
        } else if (lower === 'cmd' || lower.endsWith('cmd.exe')) {
          cmdStr = 'cmd.exe /c ver'
        } else if (lower === 'pwsh' || lower.endsWith('pwsh.exe')) {
          cmdStr = 'pwsh --version'
        } else {
          if (!lower.endsWith('.exe') && !lower.endsWith('.cmd') && !lower.endsWith('.bat') && !lower.endsWith('.ps1')) {
            if (fs.existsSync(`${target}.cmd`)) target = `${target}.cmd`
            else if (fs.existsSync(`${target}.exe`)) target = `${target}.exe`
            else if (fs.existsSync(`${target}.bat`)) target = `${target}.bat`
            else if (fs.existsSync(`${target}.ps1`)) target = `${target}.ps1`
          }

          if (target.toLowerCase().endsWith('.ps1')) {
            cmdStr = `powershell.exe -ExecutionPolicy Bypass -File "${target}" --version`
          } else {
            cmdStr = `"${target}" --version`
          }
        }
      } else {
        cmdStr = `"${cleanPath}" --version`
      }

      const { stdout, stderr } = await execAsync(cmdStr, {
        timeout: 6000,
        encoding: 'utf8'
      })

      const version = (stdout || stderr || '').trim().split(/\r?\n/)[0]
      return { ok: true, version: version || 'Ready' }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }
  })
}
