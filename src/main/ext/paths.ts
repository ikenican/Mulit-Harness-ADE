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
    const localAppData = process.env['LOCALAPPDATA'] || join(H, 'AppData', 'Local')
    const appData = process.env['APPDATA'] || join(H, 'AppData', 'Roaming')
    const nvmSymlink = process.env['NVM_SYMLINK']

    const candidates: string[] = [
      // npm global
      join(appData, 'npm', `${cmd}.cmd`),
      join(appData, 'npm', `${cmd}.exe`),
      join(appData, 'npm', `${cmd}.ps1`),
      // pnpm global
      join(localAppData, 'pnpm', `${cmd}.cmd`),
      join(localAppData, 'pnpm', `${cmd}.exe`),
      join(localAppData, 'pnpm', `${cmd}.ps1`),
      // scoop shims
      join(H, 'scoop', 'shims', `${cmd}.exe`),
      join(H, 'scoop', 'shims', `${cmd}.cmd`),
      join(H, 'scoop', 'shims', `${cmd}.ps1`),
      // yarn & winget
      join(localAppData, 'Yarn', 'bin', `${cmd}.cmd`),
      join(localAppData, 'Microsoft', 'WinGet', 'Links', `${cmd}.exe`),
      // Standard local bin & programs
      join(localAppData, cmd, 'bin', `${cmd}.exe`),
      join(localAppData, 'Programs', cmd, `${cmd}.exe`),
      join(H, '.local', 'bin', `${cmd}.exe`),
      join(H, '.local', 'bin', `${cmd}.cmd`),
      // System-wide nodejs
      'C:\\Program Files\\nodejs\\' + `${cmd}.cmd`,
      'C:\\Program Files\\nodejs\\' + `${cmd}.exe`,
      'C:\\Program Files (x86)\\nodejs\\' + `${cmd}.cmd`,
      'C:\\Program Files (x86)\\nodejs\\' + `${cmd}.exe`
    ]

    if (nvmSymlink) {
      candidates.unshift(
        join(nvmSymlink, `${cmd}.cmd`),
        join(nvmSymlink, `${cmd}.exe`)
      )
    }

    if (cmd === 'agy' || cmd === 'antigravity') {
      candidates.unshift(
        join(localAppData, 'agy', 'bin', 'agy.exe'),
        join(appData, 'npm', 'agy.cmd'),
        join(H, '.gemini', 'antigravity-cli', 'bin', 'agy.exe')
      )
    }
    if (cmd === 'claude') {
      candidates.unshift(
        join(H, '.local', 'bin', 'claude.exe'),
        join(appData, 'npm', 'claude.cmd'),
        join(appData, 'npm', 'claude.ps1'),
        join(localAppData, 'Programs', 'Claude', 'claude.exe')
      )
    }
    if (cmd === 'codex') {
      candidates.unshift(
        join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
        join(H, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex.exe'),
        join(appData, 'npm', 'codex.cmd'),
        join(appData, 'npm', 'codex.ps1'),
        join(localAppData, 'pnpm', 'codex.cmd')
      )
    }
    for (const c of candidates) {
      if (c && existsSync(c)) return c
    }
  } else {
    // 非 Windows 平台候補路徑（當 Electron 未繼承終端 shell PATH 時之安全防護）
    const unixCandidates: string[] = [
      join(H, '.local', 'bin', cmd),
      join(H, '.npm-global', 'bin', cmd),
      join('/usr', 'local', 'bin', cmd),
      join('/opt', 'homebrew', 'bin', cmd)
    ]
    for (const u of unixCandidates) {
      if (u && existsSync(u)) return u
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
