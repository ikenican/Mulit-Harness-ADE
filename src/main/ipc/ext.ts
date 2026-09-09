import { ipcMain } from 'electron'
import * as fs from 'fs'
import { workspace } from '../index'
import { AGENT_PATHS } from '../ext/paths'
import { buildInventory, buildAgentStatus } from '../ext/inventory'
import { readManifest, writeManifest, managedKeys, connRefsOf } from '../ext/manifest'
import { planSync, applySync } from '../ext/adapters'
import type { AgentStatus, ExtItem, ExtManifest, FileChange } from '../../preload/index'

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
    // 補上憑證需求標記
    for (const it of items) {
      if (it.kind !== 'mcp') continue
      const decl = m.mcp.find((x) => x.id.toLowerCase() === it.id)
      if (decl) it.needsConnection = connRefsOf(decl.env)
    }
    return items
  }

  ipcMain.handle('ext:inventory', async (): Promise<ExtItem[]> => inventory())

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
}
