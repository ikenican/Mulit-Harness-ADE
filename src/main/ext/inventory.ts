import * as fs from 'fs'
import { join } from 'path'
import * as yaml from 'js-yaml'
import { AGENT_PATHS, findCli } from './paths'
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

  // skills：~/.claude/skills/<n>/SKILL.md
  for (const d of listDirs(P.skillsDir!)) {
    const md = join(P.skillsDir!, d, 'SKILL.md')
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

  // plugins：~/.claude/plugins/installed_plugins.json
  const inst = readJson<Record<string, unknown>>(
    join(P.pluginsDir!, 'installed_plugins.json'),
    {}
  )
  const collectPlugins = (v: unknown, prefix = ''): void => {
    if (Array.isArray(v)) {
      v.forEach((x) => typeof x === 'string' && out.push(mkPlugin(x, prefix)))
    } else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (Array.isArray(val) || (val && typeof val === 'object')) collectPlugins(val, k)
        else out.push(mkPlugin(k, prefix))
      }
    }
  }
  const mkPlugin = (name: string, marketplace: string): Found => ({
    kind: 'plugin',
    id: norm(name),
    name,
    description: marketplace ? `marketplace: ${marketplace}` : undefined,
    agent: 'claude',
    state: 'installed'
  })
  collectPlugins(inst)

  // MCP：全域 ~/.claude.json 與專案 .mcp.json
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
  // Claude Code 的 MCP 有三處：~/.claude.json 頂層（全域）、
  // 同檔 projects[<工作區>].mcpServers（該專案），以及專案的 .mcp.json。
  const claudeJson = readJson<{
    mcpServers?: Record<string, unknown>
    projects?: Record<string, { mcpServers?: Record<string, unknown> }>
  }>(P.mcpConfig!, {})
  pushMcp(claudeJson.mcpServers || {}, '~/.claude.json（全域）')

  const wsKey = workspaceRoot.replace(/\\/g, '/').toLowerCase()
  for (const [proj, cfg] of Object.entries(claudeJson.projects || {})) {
    if (proj.replace(/\\/g, '/').toLowerCase() !== wsKey) continue
    pushMcp(cfg.mcpServers || {}, '~/.claude.json（本專案）')
  }
  const proj = readJson<{ mcpServers?: Record<string, unknown> }>(
    join(workspaceRoot, '.mcp.json'),
    {}
  )
  pushMcp(proj.mcpServers || {}, '.mcp.json')

  return out
}

function scanAntigravity(): Found[] {
  const P = AGENT_PATHS.antigravity
  const out: Found[] = []

  for (const d of listDirs(P.pluginsDir!)) {
    const dir = join(P.pluginsDir!, d)
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

    // Antigravity 的 skill 掛在 plugin 底下
    const md = join(dir, 'skills', 'SKILL.md')
    if (fs.existsSync(md)) {
      const fm = parseSkillMd(md)
      out.push({
        kind: 'skill',
        id: norm(fm.name || d),
        name: fm.name || d,
        description: fm.description,
        version: fm.version,
        agent: 'antigravity',
        state: 'installed',
        detail: md
      })
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

  // 全域 mcp_config.json（初始為空檔）
  const mcp = readJson<{ mcpServers?: Record<string, { command?: string }> }>(P.mcpConfig!, {})
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

  return out
}

// ── 對外：合併成跨 agent 的統一清單 ──────────────────────────────
export function buildInventory(workspaceRoot: string, managedIds: Set<string>): ExtItem[] {
  const found = [...scanClaude(workspaceRoot), ...scanAntigravity()]

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

  // 補齊沒掃到的 agent：Codex 一律 pending，其餘為 missing
  for (const item of byKey.values()) {
    for (const a of AGENTS) {
      if (item.agents.some((x) => x.agent === a)) continue
      const P = AGENT_PATHS[a]
      const state: SupportState = P.pending ? 'pending' : 'missing'
      const support: AgentSupport = {
        agent: a,
        state,
        detail: P.pending ? '尚未支援（Codex 未安裝）' : undefined
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
    const cliPath = findCli(P.cli)
    const notes: string[] = []

    const counts = { skill: 0, mcp: 0, plugin: 0 }
    for (const it of items) {
      if (it.agents.find((a) => a.agent === id)?.state === 'installed') counts[it.kind]++
    }

    if (P.pending) {
      notes.push('尚未支援：本機未安裝 Codex，且其 config.toml 與另兩家不同構')
    } else {
      if (!cliPath) notes.push(`PATH 上找不到 ${P.cli}`)
      if (!fs.existsSync(P.configHome)) notes.push(`設定目錄不存在：${P.configHome}`)
    }

    // Antigravity 的信任工作區檢查：沒被信任時 agy 可能無法在此目錄運作
    if (id === 'antigravity' && P.trustSettings && fs.existsSync(P.trustSettings)) {
      const s = readJson<{ trustedWorkspaces?: string[] }>(P.trustSettings, {})
      const list = (s.trustedWorkspaces || []).map((x) => x.replace(/\\/g, '/').toLowerCase())
      const ws = workspaceRoot.replace(/\\/g, '/').toLowerCase()
      if (!list.some((t) => ws === t || ws.startsWith(t + '/'))) {
        notes.push('目前工作區不在 Antigravity 的信任清單內')
      }
    }

    if (id === 'antigravity') {
      notes.push('MCP 僅有全域設定（無 per-project），寫入會影響所有專案')
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
