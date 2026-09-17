import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { workspace, getWorkspaceForEvent } from '../index'
import { isProtectedPath } from './settings'
import { AGENT_PATHS } from '../ext/paths'
import { buildInventory, buildAgentStatus } from '../ext/inventory'
import { readManifest, writeManifest, managedKeys, connRefsOf } from '../ext/manifest'
import { planSync, applySync } from '../ext/adapters'
import type { AgentStatus, ExtItem, ExtManifest, FileChange } from '../../preload/index'

const execFileAsync = promisify(execFile)

function getDisabledKeys(wsPath?: string): Set<string> {
  const ws = wsPath || workspace.root
  try {
    const file = path.join(ws, '.workbench', 'customized-state.json')
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return new Set(data.disabled || [])
    }
  } catch {
    /* ignore */
  }
  return new Set()
}

function saveDisabledKeys(keys: Set<string>, wsPath?: string): void {
  const ws = wsPath || workspace.root
  if (!ws || isProtectedPath(ws)) return
  try {
    const dir = path.join(ws, '.workbench')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'customized-state.json')
    fs.writeFileSync(file, JSON.stringify({ disabled: Array.from(keys) }, null, 2), 'utf8')
  } catch (e) {
    console.error('Failed to save customized state:', e)
  }
}

export function registerExtHandlers(): void {
  const inventory = (ws: string): ExtItem[] => {
    const m = readManifest(ws)
    const items = buildInventory(ws, managedKeys(m))
    // 把 manifest 宣告、但尚未在任何 agent 裝起來的項目也列出來（狀態才完整）
    const seen = new Set(items.map((i) => `${i.kind}:${i.id}`))
    for (const mc of m.mcp) {
      const key = `mcp:${mc.id.toLowerCase()}`
      if (seen.has(key)) continue
      items.push({
        id: mc.id.toLowerCase(),
        kind: 'mcp',
        name: mc.id,
        description: mc.command,
        managed: true,
        needsConnection: connRefsOf(mc.env),
        agents: (['claude', 'antigravity', 'codex'] as const).map((a) => ({
          agent: a,
          state: AGENT_PATHS[a].pending
            ? ('pending' as const)
            : mc.targets.includes(a)
              ? ('missing' as const)
              : ('missing' as const),
          detail: AGENT_PATHS[a].pending ? 'Not supported yet (Codex is not installed)' : 'Declared, pending sync'
        }))
      })
    }
    // 補上憑證需求標記與啟用狀態
    const disabled = getDisabledKeys(ws)
    for (const it of items) {
      if (it.kind === 'mcp') {
        const decl = m.mcp.find((x) => x.id.toLowerCase() === it.id)
        if (decl) it.needsConnection = connRefsOf(decl.env)
      }
      it.enabled = !disabled.has(`${it.kind}:${it.id.toLowerCase()}`)
    }
    return items
  }

  ipcMain.handle('ext:inventory', async (event): Promise<ExtItem[]> => {
    const ws = getWorkspaceForEvent(event)
    return inventory(ws)
  })

  ipcMain.handle('ext:toggleItem', async (event, kind: string, id: string, enabled: boolean): Promise<boolean> => {
    const ws = getWorkspaceForEvent(event)
    const disabled = getDisabledKeys(ws)
    const key = `${kind}:${id.toLowerCase()}`
    if (enabled) {
      disabled.delete(key)
    } else {
      disabled.add(key)
    }
    saveDisabledKeys(disabled, ws)

    // 若為 Claude plugin，嘗試同步寫入 ~/.claude/settings.json
    if (kind === 'plugin') {
      try {
        const claudeSettings = path.join(os.homedir(), '.claude', 'settings.json')
        if (fs.existsSync(claudeSettings)) {
          const raw = fs.readFileSync(claudeSettings, 'utf8')
          const cfg = JSON.parse(raw)
          if (!cfg.enabledPlugins) cfg.enabledPlugins = {}
          cfg.enabledPlugins[id] = enabled
          fs.writeFileSync(claudeSettings, JSON.stringify(cfg, null, 2), 'utf8')
        }
      } catch {
        /* ignore */
      }
    }
    return true
  })

  ipcMain.handle('ext:agents', async (event): Promise<AgentStatus[]> => {
    const ws = getWorkspaceForEvent(event)
    return buildAgentStatus(ws, inventory(ws))
  })

  ipcMain.handle('ext:manifest', async (event): Promise<ExtManifest> => {
    const ws = getWorkspaceForEvent(event)
    return readManifest(ws)
  })

  ipcMain.handle('ext:saveManifest', async (event, m: ExtManifest): Promise<void> => {
    const ws = getWorkspaceForEvent(event)
    writeManifest(ws, m)
  })

  ipcMain.handle('ext:planSync', async (event): Promise<FileChange[]> => {
    const ws = getWorkspaceForEvent(event)
    return planSync(ws, readManifest(ws))
  })

  ipcMain.handle('ext:applySync', async (event): Promise<{ written: string[] }> => {
    const ws = getWorkspaceForEvent(event)
    const changes = planSync(ws, readManifest(ws))
    return { written: applySync(changes) }
  })

  // 把目前工作區加進 Antigravity 的信任清單（不靜默執行，由使用者按鈕觸發）
  ipcMain.handle('ext:trustWorkspace', async (event): Promise<boolean> => {
    const p = AGENT_PATHS.antigravity.trustSettings
    if (!p) return false
    let doc: { trustedWorkspaces?: string[] } = {}
    try {
      const raw = fs.readFileSync(p, 'utf8').trim()
      if (raw) doc = JSON.parse(raw)
    } catch {
      /* 檔不存在就建新的 */
    }
    const list = doc.trustedWorkspaces || []
    const ws = getWorkspaceForEvent(event)
    if (!list.some((t) => t.replace(/\\/g, '/').toLowerCase() === ws.replace(/\\/g, '/').toLowerCase())) {
      list.push(ws)
    }
    doc.trustedWorkspaces = list
    fs.writeFileSync(p, JSON.stringify(doc, null, 2), 'utf8')
    return true
  })

  // 取得指定 Agent 的安裝設定與預計安裝路徑
  ipcMain.handle('ext:getAgentInstallInfo', async (_e, id: 'claude' | 'antigravity' | 'codex'): Promise<AgentInstallInfo> => {
    return getAgentInstallInfo(id)
  })

  // 下載並安裝指定 Agent CLI
  ipcMain.handle(
    'ext:installAgent',
    async (
      _e,
      id: 'claude' | 'antigravity' | 'codex'
    ): Promise<{ ok: boolean; message: string; installedPath?: string }> => {
      return runInstallAgent(id)
    }
  )

  // 下載並安裝 Codex CLI（向下相容）
  ipcMain.handle('ext:installCodex', async (): Promise<{ ok: boolean; message: string }> => {
    return runInstallAgent('codex')
  })
}

export interface AgentInstallInfo {
  id: 'claude' | 'antigravity' | 'codex'
  name: string
  command: string
  targetPath: string
}

export function getAgentInstallInfo(id: 'claude' | 'antigravity' | 'codex'): AgentInstallInfo {
  const isWin = process.platform === 'win32'
  const H = os.homedir()
  const localAppData = process.env['LOCALAPPDATA'] || path.join(H, 'AppData', 'Local')
  const appData = process.env['APPDATA'] || path.join(H, 'AppData', 'Roaming')

  if (id === 'claude') {
    return {
      id: 'claude',
      name: 'Claude Code',
      command: isWin ? 'npm install -g @anthropic-ai/claude-code' : 'npm install -g @anthropic-ai/claude-code',
      targetPath: isWin
        ? path.join(appData, 'npm', 'claude.cmd')
        : path.join(H, '.npm-global', 'bin', 'claude')
    }
  } else if (id === 'antigravity') {
    return {
      id: 'antigravity',
      name: 'Antigravity (AGY)',
      command: isWin
        ? 'powershell.exe -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"'
        : 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      targetPath: isWin
        ? path.join(localAppData, 'agy', 'bin', 'agy.exe')
        : path.join(H, '.local', 'bin', 'agy')
    }
  } else {
    return {
      id: 'codex',
      name: 'Codex CLI',
      command: isWin ? 'npm install -g @openai/codex' : 'npm install -g @openai/codex',
      targetPath: isWin
        ? path.join(appData, 'npm', 'codex.cmd')
        : path.join('/usr', 'local', 'bin', 'codex')
    }
  }
}

async function runInstallAgent(
  id: 'claude' | 'antigravity' | 'codex'
): Promise<{ ok: boolean; message: string; installedPath?: string }> {
  const isWin = process.platform === 'win32'
  const info = getAgentInstallInfo(id)

  try {
    if (id === 'claude') {
      const cmd = isWin ? 'npm.cmd' : 'npm'
      await execFileAsync(cmd, ['install', '-g', '@anthropic-ai/claude-code'], {
        timeout: 180000,
        shell: isWin
      })
      return {
        ok: true,
        message: 'Claude Code CLI installed successfully via npm (@anthropic-ai/claude-code)',
        installedPath: info.targetPath
      }
    } else if (id === 'antigravity') {
      if (isWin) {
        await execFileAsync(
          'powershell.exe',
          [
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            'irm https://antigravity.google/cli/install.ps1 | iex'
          ],
          { timeout: 180000 }
        )
      } else {
        await execFileAsync(
          'bash',
          ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'],
          { timeout: 180000 }
        )
      }
      return {
        ok: true,
        message: 'Antigravity CLI (agy) installed successfully',
        installedPath: info.targetPath
      }
    } else {
      // Codex CLI
      try {
        const cmd = isWin ? 'npm.cmd' : 'npm'
        await execFileAsync(cmd, ['install', '-g', '@openai/codex'], {
          timeout: 180000,
          shell: isWin
        })
        return {
          ok: true,
          message: 'Codex CLI installed successfully via npm (@openai/codex)',
          installedPath: info.targetPath
        }
      } catch (err: unknown) {
        if (isWin) {
          await execFileAsync(
            'powershell.exe',
            [
              '-ExecutionPolicy',
              'Bypass',
              '-Command',
              'irm https://chatgpt.com/codex/install.ps1 | iex'
            ],
            { timeout: 180000 }
          )
          return {
            ok: true,
            message: 'Codex CLI installed successfully via PowerShell installer',
            installedPath: info.targetPath
          }
        }
        throw err
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Installation failed: ${msg}` }
  }
}
