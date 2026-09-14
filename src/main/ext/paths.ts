import { homedir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import type { AgentId } from '../../preload/index'
import { getCustomCliPath } from '../ipc/settings'

// 各家 agent 的設定檔位置。以下路徑為實機探測結果（2026-09），
// 不是猜的；若哪天官方搬家，只需要改這一個檔。
export interface AgentPaths {
  id: AgentId
  label: string
  cli: string
  /** workbench 是否已實作管理 */
  supported: boolean
  pending: boolean
  configHome: string
  skillsDir?: string
  pluginsDir?: string
  /** 全域 MCP 設定檔 */
  mcpConfig?: string
  /** Antigravity 的信任工作區清單 */
  trustSettings?: string
}

const H = homedir()

export const AGENT_PATHS: Record<AgentId, AgentPaths> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    cli: 'claude',
    supported: true,
    pending: false,
    configHome: join(H, '.claude'),
    skillsDir: join(H, '.claude', 'skills'),
    pluginsDir: join(H, '.claude', 'plugins'),
    mcpConfig: join(H, '.claude.json')
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    // 實測：執行檔叫 agy，不是 antigravity
    cli: 'agy',
    supported: true,
    pending: false,
    configHome: join(H, '.gemini', 'config'),
    pluginsDir: join(H, '.gemini', 'config', 'plugins'),
    mcpConfig: join(H, '.gemini', 'config', 'mcp_config.json'),
    trustSettings: join(H, '.gemini', 'antigravity-cli', 'settings.json')
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    cli: 'codex',
    supported: true,
    pending: false,
    configHome: join(H, '.codex'),
    skillsDir: join(H, '.codex', 'skills'),
    pluginsDir: join(H, '.codex', 'plugins'),
    mcpConfig: join(H, '.codex', 'config.toml')
  }
}

/** Antigravity 的 skill 掛在 plugin 底下（plugins/<n>/skills/SKILL.md），沒有獨立 skills 根目錄 */
export function antigravitySkillDir(pluginName: string): string {
  return join(AGENT_PATHS.antigravity.pluginsDir!, pluginName, 'skills')
}

/** 在 PATH 上找執行檔；找不到回 null。Windows 用 where、其餘用 which，若仍未找到則遍歷標準候選安裝路徑。 */
export function findCli(cmd: string): string | null {
  const isWin = process.platform === 'win32'
  try {
    const finder = isWin ? 'where' : 'which'
    const out = execFileSync(finder, [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && existsSync(l))

    if (lines.length > 0) {
      if (!isWin) return lines[0]

      // Windows 平台：必須優先選擇可被 CreateProcess 執行的檔案類型 (.exe, .cmd, .bat, .ps1)
      const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'))
      if (exe) return exe

      const cmdScript = lines.find((l) => l.toLowerCase().endsWith('.cmd'))
      if (cmdScript) return cmdScript

      const bat = lines.find((l) => l.toLowerCase().endsWith('.bat'))
      if (bat) return bat

      const ps1 = lines.find((l) => l.toLowerCase().endsWith('.ps1'))
      if (ps1) return ps1

      for (const l of lines) {
        if (existsSync(`${l}.cmd`)) return `${l}.cmd`
        if (existsSync(`${l}.exe`)) return `${l}.exe`
        if (existsSync(`${l}.bat`)) return `${l}.bat`
        if (existsSync(`${l}.ps1`)) return `${l}.ps1`
      }
      return lines[0]
    }
  } catch {
    /* where 找不到或執行失敗時繼續 fallback 搜尋候選路徑 */
  }

  // Windows 平台候選目錄搜尋（解決 Electron GUI 進程環境 PATH 可能未更新的問題）
  if (isWin) {
    const candidates: string[] = [
      join(H, 'AppData', 'Roaming', 'npm', `${cmd}.cmd`),
      join(H, 'AppData', 'Roaming', 'npm', `${cmd}.exe`),
      join(H, 'AppData', 'Roaming', 'npm', `${cmd}.ps1`),
      join(H, 'AppData', 'Local', cmd, 'bin', `${cmd}.exe`),
      join(H, 'AppData', 'Local', 'Programs', cmd, `${cmd}.exe`),
      join(H, '.local', 'bin', `${cmd}.exe`),
      join(H, '.local', 'bin', `${cmd}.cmd`)
    ]
    if (cmd === 'agy' || cmd === 'antigravity') {
      candidates.unshift(
        join(H, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
        join(H, 'AppData', 'Roaming', 'npm', 'agy.cmd'),
        join(H, '.gemini', 'antigravity-cli', 'bin', 'agy.exe')
      )
    }
    if (cmd === 'claude') {
      candidates.unshift(
        join(H, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        join(H, 'AppData', 'Local', 'Programs', 'Claude', 'claude.exe')
      )
    }
    if (cmd === 'codex') {
      candidates.unshift(
        join(H, 'AppData', 'Roaming', 'npm', 'codex.cmd')
      )
    }
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
  }

  return null
}

/**
 * 尋找特定 Agent 的 CLI 路徑：優先採納使用者自訂設定，否則在 PATH 上搜尋
 */
export function findAgentCli(agent: AgentId): string | null {
  const custom = getCustomCliPath(agent)
  if (custom && existsSync(custom)) {
    return custom
  }
  const defaultCmd = AGENT_PATHS[agent]?.cli || agent
  return findCli(defaultCmd)
}
