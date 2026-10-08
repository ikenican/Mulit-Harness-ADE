// 這支手機記得的電腦（最多 3 台）與各自的 device token，存在 localStorage。
//
// 切換電腦不換頁：WebSocket 本來就可以跨 origin，所以同一個畫面直接對你選的那台開連線。
// 一次只連一台（一個 RemoteConnection），切換就是換掉連線目標。
//
// 每台電腦的 token 不同（各自配對），所以這裡是一張 url → token 的表。
// token 只留在這支手機，不會跟著任何網址或訊息跑。

export interface SavedHost {
  /** 一律正規化成 `https://host:port/` */
  url: string
  label: string
}

const HOSTS_KEY = 'aw.remote.hosts'
const TOKENS_KEY = 'aw.remote.tokens'
const ACTIVE_KEY = 'aw.remote.active'
/** 0.1.23 以前只有「這台」，token 放在這個鍵 */
const LEGACY_TOKEN_KEY = 'aw.remote.token'
export const MAX_HOSTS = 3
/** 遠端控制的預設 port，使用者只輸入 IP 時補上 */
export const DEFAULT_PORT = 47600

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 私密瀏覽等情況寫不進去，就只在這次生效
  }
}

function normUrl(u: string): string {
  try {
    const x = new URL(u)
    if (x.protocol !== 'https:') return ''
    return `https://${x.host}/`
  } catch {
    return ''
  }
}

/** 使用者可能只輸入 `192.168.1.6`、`192.168.1.6:47600` 或完整網址 */
export function parseHostInput(input: string): string {
  const s = input.trim()
  if (!s) return ''
  const withScheme = /^https?:\/\//i.test(s) ? s.replace(/^http:/i, 'https:') : `https://${s}`
  try {
    const u = new URL(withScheme)
    if (!u.port) u.port = String(DEFAULT_PORT)
    return normUrl(u.href)
  } catch {
    return ''
  }
}

export function currentUrl(): string {
  return `https://${location.host}/`
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function clean(list: unknown): SavedHost[] {
  if (!Array.isArray(list)) return []
  const out: SavedHost[] = []
  for (const item of list) {
    const url = normUrl(String((item as SavedHost)?.url ?? ''))
    if (!url || out.some((h) => h.url === url)) continue
    const raw = String((item as SavedHost)?.label ?? '').trim()
    out.push({ url, label: (raw || hostOf(url)).slice(0, 40) })
    if (out.length === MAX_HOSTS) break
  }
  return out
}

export function loadHosts(): SavedHost[] {
  const list = clean(read<unknown>(HOSTS_KEY, []))
  // 這台電腦永遠在清單裡：App 是它送來的，沒有它就沒有這個畫面
  if (!list.some((h) => h.url === currentUrl()) && list.length < MAX_HOSTS) {
    return [{ url: currentUrl(), label: hostOf(currentUrl()) }, ...list]
  }
  return list
}

export function saveHosts(list: SavedHost[]): SavedHost[] {
  const next = clean(list)
  write(HOSTS_KEY, next)
  return next
}

export function hostsFull(): boolean {
  return loadHosts().length >= MAX_HOSTS
}

/** 加一台或更新名字。滿了而且是新的一台就不動，回傳 null 讓呼叫端知道。 */
export function addHost(url: string, label?: string): SavedHost[] | null {
  const u = normUrl(url)
  if (!u) return null
  const list = loadHosts()
  const hit = list.find((h) => h.url === u)
  if (hit) {
    if (label?.trim()) hit.label = label.trim().slice(0, 40)
    return saveHosts(list)
  }
  if (list.length >= MAX_HOSTS) return null
  return saveHosts([...list, { url: u, label: (label?.trim() || hostOf(u)).slice(0, 40) }])
}

export function renameHost(url: string, label: string): SavedHost[] {
  const u = normUrl(url)
  return saveHosts(loadHosts().map((h) => (h.url === u ? { ...h, label: label.slice(0, 40) } : h)))
}

/** 移除一台電腦：連它的 token 一起忘掉 */
export function removeHost(url: string): SavedHost[] {
  const u = normUrl(url)
  setToken(u, null)
  const next = saveHosts(loadHosts().filter((h) => h.url !== u))
  if (activeUrl() === u) setActiveUrl(next[0]?.url || currentUrl())
  return next
}

// —— token（每台一個） ——

function tokens(): Record<string, string> {
  const map = read<Record<string, string>>(TOKENS_KEY, {})
  // 舊版只有「這台」的 token，第一次讀的時候搬過來
  const legacy = (() => {
    try {
      return localStorage.getItem(LEGACY_TOKEN_KEY)
    } catch {
      return null
    }
  })()
  if (legacy && !map[currentUrl()]) {
    map[currentUrl()] = legacy
    write(TOKENS_KEY, map)
    try {
      localStorage.removeItem(LEGACY_TOKEN_KEY)
    } catch {
      // 清不掉就留著，不影響
    }
  }
  return map
}

export function getToken(url: string): string | null {
  return tokens()[normUrl(url)] ?? null
}

export function setToken(url: string, token: string | null): void {
  const u = normUrl(url)
  if (!u) return
  const map = tokens()
  if (token) map[u] = token
  else delete map[u]
  write(TOKENS_KEY, map)
}

// —— 目前連哪一台 ——

export function activeUrl(): string {
  const saved = normUrl(read<string>(ACTIVE_KEY, ''))
  const list = loadHosts()
  if (saved && list.some((h) => h.url === saved)) return saved
  return currentUrl()
}

export function setActiveUrl(url: string): string {
  const u = normUrl(url) || currentUrl()
  write(ACTIVE_KEY, u)
  return u
}

/** 這台電腦的 http 設定頁：還沒信任它的憑證時，只有這個頁面打得開 */
export function setupUrlFor(url: string): string {
  try {
    const u = new URL(url)
    return `http://${u.hostname}:${Number(u.port || DEFAULT_PORT) + 1}/`
  } catch {
    return ''
  }
}
