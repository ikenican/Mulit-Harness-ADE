import * as fs from 'fs'
import { join, dirname } from 'path'
import { AGENT_PATHS } from './paths'
import { splitEnv } from './manifest'
import type { AgentId, ExtManifest, FileChange } from '../../preload/index'

// 生成各家 agent 的原生設定。同一份 manifest → 多份輸出，
// 沿用 ShareProjectMem 的「單一真相 + 生成各家原生格式」模式。
//
// 合併原則：只擁有自己管理的鍵，絕不整檔覆寫使用者既有設定。

function readText(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

function parseJsonLoose(raw: string): Record<string, unknown> {
  const t = raw.trim()
  if (!t) return {} // Antigravity mcp_config.json 初始是 0 bytes
  try {
    return JSON.parse(t) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** 把 manifest 中指定 target 的 MCP 併進既有 mcpServers，回傳新檔內容 */
function mergeMcpJson(existingRaw: string, manifest: ExtManifest, agent: AgentId): string {
  const doc = parseJsonLoose(existingRaw)
  const servers = { ...((doc.mcpServers as Record<string, unknown>) || {}) }

  // 先移除本 workbench 先前管理、但已從 manifest 移除的項目
  const managedNow = new Set(
    manifest.mcp.filter((m) => m.targets.includes(agent)).map((m) => m.id)
  )
  const prevManaged = Array.isArray(doc.__workbenchManaged)
    ? (doc.__workbenchManaged as string[])
    : []
  for (const id of prevManaged) {
    if (!managedNow.has(id)) delete servers[id]
  }

  for (const m of manifest.mcp) {
    if (!m.targets.includes(agent)) continue
    // 憑證不落檔：${conn:x} 的 env 在 spawn 時才注入
    const { plain } = splitEnv(m.env)
    servers[m.id] = {
      command: m.command,
      args: m.args || [],
      ...(Object.keys(plain).length ? { env: plain } : {})
    }
  }

  doc.mcpServers = servers
  doc.__workbenchManaged = [...managedNow]
  return JSON.stringify(doc, null, 2) + '\n'
}

/** Antigravity 的 skill 必須包在 plugin 目錄裡 */
function antigravityPluginJson(id: string, description: string): string {
  return (
    JSON.stringify(
      {
        name: id,
        version: '0.0.0',
        description,
        author: { name: 'Agent Workbench' }
      },
      null,
      2
    ) + '\n'
  )
}

/**
 * 產生同步計畫。只回傳「內容真的會變」的項目，before/after 直接餵 Monaco DiffEditor。
 * 這一步不寫檔 —— 因為目標多在 ~/ 底下，不受 git 保護，必須先讓使用者看過。
 */
export function planSync(workspaceRoot: string, manifest: ExtManifest): FileChange[] {
  const changes: FileChange[] = []

  // ── MCP：Claude 走專案 .mcp.json（隨 repo 走）
  if (manifest.mcp.some((m) => m.targets.includes('claude'))) {
    const p = join(workspaceRoot, '.mcp.json')
    const before = readText(p)
    const after = mergeMcpJson(before, manifest, 'claude')
    if (before !== after) {
      changes.push({ path: p, agent: 'claude', before, after, note: '專案層級，可隨 repo 一起 commit' })
    }
  }

  // ── MCP：Antigravity 只有全域設定
  if (manifest.mcp.some((m) => m.targets.includes('antigravity'))) {
    const p = AGENT_PATHS.antigravity.mcpConfig!
    const before = readText(p)
    const after = mergeMcpJson(before, manifest, 'antigravity')
    if (before !== after) {
      changes.push({
        path: p,
        agent: 'antigravity',
        before,
        after,
        note: '全域設定，會影響所有專案'
      })
    }
  }

  // ── Skills：同一份 SKILL.md 複製到各家目錄
  for (const s of manifest.skills) {
    const srcMd = join(workspaceRoot, s.path, 'SKILL.md')
    const content = readText(srcMd)
    if (!content) {
      changes.push({
        path: srcMd,
        agent: 'claude',
        before: '',
        after: '',
        note: '⚠ 來源不存在，略過此 skill'
      })
      continue
    }

    if (s.targets.includes('claude')) {
      const p = join(AGENT_PATHS.claude.skillsDir!, s.id, 'SKILL.md')
      const before = readText(p)
      if (before !== content) {
        changes.push({ path: p, agent: 'claude', before, after: content })
      }
    }

    if (s.targets.includes('antigravity')) {
      const dir = join(AGENT_PATHS.antigravity.pluginsDir!, s.id)
      const p = join(dir, 'skills', 'SKILL.md')
      const before = readText(p)
      if (before !== content) {
        changes.push({
          path: p,
          agent: 'antigravity',
          before,
          after: content,
          note: 'Antigravity 的 skill 需包成 plugin，會一併產生 plugin.json'
        })
      }
      const pj = join(dir, 'plugin.json')
      const beforePj = readText(pj)
      const afterPj = antigravityPluginJson(s.id, `Managed by Agent Workbench: ${s.id}`)
      if (!beforePj) {
        changes.push({ path: pj, agent: 'antigravity', before: beforePj, after: afterPj })
      }
    }
  }

  return changes
}

/** 套用計畫：逐檔寫入（含建立父目錄）。回傳實際寫入的路徑。 */
export function applySync(changes: FileChange[]): string[] {
  const written: string[] = []
  for (const c of changes) {
    if (c.note?.startsWith('⚠')) continue // 來源不存在的項目不寫
    fs.mkdirSync(dirname(c.path), { recursive: true })
    fs.writeFileSync(c.path, c.after, 'utf8')
    written.push(c.path)
  }
  return written
}
