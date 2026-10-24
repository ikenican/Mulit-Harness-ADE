import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { workspace, getWorkspaceForEvent } from '../index'
import { isProtectedPath, loadSettings } from './settings'
import { sanitizeCustomAgent, type CustomResourceKind } from '../../shared/customAgent'
import { listCustomFiles, readCustomFile, writeCustomFile } from '../ext/customAgent'
import { AGENT_PATHS } from '../ext/paths'
import { buildInventory, buildAgentStatus } from '../ext/inventory'
import { readManifest, writeManifest, managedKeys, connRefsOf } from '../ext/manifest'
import { planSync, applySync } from '../ext/adapters'
import type { AgentId, AgentStatus, ExtItem, ExtManifest, FileChange } from '../../preload/index'


function getDisabledKeys(wsPath?: string): Set<string> {
  const ws = wsPath || workspace.root
  const keys = new Set<string>()
  try {
    const globalFile = path.join(app.getPath('userData'), 'customized-state.json')
    if (fs.existsSync(globalFile)) {
      const data = JSON.parse(fs.readFileSync(globalFile, 'utf8'))
      for (const k of data.disabled || []) keys.add(k)
    }
  } catch {
    /* ignore */
  }
  if (ws) {
    try {
      const file = path.join(ws, '.workbench', 'customized-state.json')
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        for (const k of data.disabled || []) keys.add(k)
      }
    } catch {
      /* ignore */
    }
  }
  return keys
}

function saveDisabledKeys(keys: Set<string>, wsPath?: string): void {
  const ws = wsPath || workspace.root
  try {
    const globalFile = path.join(app.getPath('userData'), 'customized-state.json')
    fs.mkdirSync(path.dirname(globalFile), { recursive: true })
    fs.writeFileSync(globalFile, JSON.stringify({ disabled: Array.from(keys) }, null, 2), 'utf8')
  } catch (e) {
    console.error('Failed to save global customized state:', e)
  }
  if (ws && !isProtectedPath(ws)) {
    try {
      const dir = path.join(ws, '.workbench')
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'customized-state.json')
      fs.writeFileSync(file, JSON.stringify({ disabled: Array.from(keys) }, null, 2), 'utf8')
    } catch (e) {
      console.error('Failed to save workspace customized state:', e)
    }
  }
}

export function registerExtHandlers(): void {
  const customAgent = () => sanitizeCustomAgent(loadSettings().customAgent)
  ipcMain.handle('ext:customList', (_event, kind: CustomResourceKind) => listCustomFiles(customAgent(), kind))
  ipcMain.handle('ext:customRead', (_event, kind: CustomResourceKind, file: string) => readCustomFile(customAgent(), kind, file))
  ipcMain.handle('ext:customWrite', (_event, kind: CustomResourceKind, file: string, content: string, before: string | null) =>
    writeCustomFile(customAgent(), kind, file, content, before))
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
    // 讀取 Claude native settings.json 內的 enabledPlugins
    let claudeEnabledPlugins: Record<string, boolean> = {}
    try {
      const claudeSettings = path.join(os.homedir(), '.claude', 'settings.json')
      if (fs.existsSync(claudeSettings)) {
        const raw = fs.readFileSync(claudeSettings, 'utf8')
        const cfg = JSON.parse(raw)
        if (cfg.enabledPlugins && typeof cfg.enabledPlugins === 'object') {
          claudeEnabledPlugins = cfg.enabledPlugins
        }
      }
    } catch {
      /* ignore */
    }

    // 補上憑證需求標記與各 agent 獨立啟用狀態
    const disabled = getDisabledKeys(ws)
    for (const it of items) {
      if (it.kind === 'mcp') {
        const decl = m.mcp.find((x) => x.id.toLowerCase() === it.id)
        if (decl) it.needsConnection = connRefsOf(decl.env)
      }

      const idLower = it.id.toLowerCase()

      for (const a of it.agents) {
        if (a.state !== 'installed') {
          a.enabled = false
          continue
        }

        if (a.agent === 'claude') {
          const isExplicitDisabled =
            disabled.has(`claude:${it.kind}:${idLower}`) ||
            (disabled.has(`${it.kind}:${idLower}`) && !disabled.has(`claude:enabled:${it.kind}:${idLower}`))

          if (isExplicitDisabled) {
            a.enabled = false
          } else if (it.kind === 'plugin') {
            const matchKey = Object.keys(claudeEnabledPlugins).find(
              (k) => k === it.id || k.startsWith(`${it.id}@`) || k.split('@')[0].toLowerCase() === idLower
            )
            if (matchKey && claudeEnabledPlugins[matchKey] === false) {
              a.enabled = false
            } else {
              a.enabled = true
            }
          } else if (it.kind === 'skill' || it.kind === 'mcp') {
            if (a.detail && a.detail.startsWith('plugin:')) {
              const pName = a.detail.replace('plugin:', '').trim().split('@')[0].toLowerCase()
              const pMatch = Object.keys(claudeEnabledPlugins).find(
                (k) => k.toLowerCase() === pName || k.split('@')[0].toLowerCase() === pName
              )
              if (pMatch && claudeEnabledPlugins[pMatch] === false) {
                a.enabled = false
              } else {
                a.enabled = true
              }
            } else {
              a.enabled = true
            }
          } else {
            a.enabled = true
          }
        } else if (a.agent === 'antigravity') {
          const isExplicitDisabled =
            disabled.has(`antigravity:${it.kind}:${idLower}`) ||
            (disabled.has(`${it.kind}:${idLower}`) && !disabled.has(`antigravity:enabled:${it.kind}:${idLower}`))
          a.enabled = !isExplicitDisabled
        } else if (a.agent === 'codex') {
          const isExplicitDisabled =
            disabled.has(`codex:${it.kind}:${idLower}`) ||
            (disabled.has(`${it.kind}:${idLower}`) && !disabled.has(`codex:enabled:${it.kind}:${idLower}`))
          a.enabled = !isExplicitDisabled
        }
      }

      const installed = it.agents.filter((a) => a.state === 'installed')
      it.enabled = installed.length > 0 ? installed.some((a) => a.enabled !== false) : false
    }
    return items
  }

  ipcMain.handle('ext:inventory', async (event): Promise<ExtItem[]> => {
    const ws = getWorkspaceForEvent(event)
    return inventory(ws)
  })

  ipcMain.handle(
    'ext:toggleItem',
    async (
      event,
      kind: string,
      id: string,
      enabled: boolean,
      agent?: AgentId
    ): Promise<boolean> => {
      const ws = getWorkspaceForEvent(event)
      const disabled = getDisabledKeys(ws)
      const idLower = id.toLowerCase()

      const toggleForAgent = (targetAgent: AgentId, targetEnabled: boolean): void => {
        const agentKey = `${targetAgent}:${kind}:${idLower}`
        if (targetEnabled) {
          disabled.delete(agentKey)
          disabled.delete(`${kind}:${idLower}`)
        } else {
          disabled.add(agentKey)
        }

        if (targetAgent === 'claude') {
          if (kind === 'plugin') {
            try {
              const claudeSettings = path.join(os.homedir(), '.claude', 'settings.json')
              if (fs.existsSync(claudeSettings)) {
                const raw = fs.readFileSync(claudeSettings, 'utf8')
                const cfg = JSON.parse(raw)
                if (!cfg.enabledPlugins) cfg.enabledPlugins = {}
                cfg.enabledPlugins[id] = targetEnabled
                for (const k of Object.keys(cfg.enabledPlugins)) {
                  if (k === id || k.startsWith(`${id}@`) || k.split('@')[0].toLowerCase() === idLower) {
                    cfg.enabledPlugins[k] = targetEnabled
                  }
                }
                fs.writeFileSync(claudeSettings, JSON.stringify(cfg, null, 2), 'utf8')
              }
            } catch (e) {
              console.warn('[ext:toggleItem] Failed to write claude settings:', e)
            }
          }
        }
      }

      if (agent) {
        toggleForAgent(agent, enabled)
      } else {
        for (const a of ['claude', 'antigravity', 'codex'] as const) {
          toggleForAgent(a, enabled)
        }
        if (enabled) {
          disabled.delete(`${kind}:${idLower}`)
        } else {
          disabled.add(`${kind}:${idLower}`)
        }
      }

      saveDisabledKeys(disabled, ws)
      return true
    }
  )

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

  // 安裝 CLI 不再由 App 在背景啟動隱藏的 PowerShell 執行「下載後直接執行」的指令：防毒軟體會把這種行為
  // 判成惡意程式，使用者也看不到實際在跑什麼。改由畫面在看得見的終端貼上官方安裝指令，由使用者按 Enter。
}

export interface AgentInstallInfo {
  id: 'claude' | 'antigravity' | 'codex'
  name: string
  command: string
  targetPath: string
  /** 執行這個指令的終端：Windows 用 PowerShell（irm | iex），其他平台用 bash */
  shell: 'powershell' | 'bash'
}

/**
 * Windows：先跑官方安裝腳本，抓不到（例如 2026-10 使用者回報 chatgpt.com/codex/install.ps1 回 404）就改用 npm 套件。
 * 整段在看得見的 PowerShell 裡執行，失敗原因與改走 npm 都會印出來。
 */
function psWithNpmFallback(scriptUrl: string, npmPackage: string): string {
  return (
    `try { irm ${scriptUrl} -ErrorAction Stop | iex } ` +
    `catch { Write-Warning "Official installer failed: $($_.Exception.Message) - falling back to: npm install -g ${npmPackage}"; ` +
    `npm install -g ${npmPackage} }`
  )
}

/**
 * Codex（Windows）：官方腳本 → winget（OpenAI 自己發佈的 OpenAI.Codex，不需要 Node）→ npm。
 * 2026-10-24 實測 chatgpt.com/codex/install.ps1、install.sh 與 releases.openai.com/codex 對任何 User-Agent 都回 404，
 * 而 npm 只有裝了 Node 的電腦才有；winget 是 Windows 10/11 內建的。
 */
function psCodexInstall(): string {
  return (
    `try { irm https://chatgpt.com/codex/install.ps1 -ErrorAction Stop | iex } ` +
    `catch { Write-Warning "Official installer failed: $($_.Exception.Message)"; $ok = $false; ` +
    `if (Get-Command winget -ErrorAction SilentlyContinue) { Write-Host "Trying: winget install --id OpenAI.Codex -e"; winget install --id OpenAI.Codex -e --source winget; $ok = $LASTEXITCODE -eq 0 }; ` +
    `if (-not $ok) { if (Get-Command npm -ErrorAction SilentlyContinue) { Write-Host "Trying: npm install -g @openai/codex"; npm install -g @openai/codex } ` +
    `else { Write-Warning "winget and npm are not available. Install Node.js from https://nodejs.org, then run: npm install -g @openai/codex" } } }`
  )
}

/** curl … | sh 在 404 時 sh 收到空輸入、照樣 exit 0；先把腳本抓下來，抓不到或跑失敗才改用 npm */
function shWithNpmFallback(scriptUrl: string, npmPackage: string): string {
  return (
    `script="$(curl -fsSL ${scriptUrl})" && printf '%s\\n' "$script" | sh || ` +
    `{ echo "Official installer failed - falling back to: npm install -g ${npmPackage}"; npm install -g ${npmPackage}; }`
  )
}

export function getAgentInstallInfo(id: 'claude' | 'antigravity' | 'codex'): AgentInstallInfo {
  const isWin = process.platform === 'win32'
  const shell: AgentInstallInfo['shell'] = isWin ? 'powershell' : 'bash'
  const H = os.homedir()
  const localAppData = process.env['LOCALAPPDATA'] || path.join(H, 'AppData', 'Local')

  if (id === 'claude') {
    return {
      id: 'claude',
      name: 'Claude Code',
      shell,
      command: isWin
        ? psWithNpmFallback('https://claude.ai/install.ps1', '@anthropic-ai/claude-code')
        : 'curl -fsSL https://claude.ai/install.sh | bash',
      targetPath: isWin
        ? path.join(H, '.local', 'bin', 'claude.exe')
        : path.join(H, '.local', 'bin', 'claude')
    }
  } else if (id === 'antigravity') {
    return {
      id: 'antigravity',
      name: 'Antigravity (AGY)',
      shell,
      command: isWin
        ? 'irm https://antigravity.google/cli/install.ps1 | iex'
        : 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      targetPath: isWin
        ? path.join(localAppData, 'agy', 'bin', 'agy.exe')
        : path.join(H, '.local', 'bin', 'agy')
    }
  } else {
    return {
      id: 'codex',
      name: 'Codex CLI',
      shell,
      command: isWin
        ? psCodexInstall()
        : shWithNpmFallback('https://chatgpt.com/codex/install.sh', '@openai/codex'),
      // 官方腳本的位置；改走 winget／npm 時會在 WinGet\Links 或 npm 全域目錄，findCli 的候選路徑都有
      targetPath: isWin
        ? path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
        : path.join(H, '.local', 'bin', 'codex')
    }
  }
}
