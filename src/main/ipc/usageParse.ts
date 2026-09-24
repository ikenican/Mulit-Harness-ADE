// Token 用量的純解析（不依賴 Electron，可用 node 直接跑 scripts/check-usage.mts 驗證）
import type { UsageBucket } from '../../preload/index'

export type Days = Record<string, UsageBucket>

/** 本地時區的 YYYY-MM-DD（1d＝今天、7d＝含今天往回 7 天） */
export function dayKey(ts: string | number | Date): string {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function add(days: Days, day: string, b: Partial<UsageBucket>): void {
  if (!day) return
  const cur = (days[day] ||= { input: 0, cacheRead: 0, output: 0 })
  cur.input += b.input || 0
  cur.cacheRead += b.cacheRead || 0
  cur.output += b.output || 0
}

export function sumDays(days: Days, since = ''): UsageBucket {
  const out: UsageBucket = { input: 0, cacheRead: 0, output: 0 }
  for (const [day, b] of Object.entries(days)) {
    if (day < since) continue
    out.input += b.input
    out.cacheRead += b.cacheRead
    out.output += b.output
  }
  return out
}

function eachJsonLine(content: string, mustInclude: string, fn: (row: any) => void): void {
  for (const line of content.split(/\r?\n/)) {
    // 先用字串篩掉不含用量的行，142MB 的 Claude 紀錄才不用每行 JSON.parse
    if (!line || !line.includes(mustInclude)) continue
    try {
      fn(JSON.parse(line))
    } catch {
      /* 壞行略過 */
    }
  }
}

/**
 * Claude Code：每次 API 呼叫寫一筆 message.usage（真實數字）。
 * 同一個回覆會拆成多行、每行帶同一份 usage → 依 message.id 去重，否則輸出會被重複計算。
 * input = input + cache 寫入；cacheRead 另計（計費約原價一成）。
 */
export function claudeDays(content: string): Days {
  const days: Days = {}
  const seen = new Set<string>()
  eachJsonLine(content, '"usage"', (r) => {
    const u = r.message?.usage
    if (!u) return
    const id = r.message.id || r.uuid
    if (id) {
      if (seen.has(id)) return
      seen.add(id)
    }
    add(days, dayKey(r.timestamp), {
      input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      cacheRead: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0
    })
  })
  return days
}

/**
 * Codex：token_count 事件帶「累計」total_token_usage → 取前後差值，記在事件發生那天。
 * input_tokens 已包含 cached_input_tokens，拆開避免重複。
 */
export function codexDays(content: string): Days {
  const days: Days = {}
  let prev = { input: 0, cached: 0, output: 0 }
  eachJsonLine(content, 'total_token_usage', (r) => {
    const u = r.payload?.info?.total_token_usage
    if (!u) return
    let cur = {
      input: u.input_tokens || 0,
      cached: u.cached_input_tokens || 0,
      output: u.output_tokens || 0
    }
    // resumed/壓縮過的 session 明細歸零、只剩 total_tokens
    if (!cur.input && !cur.output && u.total_tokens) cur = { input: u.total_tokens, cached: 0, output: 0 }
    const dIn = Math.max(0, cur.input - prev.input)
    const dCached = Math.max(0, cur.cached - prev.cached)
    add(days, dayKey(r.timestamp), {
      input: Math.max(0, dIn - dCached),
      cacheRead: dCached,
      output: Math.max(0, cur.output - prev.output)
    })
    prev = cur
  })
  return days
}

/**
 * Antigravity：紀錄檔沒有任何 token 欄位，只能用字數估（約 3.5 字元 ≈ 1 token）。
 * 只估 transcript 看得到的文字；每輪重送的上下文看不到，所以實際用量一定更高（估算值、偏低）。
 */
export function antigravityDays(content: string): Days {
  const days: Days = {}
  const est = (s?: string): number => (s ? Math.ceil(s.length / 3.5) : 0)
  eachJsonLine(content, '"type"', (r) => {
    const day = dayKey(r.created_at)
    if (r.source === 'MODEL' && r.type === 'PLANNER_RESPONSE') {
      add(days, day, { output: est(r.thinking) + est(r.content) })
    } else if (['USER_INPUT', 'RUN_COMMAND', 'VIEW_FILE', 'SYSTEM_MESSAGE'].includes(r.type)) {
      add(days, day, { input: est(r.content) })
    }
  })
  return days
}
