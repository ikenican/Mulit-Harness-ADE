// Token 用量：逐檔解析成「每日桶」，再依 all / 30d / 7d / 1d 加總。
// 與 Dashboard 的 session 清單分開——清單只掃最近 N 筆，用量要掃全部歷史才不會每次打開都變。
import { app } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { UsageBucket, UsageRange } from '../../preload/index'
import { add, antigravityDays, claudeDays, codexDays, dayKey, sumDays, type Days } from './usageParse'
type UsageAgent = 'claude' | 'codex' | 'antigravity'

const H = homedir()
const RANGE_DAYS: Record<Exclude<UsageRange, 'all'>, number> = { '30d': 30, '7d': 7, '1d': 1 }

// ── 檔案列舉 ──────────────────────────────────────────────────────────

function listFiles(dir: string, match: (name: string) => boolean, depth: number): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory() && depth > 0) out.push(...listFiles(p, match, depth - 1))
    else if (e.isFile() && match(e.name)) out.push(p)
  }
  return out
}

function usageFiles(): Record<UsageAgent, string[]> {
  const agyTranscripts: string[] = []
  for (const base of ['antigravity-ide', 'antigravity-cli', 'antigravity']) {
    const brain = join(H, '.gemini', base, 'brain')
    let ids: string[] = []
    try {
      ids = fs.readdirSync(brain)
    } catch {
      continue
    }
    for (const id of ids) {
      const t = join(brain, id, '.system_generated', 'logs', 'transcript.jsonl')
      if (fs.existsSync(t)) agyTranscripts.push(t)
    }
  }
  return {
    claude: listFiles(join(H, '.claude', 'projects'), (n) => n.endsWith('.jsonl'), 1),
    codex: listFiles(join(H, '.codex', 'sessions'), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), 4),
    antigravity: agyTranscripts
  }
}

// ── 快取：檔案沒變（mtime+size）就沿用上次的每日桶；存在 userData，與工作區無關 ──

interface CacheEntry {
  mtime: number
  size: number
  days: Days
}
const CACHE_VERSION = 1
let cache: Map<string, CacheEntry> | null = null
let cacheDirty = false

function cachePath(): string {
  return join(app.getPath('userData'), 'usage-cache.json')
}

function loadCache(): Map<string, CacheEntry> {
  if (cache) return cache
  cache = new Map()
  try {
    const data = JSON.parse(fs.readFileSync(cachePath(), 'utf8'))
    if (data?.version === CACHE_VERSION) for (const [k, v] of Object.entries(data.files)) cache.set(k, v as CacheEntry)
  } catch {
    /* 沒有或壞掉就重建 */
  }
  return cache
}

function saveCache(): void {
  if (!cacheDirty || !cache) return
  try {
    fs.writeFileSync(cachePath(), JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(cache) }))
    cacheDirty = false
  } catch {
    /* 忽略 */
  }
}

const PARSERS: Record<UsageAgent, (content: string) => Days> = {
  claude: claudeDays,
  codex: codexDays,
  antigravity: antigravityDays
}

/** 單一檔案的每日桶（有快取）。Dashboard 的 session 卡片也用這個，數字才會與總數一致。 */
export function fileDays(agent: UsageAgent, path: string, content?: string): Days {
  const c = loadCache()
  let st: fs.Stats
  try {
    st = fs.statSync(path)
  } catch {
    return {}
  }
  const hit = c.get(path)
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.days
  let days: Days = {}
  try {
    days = PARSERS[agent](content ?? fs.readFileSync(path, 'utf8'))
  } catch {
    /* 讀不到當 0 */
  }
  c.set(path, { mtime: st.mtimeMs, size: st.size, days })
  cacheDirty = true
  return days
}

export function scanAllUsage(): Record<UsageAgent, Record<UsageRange, UsageBucket>> {
  const today = new Date()
  const since = (n: number): string => dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1)))
  const files = usageFiles()
  const result = {} as Record<UsageAgent, Record<UsageRange, UsageBucket>>
  for (const agent of Object.keys(files) as UsageAgent[]) {
    const merged: Days = {}
    for (const f of files[agent]) {
      for (const [day, b] of Object.entries(fileDays(agent, f))) add(merged, day, b)
    }
    result[agent] = {
      all: sumDays(merged),
      '30d': sumDays(merged, since(RANGE_DAYS['30d'])),
      '7d': sumDays(merged, since(RANGE_DAYS['7d'])),
      '1d': sumDays(merged, since(RANGE_DAYS['1d']))
    }
  }
  saveCache()
  return result
}
