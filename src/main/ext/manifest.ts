import * as fs from 'fs'
import { join, dirname } from 'path'
import * as yaml from 'js-yaml'
import type { ExtManifest } from '../../preload/index'

export const MANIFEST_REL = '.workbench/extensions.yaml'

export const EMPTY_MANIFEST: ExtManifest = { version: 1, skills: [], mcp: [], plugins: [] }

export function manifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, MANIFEST_REL)
}

export function readManifest(workspaceRoot: string): ExtManifest {
  try {
    const raw = fs.readFileSync(manifestPath(workspaceRoot), 'utf8')
    const m = yaml.load(raw) as Partial<ExtManifest> | null
    if (!m) return { ...EMPTY_MANIFEST }
    return {
      version: m.version ?? 1,
      skills: m.skills ?? [],
      mcp: m.mcp ?? [],
      plugins: m.plugins ?? []
    }
  } catch {
    return { ...EMPTY_MANIFEST }
  }
}

export function writeManifest(workspaceRoot: string, m: ExtManifest): void {
  const p = manifestPath(workspaceRoot)
  fs.mkdirSync(dirname(p), { recursive: true })
  fs.writeFileSync(
    p,
    '# Workbench 擴充清單：唯一真相，由 Customized 面板產生各家 agent 的原生設定。\n' +
      '# 憑證不放這裡 —— env 值寫 ${conn:名稱}，實際值存 OS 加密儲存，spawn 時才注入。\n' +
      yaml.dump(m, { lineWidth: 100 }),
    'utf8'
  )
}

/** manifest 裡被管理的項目 key（kind:id），給 inventory 標 managed 用 */
export function managedKeys(m: ExtManifest): Set<string> {
  const s = new Set<string>()
  m.skills.forEach((x) => s.add(`skill:${x.id.toLowerCase()}`))
  m.mcp.forEach((x) => s.add(`mcp:${x.id.toLowerCase()}`))
  m.plugins.forEach((x) => s.add(`plugin:${x.id.toLowerCase()}`))
  return s
}

const CONN_RE = /^\$\{conn:([\w.-]+)\}$/

/** 從 env 值取出 ${conn:x} 的憑證名稱 */
export function connRefsOf(env?: Record<string, string>): string[] {
  if (!env) return []
  return Object.values(env)
    .map((v) => CONN_RE.exec(v)?.[1])
    .filter((x): x is string => !!x)
}

/** 分離「可寫進設定檔的一般 env」與「需在 spawn 注入的憑證 env」 */
export function splitEnv(env?: Record<string, string>): {
  plain: Record<string, string>
  secret: Record<string, string> // envKey -> connName
} {
  const plain: Record<string, string> = {}
  const secret: Record<string, string> = {}
  for (const [k, v] of Object.entries(env || {})) {
    const m = CONN_RE.exec(v)
    if (m) secret[k] = m[1]
    else plain[k] = v
  }
  return { plain, secret }
}
