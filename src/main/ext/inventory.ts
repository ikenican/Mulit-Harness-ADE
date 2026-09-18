import * as fs from 'fs'
import { join } from 'path'
import * as yaml from 'js-yaml'
import { AGENT_PATHS, findCli, findAgentCli } from './paths'
import type {
  AgentId,
  AgentStatus,
  AgentSupport,
  ExtItem,
  ExtKind,
  SupportState
} from '../../preload/index'

const AGENTS: AgentId[] = ['claude', 'antigravity', 'codex']

function readJson<T>(p: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(p, 'utf8').trim()
    if (!raw) return fallback // Antigravity 的 mcp_config.json 初始是 0 bytes
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function listDirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** 解析 SKILL.md 的 YAML frontmatter；Claude 與 Antigravity 用同一種格式 */
function parseSkillMd(file: string): { name?: string; description?: string; version?: string } {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) return {}
    const fm = yaml.load(m[1]) as Record<string, unknown> | null
    if (!fm) return {}
    const meta = fm.metadata as Record<string, unknown> | undefined
    return {
      name: typeof fm.name === 'string' ? fm.name : undefined,
      description: typeof fm.description === 'string' ? fm.description : undefined,
      version: typeof meta?.version === 'string' ? meta.version : undefined
    }
  } catch {
    return {}
  }
}

interface Found {
  kind: ExtKind
  id: string
  name: string
  description?: string
  version?: string
  agent: AgentId
  state: SupportState
  detail?: string
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/[\s_]+/g, '-')

// ── 各家掃描 ────────────────────────────────────────────────────
function scanClaude(workspaceRoot: string): Found[] {
  const P = AGENT_PATHS.claude
  const out: Found[] = []

  // 1. Standalone skills：~/.claude/skills/<n>/SKILL.md
  if (P.skillsDir && fs.existsSync(P.skillsDir)) {
    for (const d of listDirs(P.skillsDir)) {
      const md = join(P.skillsDir, d, 'SKILL.md')
      if (!fs.existsSync(md)) continue
      const fm = parseSkillMd(md)
      out.push({
        kind: 'skill',
        id: norm(fm.name || d),
        name: fm.name || d,
        description: fm.description,
        version: fm.version,
        agent: 'claude',
        state: 'installed',
        detail: md
      })
    }
  }

  // 2. Plugins & Plugin Skills / MCPs:
  // ~/.claude/plugins/installed_plugins.json
  const settingsPath = join(P.configHome, 'settings.json')
  const settings = readJson<{ enabledPlugins?: Record<string, boolean> }>(settingsPath, {})
  const enabledMap = settings.enabledPlugins || {}

  const instPath = join(P.pluginsDir!, 'installed_plugins.json')
  if (fs.existsSync(instPath)) {
    const rawInst = readJson<{ plugins?: Record<string, unknown> } & Record<string, unknown>>(instPath, {})
    const pluginsMap = (rawInst.plugins && typeof rawInst.plugins === 'object' ? rawInst.plugins : rawInst) as Record<string, unknown>

    for (const [pluginKey, installs] of Object.entries(pluginsMap)) {
      if (pluginKey === 'version') continue
      const installList = Array.isArray(installs) ? installs : [installs]
      const firstInstall = installList[0] as { installPath?: string; version?: string } | undefined
      const isEnabled = enabledMap[pluginKey] !== false
      const pluginName = pluginKey.includes('@') ? pluginKey.split('@')[0] : pluginKey
      const marketplace = pluginKey.includes('@') ? pluginKey.split('@')[1] : ''

      out.push({
        kind: 'plugin',
        id: norm(pluginName),
        name: pluginKey,
        description: marketplace ? `marketplace: ${marketplace}${isEnabled ? '' : ' (disabled)'}` : undefined,
        version: firstInstall?.version,
        agent: 'claude',
        state: 'installed',
        detail: firstInstall?.installPath
      })

      // 讀取該 plugin 附帶的 skills: <installPath>/skills/<subskill>/SKILL.md
      if (firstInstall?.installPath && fs.existsSync(firstInstall.installPath)) {
        const pSkillsDir = join(firstInstall.installPath, 'skills')
        if (fs.existsSync(pSkillsDir)) {
          for (const sub of listDirs(pSkillsDir)) {
            const md = join(pSkillsDir, sub, 'SKILL.md')
            if (fs.existsSync(md)) {
              const fm = parseSkillMd(md)
              out.push({
                kind: 'skill',
                id: norm(fm.name || sub),
                name: fm.name || sub,
                description: fm.description || `Provided by plugin ${pluginName}`,
                version: fm.version || firstInstall.version,
                agent: 'claude',
                state: 'installed',
                detail: `plugin: ${pluginKey}`
              })
            }
          }
        }

        // 讀取該 plugin 附帶的 MCP: <installPath>/.mcp.json
        const pMcpPath = join(firstInstall.installPath, '.mcp.json')
        if (fs.existsSync(pMcpPath)) {
          const pMcp = readJson<{ mcpServers?: Record<string, unknown> }>(pMcpPath, {})
          for (const [mcpName, mcpVal] of Object.entries(pMcp.mcpServers || {})) {
            const cfg = mcpVal as { command?: string; url?: string }
            out.push({
              kind: 'mcp',
              id: norm(mcpName),
              name: mcpName,
              description: cfg?.command || cfg?.url || `Plugin MCP: ${pluginName}`,
              agent: 'claude',
              state: 'installed',
              detail: `plugin: ${pluginKey}`
            })
          }
        }
      }
    }
  }

  // 3. MCP：全域 ~/.claude.json 與專案 .mcp.json
  const pushMcp = (servers: Record<string, unknown>, where: string): void => {
    for (const [k, v] of Object.entries(servers || {})) {
      const cfg = v as { command?: string; url?: string }
      out.push({
        kind: 'mcp',
        id: norm(k),
        name: k,
        description: cfg?.command || cfg?.url,
        agent: 'claude',
        state: 'installed',
        detail: where
      })
    }
  }

  const claudeJson = readJson<{
    mcpServers?: Record<string, unknown>
    projects?: Record<string, { mcpServers?: Record<string, unknown> }>
  }>(P.mcpConfig!, {})
  pushMcp(claudeJson.mcpServers || {}, '~/.claude.json (global)')

  const wsKey = workspaceRoot.replace(/\\/g, '/').toLowerCase()
  const wsBasename = workspaceRoot.split(/[\\/]/).pop()?.toLowerCase() || ''
  for (const [proj, cfg] of Object.entries(claudeJson.projects || {})) {
    const pKey = proj.replace(/\\/g, '/').toLowerCase()
    if (pKey === wsKey || (wsBasename && pKey.includes(wsBasename))) {
      pushMcp(cfg.mcpServers || {}, '~/.claude.json (this project)')
    }
  }

  const proj = readJson<{ mcpServers?: Record<string, unknown> }>(
    join(workspaceRoot, '.mcp.json'),
    {}
  )
  pushMcp(proj.mcpServers || {}, '.mcp.json')

  return out
}

function scanAntigravity(workspaceRoot: string): Found[] {
  const P = AGENT_PATHS.antigravity
  const out: Found[] = []

  // 1. 全域插件與其子技能：~/.gemini/config/plugins/<d>
  if (P.pluginsDir && fs.existsSync(P.pluginsDir)) {
    for (const d of listDirs(P.pluginsDir)) {
      const dir = join(P.pluginsDir, d)
      const meta = readJson<{ name?: string; version?: string; description?: string }>(
        join(dir, 'plugin.json'),
        {}
      )
      out.push({
        kind: 'plugin',
        id: norm(meta.name || d),
        name: meta.name || d,
        description: meta.description,
        version: meta.version,
        agent: 'antigravity',
        state: 'installed'
      })

      // Antigravity 的 skill 掛在 plugin 底下（可能為直屬 SKILL.md 或子目錄 <subskill>/SKILL.md）
      const skillsDir = join(dir, 'skills')
      if (fs.existsSync(skillsDir)) {
        const directMd = join(skillsDir, 'SKILL.md')
        if (fs.existsSync(directMd)) {
          const fm = parseSkillMd(directMd)
          out.push({
            kind: 'skill',
            id: norm(fm.name || d),
            name: fm.name || d,
            description: fm.description,
            version: fm.version,
            agent: 'antigravity',
            state: 'installed',
            detail: directMd
          })
        }
        for (const sub of listDirs(skillsDir)) {
          const subMd = join(skillsDir, sub, 'SKILL.md')
          if (fs.existsSync(subMd)) {
            const fm = parseSkillMd(subMd)
            out.push({
              kind: 'skill',
              id: norm(fm.name || sub),
              name: fm.name || sub,
              description: fm.description || `Provided by plugin ${meta.name || d}`,
              version: fm.version || meta.version,
              agent: 'antigravity',
              state: 'installed',
              detail: subMd
            })
          }
        }
      }

      // plugin 也能宣告 mcpServers（gemini-extension.json）
      const ext = readJson<{ mcpServers?: Record<string, { command?: string }> }>(
        join(dir, 'gemini-extension.json'),
        {}
      )
      for (const [k, v] of Object.entries(ext.mcpServers || {})) {
        out.push({
          kind: 'mcp',
          id: norm(k),
          name: k,
          description: v?.command,
          agent: 'antigravity',
          state: 'installed',
          detail: `plugin: ${d}`
        })
      }
    }
  }

  // 2. 全域獨立技能：~/.gemini/config/skills/<subskill>/SKILL.md
  const globalSkillsDir = join(P.configHome, 'skills')
  if (fs.existsSync(globalSkillsDir)) {
    for (const sub of listDirs(globalSkillsDir)) {
      const md = join(globalSkillsDir, sub, 'SKILL.md')
      if (fs.existsSync(md)) {
        const fm = parseSkillMd(md)
        out.push({
          kind: 'skill',
          id: norm(fm.name || sub),
          name: fm.name || sub,
          description: fm.description,
          version: fm.version,
          agent: 'antigravity',
          state: 'installed',
          detail: md
        })
      }
    }
  }

  // 3. 工作區專用技能：<workspace>/.agents/skills/<subskill>/SKILL.md
  if (workspaceRoot) {
    const wsSkillsDir = join(workspaceRoot, '.agents', 'skills')
    if (fs.existsSync(wsSkillsDir)) {
      for (const sub of listDirs(wsSkillsDir)) {
        const md = join(wsSkillsDir, sub, 'SKILL.md')
        if (fs.existsSync(md)) {
          const fm = parseSkillMd(md)
          out.push({
            kind: 'skill',
            id: norm(fm.name || sub),
            name: fm.name || sub,
            description: fm.description,
            version: fm.version,
            agent: 'antigravity',
            state: 'installed',
            detail: md
          })
        }
      }
    }
  }

  // 4. 全域 mcp_config.json
  if (P.mcpConfig && fs.existsSync(P.mcpConfig)) {
    const mcp = readJson<{ mcpServers?: Record<string, { command?: string }> }>(P.mcpConfig, {})
    for (const [k, v] of Object.entries(mcp.mcpServers || {})) {
      out.push({
        kind: 'mcp',
        id: norm(k),
        name: k,
        description: v?.command,
        agent: 'antigravity',
        state: 'installed',
        detail: 'mcp_config.json'
      })
    }
  }

  return out
}

/**
 * 從 TOML 原始文字中擷取指定前綴的表格（如 `mcp_servers` 或 `plugins`），
 * 回傳 { 表格名稱 → 表格內的原始行陣列 }。
 * 只做掃描顯示用途的輕量擷取，不是完整 TOML 解析器：
 * 遇到巢狀子表格（如 `[mcp_servers.x.env]`）視同表格結束，不誤併內容。
 */
function extractTomlTables(raw: string, prefix: string): Map<string, string[]> {
  const tables = new Map<string, string[]>()
  const headerRe = new RegExp(`^\\[${prefix}\\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\\]\\s*$`)
  let current: string | null = null
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    const m = line.match(headerRe)
    if (m) {
      current = m[1] ?? m[2]
      tables.set(current, [])
      continue
    }
    if (/^\[.*\]\s*$/.test(line)) {
      current = null
      continue
    }
    if (current) tables.get(current)!.push(line)
  }
  return tables
}

function tomlString(lines: string[], key: string): string | undefined {
  const re = new RegExp(`^${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
  for (const l of lines) {
    const m = l.match(re)
    if (m) return m[1] ?? m[2]
  }
  return undefined
}

function tomlBool(lines: string[], key: string): boolean | undefined {
  const re = new RegExp(`^${key}\\s*=\\s*(true|false)`)
  for (const l of lines) {
    const m = l.match(re)
    if (m) return m[1] === 'true'
  }
  return undefined
}

function scanCodex(): Found[] {
  const P = AGENT_PATHS.codex
  const out: Found[] = []

  // 1. Skills：~/.codex/skills/<n>/SKILL.md（跳過 .system 等內建套件目錄）
  if (P.skillsDir && fs.existsSync(P.skillsDir)) {
    for (const d of listDirs(P.skillsDir)) {
      if (d.startsWith('.')) continue
      const md = join(P.skillsDir, d, 'SKILL.md')
      if (!fs.existsSync(md)) continue
      const fm = parseSkillMd(md)
      out.push({
        kind: 'skill',
        id: norm(fm.name || d),
        name: fm.name || d,
        description: fm.description,
        version: fm.version,
        agent: 'codex',
        state: 'installed',
        detail: md
      })
    }
  }

  // 2. config.toml：[mcp_servers.*] 與 [plugins."*@*"]
  let raw = ''
  try {
    raw = fs.readFileSync(P.mcpConfig!, 'utf8')
  } catch {
    raw = ''
  }

  if (raw) {
    for (const [name, lines] of extractTomlTables(raw, 'mcp_servers')) {
      out.push({
        kind: 'mcp',
        id: norm(name),
        name,
        description: tomlString(lines, 'command'),
        agent: 'codex',
        state: 'installed',
        detail: 'config.toml'
      })
    }

    for (const [key, lines] of extractTomlTables(raw, 'plugins')) {
      if (tomlBool(lines, 'enabled') === false) continue
      const pluginName = key.includes('@') ? key.split('@')[0] : key
      const marketplace = key.includes('@') ? key.split('@')[1] : ''
      out.push({
        kind: 'plugin',
        id: norm(pluginName),
        name: pluginName,
        description: marketplace ? `marketplace: ${marketplace}` : undefined,
        agent: 'codex',
        state: 'installed',
        detail: 'config.toml'
      })
    }
  }

  return out
}

// ── 對外：合併成跨 agent 的統一清單 ──────────────────────────────
export function buildInventory(workspaceRoot: string, managedIds: Set<string>): ExtItem[] {
  const found = [...scanClaude(workspaceRoot), ...scanAntigravity(workspaceRoot), ...scanCodex()]

  const byKey = new Map<string, ExtItem>()
  for (const f of found) {
    const key = `${f.kind}:${f.id}`
    let item = byKey.get(key)
    if (!item) {
      item = {
        id: f.id,
        kind: f.kind,
        name: f.name,
        description: f.description,
        version: f.version,
        managed: managedIds.has(key),
        agents: []
      }
      byKey.set(key, item)
    }
    if (!item.description && f.description) item.description = f.description
    if (!item.version && f.version) item.version = f.version
    if (!item.agents.some((a) => a.agent === f.agent)) {
      item.agents.push({ agent: f.agent, state: f.state, detail: f.detail })
    }
  }

  // 補齊沒掃到的 agent：該 agent 支援此擴充類型但目前沒裝 → missing
  for (const item of byKey.values()) {
    for (const a of AGENTS) {
      if (item.agents.some((x) => x.agent === a)) continue
      const P = AGENT_PATHS[a]
      const state: SupportState = P.pending ? 'pending' : 'missing'
      const support: AgentSupport = {
        agent: a,
        state,
        detail: P.pending ? 'Not supported yet (Codex is not installed)' : undefined
      }
      item.agents.push(support)
    }
    item.agents.sort((x, y) => AGENTS.indexOf(x.agent) - AGENTS.indexOf(y.agent))
  }

  return [...byKey.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
  )
}

export function buildAgentStatus(workspaceRoot: string, items: ExtItem[]): AgentStatus[] {
  return AGENTS.map((id) => {
    const P = AGENT_PATHS[id]
    const cliPath = findAgentCli(id)
    const notes: string[] = []

    const counts = { skill: 0, mcp: 0, plugin: 0 }
    for (const it of items) {
      if (it.agents.find((a) => a.agent === id)?.state === 'installed') counts[it.kind]++
    }

    if (P.pending) {
      notes.push('Not supported yet: Codex is not installed here, and its config.toml differs from the other two')
    } else {
      if (!cliPath) notes.push(`${P.cli} was not found on PATH`)
      if (!fs.existsSync(P.configHome)) notes.push(`Config directory does not exist: ${P.configHome}`)
    }

    // Antigravity 的信任工作區檢查：沒被信任時 agy 可能無法在此目錄運作
    if (id === 'antigravity' && P.trustSettings && fs.existsSync(P.trustSettings)) {
      const s = readJson<{ trustedWorkspaces?: string[] }>(P.trustSettings, {})
      const list = (s.trustedWorkspaces || []).map((x) => x.replace(/\\/g, '/').toLowerCase())
      const ws = workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!list.some((t) => ws === t || ws.startsWith(t + '/'))) {
        notes.push('This workspace is not in Antigravity\'s trust list')
      }
    }

    if (id === 'antigravity') {
      notes.push('MCP config is global only (no per-project scope) — writing affects every project')
    }

    return {
      agent: id,
      label: P.label,
      cliFound: !!cliPath,
      cliPath: cliPath || undefined,
      configHome: P.configHome,
      supported: P.supported,
      pending: P.pending,
      counts,
      notes
    }
  })
}
