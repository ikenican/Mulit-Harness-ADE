import { homedir } from 'os'
import { join } from 'path'
import { existsSync, promises as fsp } from 'fs'
import { execFile, execFileSync } from 'child_process'
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

const isWin = process.platform === 'win32'

/** where/which 的輸出 → 實際要用的路徑（exists 已過濾掉不存在的行） */
function pickFinderResult(out: string, exists: (p: string) => boolean): string | null {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && exists(l))
  if (lines.length === 0) return null
  if (!isWin) return lines[0]

  // Windows 平台：必須優先選擇可被 CreateProcess 執行的檔案類型 (.exe, .cmd, .bat, .ps1)
  for (const ext of ['.exe', '.cmd', '.bat', '.ps1']) {
    const hit = lines.find((l) => l.toLowerCase().endsWith(ext))
    if (hit) return hit
  }
  for (const l of lines) {
    for (const ext of ['.cmd', '.exe', '.bat', '.ps1']) {
      if (exists(`${l}${ext}`)) return `${l}${ext}`
    }
  }
  return lines[0]
}

/** PATH 找不到時依序檢查的標準安裝位置（解決 Electron GUI 進程環境 PATH 可能未更新的問題） */
function candidatePaths(cmd: string): string[] {
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
    // 記憶同步用：winget 裝的 Git／GitHub CLI 在 App 啟動後才裝好時，App 的 PATH 還沒有它們
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
    if (cmd === 'git') {
      candidates.unshift(join(programFiles, 'Git', 'cmd', 'git.exe'), join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'))
    }
    if (cmd === 'gh') {
      candidates.unshift(join(programFiles, 'GitHub CLI', 'gh.exe'), join(localAppData, 'Programs', 'GitHub CLI', 'gh.exe'))
    }
    return candidates
  }
  // 非 Windows 平台候補路徑（當 Electron 未繼承終端 shell PATH 時之安全防護）
  return [
    join(H, '.local', 'bin', cmd),
    join(H, '.npm-global', 'bin', cmd),
    join('/usr', 'local', 'bin', cmd),
    join('/opt', 'homebrew', 'bin', cmd)
  ]
}

/**
 * 找到的路徑記一份給同步呼叫用（開終端分頁時 resolveCommand 不能等）。只記「找到」：
 * 剛裝好的 CLI 不會被舊的「找不到」擋住；用之前一定再確認檔案還在，最多沿用 5 分鐘。
 * 非同步版本永遠重新查，查完順便更新這份。
 */
const FOUND_TTL_MS = 5 * 60 * 1000
const foundCache = new Map<string, { path: string; at: number }>()

function remember(cmd: string, found: string | null): string | null {
  if (found) foundCache.set(cmd, { path: found, at: Date.now() })
  else foundCache.delete(cmd)
  return found
}

/**
 * 在 PATH 上找執行檔；找不到回 null。Windows 用 where、其餘用 which，若仍未找到則遍歷標準候選安裝路徑。
 * 同步版：會擋住 main process（where 要開一個行程），能用 findCliAsync 就用它。
 */
export function findCli(cmd: string): string | null {
  const hit = foundCache.get(cmd)
  if (hit && Date.now() - hit.at < FOUND_TTL_MS && existsSync(hit.path)) return hit.path
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const found = pickFinderResult(out, existsSync)
    if (found) return remember(cmd, found)
  } catch {
    /* where 找不到或執行失敗時繼續 fallback 搜尋候選路徑 */
  }
  return remember(cmd, candidatePaths(cmd).find((c) => c && existsSync(c)) || null)
}

const exists = (p: string): Promise<boolean> => fsp.access(p).then(() => true, () => false)

/** findCli 的非同步版：結果相同，但 where/which 與檔案檢查都不擋 main process */
export async function findCliAsync(cmd: string): Promise<string | null> {
  const out = await new Promise<string>((resolve) => {
    execFile(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout))
  })
  if (out) {
    // pickFinderResult 要同步的 exists：先把可能用到的路徑一次查好
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const probe = isWin ? lines.flatMap((l) => [l, ...['.cmd', '.exe', '.bat', '.ps1'].map((e) => `${l}${e}`)]) : lines
    const present = new Set((await Promise.all(probe.map(async (p) => ((await exists(p)) ? p : null)))).filter((p): p is string => !!p))
    const found = pickFinderResult(out, (p) => present.has(p))
    if (found) return remember(cmd, found)
  }
  for (const c of candidatePaths(cmd)) {
    if (c && (await exists(c))) return remember(cmd, c)
  }
  return remember(cmd, null)
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

export async function findAgentCliAsync(agent: AgentId): Promise<string | null> {
  const custom = getCustomCliPath(agent)
  if (custom && (await exists(custom))) return custom
  return findCliAsync(AGENT_PATHS[agent]?.cli || agent)
}
