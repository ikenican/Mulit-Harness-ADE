import { homedir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import type { AgentId } from '../../preload/index'

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
    // 本機未安裝，且 config.toml 格式與另兩家不同構 —— 先掛 pending
    supported: false,
    pending: true,
    configHome: join(H, '.codex'),
    mcpConfig: join(H, '.codex', 'config.toml')
  }
}

/** Antigravity 的 skill 掛在 plugin 底下（plugins/<n>/skills/SKILL.md），沒有獨立 skills 根目錄 */
export function antigravitySkillDir(pluginName: string): string {
  return join(AGENT_PATHS.antigravity.pluginsDir!, pluginName, 'skills')
}

/** 在 PATH 上找執行檔；找不到回 null。Windows 用 where、其餘用 which。 */
export function findCli(cmd: string): string | null {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(finder, [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const first = out.split(/\r?\n/).find((l) => l.trim())
    return first && existsSync(first.trim()) ? first.trim() : first?.trim() || null
  } catch {
    return null
  }
}
