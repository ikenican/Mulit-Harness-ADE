import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { workspace } from '../index'
import { isProtectedPath } from './settings'
import { AGENT_PATHS } from '../ext/paths'
import { buildInventory, buildAgentStatus } from '../ext/inventory'
import { readManifest, writeManifest, managedKeys, connRefsOf } from '../ext/manifest'
import { planSync, applySync } from '../ext/adapters'
import type { AgentStatus, ExtItem, ExtManifest, FileChange } from '../../preload/index'

const execFileAsync = promisify(execFile)

function getDisabledKeys(): Set<string> {
  try {
    const file = path.join(workspace.root, '.workbench', 'customized-state.json')
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return new Set(data.disabled || [])
    }
  } catch {
    /* ignore */
  }
  return new Set()
}

function saveDisabledKeys(keys: Set<string>): void {
  if (!workspace.root || isProtectedPath(workspace.root)) return
  try {
    const dir = path.join(workspace.root, '.workbench')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'customized-state.json')
    fs.writeFileSync(file, JSON.stringify({ disabled: Array.from(keys) }, null, 2), 'utf8')
  } catch (e) {
    console.error('Failed to save customized state:', e)
  }
}

export function registerExtHandlers(): void {
  const inventory = (): ExtItem[] => {
    const m = readManifest(workspace.root)
    const items = buildInventory(workspace.root, managedKeys(m))
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
    const disabled = getDisabledKeys()
    for (const it of items) {
      if (it.kind === 'mcp') {
        const decl = m.mcp.find((x) => x.id.toLowerCase() === it.id)
        if (decl) it.needsConnection = connRefsOf(decl.env)
      }
      it.enabled = !disabled.has(`${it.kind}:${it.id.toLowerCase()}`)
    }
    return items
  }

  ipcMain.handle('ext:inventory', async (): Promise<ExtItem[]> => inventory())

  ipcMain.handle('ext:toggleItem', async (_e, kind: string, id: string, enabled: boolean): Promise<boolean> => {
    const disabled = getDisabledKeys()
    const key = `${kind}:${id.toLowerCase()}`
    if (enabled) {
      disabled.delete(key)
    } else {
      disabled.add(key)
    }
    saveDisabledKeys(disabled)

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

  ipcMain.handle('ext:agents', async (): Promise<AgentStatus[]> =>
    buildAgentStatus(workspace.root, inventory())
  )

  ipcMain.handle('ext:manifest', async (): Promise<ExtManifest> => readManifest(workspace.root))

  ipcMain.handle('ext:saveManifest', async (_e, m: ExtManifest): Promise<void> => {
    writeManifest(workspace.root, m)
  })

  ipcMain.handle('ext:planSync', async (): Promise<FileChange[]> =>
    planSync(workspace.root, readManifest(workspace.root))
  )

  ipcMain.handle('ext:applySync', async (): Promise<{ written: string[] }> => {
    const changes = planSync(workspace.root, readManifest(workspace.root))
    return { written: applySync(changes) }
  })

  // 把目前工作區加進 Antigravity 的信任清單（不靜默執行，由使用者按鈕觸發）
  ipcMain.handle('ext:trustWorkspace', async (): Promise<boolean> => {
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
    const ws = workspace.root
    if (!list.some((t) => t.replace(/\\/g, '/').toLowerCase() === ws.replace(/\\/g, '/').toLowerCase())) {
      list.push(ws)
    }
    doc.trustedWorkspaces = list
    fs.writeFileSync(p, JSON.stringify(doc, null, 2), 'utf8')
    return true
  })

  // 下載並安裝 Codex CLI
  ipcMain.handle('ext:installCodex', async (): Promise<{ ok: boolean; message: string }> => {
    const isWin = process.platform === 'win32'
    try {
      const cmd = isWin ? 'npm.cmd' : 'npm'
      await execFileAsync(cmd, ['install', '-g', '@openai/codex'], {
        timeout: 120000,
        shell: isWin
      })
      return { ok: true, message: 'Codex CLI installed successfully via npm (@openai/codex)' }
    } catch (err: unknown) {
      if (isWin) {
        try {
          await execFileAsync('powershell.exe', [
            '-ExecutionPolicy', 'Bypass', '-Command',
            'irm https://chatgpt.com/codex/install.ps1 | iex'
          ], { timeout: 120000 })
          return { ok: true, message: 'Codex CLI installed successfully via PowerShell installer' }
        } catch (err2: unknown) {
          const msg = err2 instanceof Error ? err2.message : String(err2)
          return { ok: false, message: `Installation failed: ${msg}` }
        }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `Installation failed: ${msg}` }
    }
  })
}
