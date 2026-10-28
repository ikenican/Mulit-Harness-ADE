// Dashboard 的 session 掃描（~/.claude、~/.codex、~/.gemini 的紀錄檔）。
// 不依賴 Electron：在 dashboardWorker.ts 的 worker thread 裡跑，main process 不會被大量同步讀檔卡住；
// worker 起不來時 dashboard.ts 也能直接在 main 呼叫（scanDashboard）。
import * as fs from 'fs'
import { join, basename, dirname } from 'path'
import { homedir } from 'os'
import type { AgentSessionInfo, UsageBucket, UsageRange } from '../../preload/index'
import { scanAllUsage, fileDays } from './usage'
import { sumDays } from './usageParse'

const H = homedir()

// userData（快取檔位置）與「已知工作區」都由呼叫端提供：worker 裡拿不到 app 與視窗清單
let dataDir = ''
let knownWorkspaces: () => string[] = () => []

export function setScanContext(ctx: { dataDir?: string; knownWorkspaces?: () => string[] }): void {
  if (ctx.dataDir !== undefined) dataDir = ctx.dataDir
  if (ctx.knownWorkspaces) knownWorkspaces = ctx.knownWorkspaces
}

export function normalizePath(p?: string): string {
  if (!p) return ''
  return p.replace(/\\+/g, '/').replace(/\/+/g, '/').toLowerCase().replace(/\/+$/, '')
}

export function isSameWorkspace(wsPath1?: string, wsName1?: string, wsPath2?: string, wsName2?: string): boolean {
  const norm1 = normalizePath(wsPath1)
  const norm2 = normalizePath(wsPath2)

  // 若雙方均有實體路徑：嚴格比對或結尾包含比對（不區分大小寫與正反斜線）
  if (norm1 && norm2) {
    if (norm1 === norm2) return true
    if (norm1.endsWith('/' + norm2) || norm2.endsWith('/' + norm1)) return true
  }

  // 若其中一方缺少路徑或比對失敗，退回以專案資料夾名稱比對（不分大小寫）
  const n1 = (wsName1 || (norm1 ? basename(norm1) : '')).trim().toLowerCase()
  const n2 = (wsName2 || (norm2 ? basename(norm2) : '')).trim().toLowerCase()
  if (n1 && n2) {
    if (n1 === n2) return true
    if (norm1 && (norm1 === n2 || norm1.endsWith('/' + n2))) return true
    if (norm2 && (norm2 === n1 || norm2.endsWith('/' + n1))) return true
  }

  return false
}

/**
 * 從二進位 blob 或日誌字串中萃取有效工作區路徑
 */
function extractWorkspaceFromBlob(buf: Buffer): { workspace?: string; workspacePath?: string } {
  try {
    const text = buf.toString('utf8')
    const matches = text.match(/([a-zA-Z]:(?:\\\\|\/)[A-Za-z0-9_.\-\\/ ]+)/g)
    if (matches) {
      // 這個 blob 可能是任何內容（agent 讀過的檔案都會進對話紀錄）。
      // 沒有上限的話，一長串路徑字元會被吃成單一 match，下面的 while 就會對一個
      // 幾百 KB 的字串反覆 dirname + existsSync，把 main process 卡住幾十秒。
      for (const m of matches.slice(0, 200)) {
        if (m.length > 260) continue // 超過 Windows 最長路徑，不可能是真路徑
        let clean = m.replace(/\\\\/g, '\\').trim()
        for (let i = 0; i < 40 && clean.length > 3 && !fs.existsSync(clean); i++) {
          clean = dirname(clean)
        }
        if (clean.length > 3 && fs.existsSync(clean) && !clean.toLowerCase().includes('appdata') && !clean.toLowerCase().includes('temp')) {
          return { workspace: basename(clean) || clean, workspacePath: clean }
        }
      }
    }
  } catch {}
  // 查不到就留空：不可回填「聚焦視窗」的工作區，否則會話會被歸到別的視窗專案
  return { workspace: undefined, workspacePath: undefined }
}

/**
 * 從 Antigravity 會話日誌中萃取工作區名稱與真實路徑
 */
export function extractAntigravityWorkspace(logPath: string): { workspace: string; workspacePath?: string } {
  if (!fs.existsSync(logPath)) {
    return { workspace: 'Antigravity Session', workspacePath: undefined }
  }

  try {
    const stat = fs.statSync(logPath)
    const fileSize = stat.size
    const fd = fs.openSync(logPath, 'r')

    // 讀取前置 512KB（涵蓋龐大的 System Prompt 與環境變數）
    const headSize = Math.min(524288, fileSize)
    const headBuf = Buffer.alloc(headSize)
    const headRead = fs.readSync(fd, headBuf, 0, headSize, 0)
    let content = headBuf.toString('utf8', 0, headRead)

    // 若檔案較大，額外讀取尾部 64KB（取得最近執行的 Cwd / Active Document）
    if (fileSize > 524288) {
      const tailSize = Math.min(65536, fileSize - headSize)
      const tailBuf = Buffer.alloc(tailSize)
      const tailRead = fs.readSync(fd, tailBuf, 0, tailSize, fileSize - tailSize)
      content += '\n' + tailBuf.toString('utf8', 0, tailRead)
    }
    fs.closeSync(fd)

    // 1. 優先從日誌本身明確記錄的工作區中萃取
    // 匹配 [URI] -> [CorpusName] 格式 或 Workspace URI
    const uriMatch = content.match(/([a-zA-Z]:[^\r\n"'>]+?)\s*->\s*[^\r\n]+/)
    if (uriMatch && uriMatch[1]) {
      const target = uriMatch[1].replace(/\\\\/g, '\\').trim()
      if (target.length > 3 && fs.existsSync(target)) {
        return { workspace: basename(target) || target, workspacePath: target }
      }
    }

    // 匹配 Cwd (工具調用參數，排除引號與跳脫字元)
    const cwdMatch = content.match(/"[Cc]wd"\s*:\s*(?:"\\?"|")([^"\r\n]+?)(?:\\?"|")/)
    if (cwdMatch && cwdMatch[1]) {
      const target = cwdMatch[1].replace(/^[\\"]+|[\\"]+$/g, '').replace(/\\\\/g, '\\').trim()
      if (target.length > 3 && fs.existsSync(target)) {
        return { workspace: basename(target) || target, workspacePath: target }
      }
    }

    // 匹配 Active Document: <path>
    const docMatch = content.match(/(?:Active Document|Other open documents: -)\s*[:\-]?\s*([A-Za-z]:[^\r\n"()]+)/)
    if (docMatch && docMatch[1]) {
      let docDir = dirname(docMatch[1].replace(/\\\\/g, '\\').trim())
      while (docDir.length > 3 && !fs.existsSync(docDir)) {
        docDir = dirname(docDir)
      }
      if (docDir.length > 3 && fs.existsSync(docDir)) {
        return { workspace: basename(docDir) || docDir, workspacePath: docDir }
      }
    }

    // 2. 兜底：日誌內容包含某個已知工作區（最近開啟＋各開啟中視窗）的路徑，就歸到該工作區。
    //    不再只看聚焦視窗，也不再無條件回填聚焦視窗（多視窗時會把會話歸錯專案）。
    const normContent = content.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase()
    const known = [...knownWorkspaces()]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length) // 最長者優先，避免父目錄搶走子專案
    for (const ws of known) {
      if (normContent.includes(normalizePath(ws))) {
        return { workspace: basename(ws), workspacePath: ws }
      }
    }
  } catch {
    // ignore
  }

  return { workspace: 'Antigravity Workspace', workspacePath: undefined }
}

/**
 * 將目錄名稱轉換為 Claude 編碼格式，用於反解比對
 */
export function normalizeForClaude(str: string): string {
  // Claude Code 在 ~/.claude/projects/ 將各個非英數字元（如空白、連字號、底線）逐一轉成 '-'
  // 例如 'Claude Agent - Personal' -> 'Claude-Agent---Personal'（保留連字號前後各別的 dash）
  return str.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * 從 Claude 專案日誌或目錄名稱中萃取工作區名稱與真實路徑
 */
export function extractClaudeWorkspace(dirName: string, jsonlCwd?: string): { workspace: string; workspacePath?: string } {
  if (jsonlCwd && jsonlCwd.trim()) {
    const cleanCwd = jsonlCwd.trim()
    if (fs.existsSync(cleanCwd)) {
      return { workspace: basename(cleanCwd) || cleanCwd, workspacePath: cleanCwd }
    }
  }

  // Claude 專案目錄格式如：D--OneDrive-AI-workspace-...
  // 嘗試反解目錄名為真實磁碟路徑
  if (dirName.match(/^[A-Za-z]--/)) {
    const drive = dirName.charAt(0).toUpperCase() + ':\\'
    let rest = dirName.slice(3)

    // 策略 1：從磁碟機根目錄遍歷對應子目錄層級（精確比對連字號、空格、Junction / Symlink）
    let currentPath = drive
    while (rest.length > 0) {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true })
          .filter((e) => e.isDirectory() || e.isSymbolicLink())
      } catch {
        break
      }

      entries.sort((a, b) => b.name.length - a.name.length)

      let matchedEntry: string | null = null
      let matchedLen = 0

      for (const entry of entries) {
        const norm = normalizeForClaude(entry.name)
        if (rest.toLowerCase() === norm.toLowerCase()) {
          matchedEntry = entry.name
          matchedLen = rest.length
          break
        }
        if (rest.toLowerCase().startsWith(norm.toLowerCase() + '-')) {
          if (norm.length > matchedLen) {
            matchedEntry = entry.name
            matchedLen = norm.length + 1
          }
        }
      }

      if (matchedEntry) {
        currentPath = join(currentPath, matchedEntry)
        rest = rest.slice(matchedLen)
      } else {
        break
      }
    }

    // 只有在 rest 完全匹配無剩餘時，currentPath 才是真正的專案工作區路徑（絕不可回傳半途的父目錄）
    if (rest.length === 0 && fs.existsSync(currentPath)) {
      return { workspace: basename(currentPath) || currentPath, workspacePath: currentPath }
    }

    // 策略 2：'--' 代表目錄分隔符，完整保留原字元
    const pathDirect = drive + dirName.slice(3).split('--').join('\\')
    if (fs.existsSync(pathDirect)) {
      return { workspace: basename(pathDirect) || pathDirect, workspacePath: pathDirect }
    }

    // 策略 3：'---' 常代表 ' - '
    const pathWithDashSpace = drive + dirName.slice(3).replace(/---/g, ' - ').split('--').join('\\')
    if (fs.existsSync(pathWithDashSpace)) {
      return { workspace: basename(pathWithDashSpace) || pathWithDashSpace, workspacePath: pathWithDashSpace }
    }
  }

  const parts = dirName.split('--')
  const lastPart = parts[parts.length - 1] || dirName
  const cleanName = lastPart.replace(/^.*?-([A-Za-z0-9_\-\s]+)$/, '$1').replace(/-/g, ' ') || lastPart

  return { workspace: cleanName || dirName, workspacePath: undefined }
}

interface CachedSessionEntry {
  mtime: number
  session: AgentSessionInfo
}

interface DashboardCacheStore {
  version: 3
  sessions: Record<string, CachedSessionEntry>
}

let memCache: Map<string, CachedSessionEntry> | null = null
let cacheDirty = false

export function invalidateSessionCache(): void {
  memCache = null
}

// 快取內容與工作區無關（掃的是 ~/.claude 等全域目錄），放 userData 一份，與 usage-cache.json 同處。
// 舊版放在「聚焦視窗」工作區的 .workbench/ 下，多視窗時會互相覆寫、讀到別的專案的快取。
function cacheFilePath(): string {
  return join(dataDir, 'dashboard-cache.json')
}

/** 目前快取裡所有 session（不分 agent、不只最近 N 筆）；快取剛被清掉就回 null */
export function cachedSessions(): AgentSessionInfo[] | null {
  return memCache ? [...memCache.values()].map((e) => e.session) : null
}

export function loadDashboardCache(): Map<string, CachedSessionEntry> {
  if (memCache) return memCache
  memCache = new Map()
  try {
    const p = cacheFilePath()
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8')) as DashboardCacheStore
      if (data && data.version === 3 && typeof data.sessions === 'object') {
        for (const [k, v] of Object.entries(data.sessions)) {
          if (v && typeof v.mtime === 'number' && v.session) {
            memCache.set(k, v)
          }
        }
      }
    }
  } catch {
    // ignore corrupted cache
  }
  return memCache
}

function saveDashboardCache(): void {
  if (!cacheDirty || !memCache) return
  try {
    const sessionsObj: Record<string, CachedSessionEntry> = {}
    for (const [k, v] of memCache.entries()) {
      sessionsObj[k] = v
    }
    const store: DashboardCacheStore = {
      version: 3,
      sessions: sessionsObj
    }
    fs.writeFileSync(cacheFilePath(), JSON.stringify(store), 'utf8')
    cacheDirty = false
  } catch {
    // ignore
  }
}


/**
 * 完整探測 Antigravity 會話各項活動日誌與狀態檔案的最新修改時間。
 * 包含：transcript.jsonl / transcript_full.jsonl、conversations/*.db 及 SQLite WAL 檔（執行中持續寫入）、
 * presence/*.lock、以及 .system_generated/tasks 與 messages。
 */
function getAntigravitySessionMaxMtime(brainPath: string, sessionId: string, brainDir: string): number {
  let maxMtime = 0

  // 1. 日誌檔 transcript.jsonl & transcript_full.jsonl
  const logsDir = join(brainPath, '.system_generated', 'logs')
  for (const logFile of ['transcript.jsonl', 'transcript_full.jsonl']) {
    try {
      const p = join(logsDir, logFile)
      if (fs.existsSync(p)) {
        const m = fs.statSync(p).mtimeMs
        if (m > maxMtime) maxMtime = m
      }
    } catch {}
  }

  // 2. conversations/<id>.db 與 .db-wal（SQLite WAL 模式在工作時不斷推進）
  const geminiRoot = dirname(brainDir)
  const convDir = join(geminiRoot, 'conversations')
  for (const f of [`${sessionId}.db`, `${sessionId}.db-wal`]) {
    try {
      const p = join(convDir, f)
      if (fs.existsSync(p)) {
        const m = fs.statSync(p).mtimeMs
        if (m > maxMtime) maxMtime = m
      }
    } catch {}
  }

  // 3. presence/<id>.lock
  const presenceDir = join(geminiRoot, 'presence')
  try {
    const p = join(presenceDir, `${sessionId}.lock`)
    if (fs.existsSync(p)) {
      const m = fs.statSync(p).mtimeMs
      if (m > maxMtime) maxMtime = m
    }
  } catch {}

  // 4. 背景命令執行日誌 (tasks) 與最新對話訊息 (messages)
  for (const sub of ['tasks', 'messages']) {
    try {
      const dir = join(brainPath, '.system_generated', sub)
      if (fs.existsSync(dir)) {
        const dirM = fs.statSync(dir).mtimeMs
        if (dirM > maxMtime) maxMtime = dirM
        const entries = fs.readdirSync(dir)
        for (const e of entries.slice(-5)) {
          const ep = join(dir, e)
          const m = fs.statSync(ep).mtimeMs
          if (m > maxMtime) maxMtime = m
        }
      }
    } catch {}
  }

  return maxMtime
}

/**
 * 讀取 Antigravity 本地會話日誌與真實 Token 概況（支援多重日誌/WAL/Task/Message mtime 快速快取）
 */
function scanAntigravitySessions(max = 20): AgentSessionInfo[] {
  const brainDirs = [
    join(H, '.gemini', 'antigravity-ide', 'brain'),
    join(H, '.gemini', 'antigravity-cli', 'brain'),
    join(H, '.gemini', 'antigravity', 'brain')
  ].filter((p) => fs.existsSync(p))
  if (brainDirs.length === 0) return []

  const list: AgentSessionInfo[] = []
  const cache = loadDashboardCache()

  try {
    const allDirs: { name: string; path: string; logPath: string; mtime: number }[] = []
    for (const brainDir of brainDirs) {
      const entries = fs.readdirSync(brainDir, { withFileTypes: true })
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'tempmediaStorage')
        .map((e) => {
          const p = join(brainDir, e.name)
          const logPath = join(p, '.system_generated', 'logs', 'transcript.jsonl')
          const mtime = getAntigravitySessionMaxMtime(p, e.name, brainDir)
          return { name: e.name, path: p, logPath, mtime }
        })
      allDirs.push(...dirs)
    }

    const dirs = allDirs
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, max)

    for (const d of dirs) {
      const logPath = d.logPath
      if (!fs.existsSync(logPath)) continue

      let stat: fs.Stats
      try {
        stat = fs.statSync(logPath)
      } catch {
        continue
      }
      const lastTimeMs = d.mtime || stat.mtimeMs
      const cached = cache.get(logPath)

      // Fast-Stat 命中：未修改的會話完全免讀檔免解析，0.01ms 瞬開
      if (cached && cached.mtime === lastTimeMs) {
        const s: AgentSessionInfo = { ...cached.session }
        const timeSinceLastActive = Date.now() - lastTimeMs
        s.status =
          timeSinceLastActive < 5 * 60 * 1000
            ? 'active'
            : timeSinceLastActive < 30 * 60 * 1000
            ? 'idle'
            : 'completed'
        s.lastActiveTime = new Date(lastTimeMs || Date.now()).toISOString()
        list.push(s)
        continue
      }

      let title = 'Antigravity Session'
      let promptTokens = 0
      let toolTokens = 0
      let completionTokens = 0
      const { workspace: wsName, workspacePath: wsPath } = extractAntigravityWorkspace(logPath)

      try {
        const content = fs.readFileSync(logPath, 'utf8')
        const lines = content.trim().split(/\r?\n/)
        for (const line of lines) {
          try {
            const row = JSON.parse(line)
            if (row.type === 'USER_INPUT' && typeof row.content === 'string' && row.content) {
              // 這個 regex 在「很多個 <USER_REQUEST> 但沒有結束標籤」時是二次方的
              // （實測 1MB 的一行要 9 秒）。標題只取第一行，所以看開頭 64KB 就夠。
              const match = row.content.slice(0, 65536).match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)
              if (match) {
                title = match[1].trim().split(/\r?\n/)[0].slice(0, 45)
              }
            }
          } catch {
            // ignore malformed line
          }
        }
        // 與 Dashboard 總數同一套估算（usage.ts）：字數估，無真實 token 欄位
        const b = sumDays(fileDays('antigravity', logPath, content))
        promptTokens = b.input
        completionTokens = b.output
      } catch {
        // ignore
      }

      const totalTokens = promptTokens + toolTokens + completionTokens
      const promptPct = totalTokens > 0 ? Math.round((promptTokens / totalTokens) * 100) : 70
      const toolPct = totalTokens > 0 ? Math.round((toolTokens / totalTokens) * 100) : 18
      const compPct = Math.max(0, 100 - promptPct - toolPct)

      const timeSinceLastActive = Date.now() - lastTimeMs
      const lastTime = new Date(lastTimeMs || Date.now()).toISOString()
      const status: 'active' | 'idle' | 'completed' =
        timeSinceLastActive < 5 * 60 * 1000
          ? 'active'
          : timeSinceLastActive < 30 * 60 * 1000
          ? 'idle'
          : 'completed'

      const sessionObj: AgentSessionInfo = {
        id: d.name,
        agent: 'antigravity',
        title,
        status,
        startTime: new Date(Math.max(0, lastTimeMs - 180000)).toISOString(),
        lastActiveTime: lastTime,
        totalTokens,
        model: 'Gemini 3.8 Flash',
        workspace: wsName,
        workspacePath: wsPath,
        tokenBreakdown: {
          promptTokens,
          toolReadTokens: toolTokens,
          completionTokens,
          details: [
            { category: 'Input & Tool Output (estimated)', tokens: promptTokens, percentage: promptPct },
            { category: 'Cache Read', tokens: toolTokens, percentage: toolPct },
            { category: 'Model Output (estimated)', tokens: completionTokens, percentage: compPct }
          ]
        }
      }

      cache.set(logPath, { mtime: lastTimeMs, session: sessionObj })
      cacheDirty = true
      list.push(sessionObj)
    }
  } catch {
    // ignore
  }
  return list
}

/**
 * 掃描 Antigravity CLI 自己的 conversation 儲存區（`~/.gemini/antigravity-cli/conversations/*.db`，
 * 一個 session 一個 SQLite 檔）。這裡的檔名就是 `agy --conversation <id>` 真正吃得動的 ID——
 * 跟 scanAntigravitySessions() 讀的 IDE 面板 brain session 是兩組完全不重疊的 ID 空間，
 * 過去 Dashboard 只掃 brain session，導致點擊 resume 時帶的 ID 在 CLI 這邊永遠找不到對應紀錄，
 * 送出的 --conversation 會被 pty.ts 的防呆邏輯直接拔掉，於是每次都變成全新啟動。
 *
 * .db 是 protobuf blob、沒有 token 欄位；以前把整個二進位當文字估，同一 session 比 transcript 估算高 11 倍，
 * 已移除——token 一律以 brain transcript（usage.ts）為準，這裡只取 ID 與工作區（extractWorkspaceFromBlob）。
 */
function scanAntigravityCliConversations(max = 20): AgentSessionInfo[] {
  const convDirs = [
    join(H, '.gemini', 'antigravity-cli', 'conversations'),
    join(H, '.gemini', 'antigravity-ide', 'conversations'),
    join(H, '.gemini', 'antigravity', 'conversations')
  ].filter((p) => fs.existsSync(p))
  if (convDirs.length === 0) return []

  const list: AgentSessionInfo[] = []
  const cache = loadDashboardCache()

  try {
    const allFiles: { id: string; path: string; mtime: number }[] = []
    const seenIds = new Set<string>()

    for (const dir of convDirs) {
      const files = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.db'))
        .map((e) => {
          const p = join(dir, e.name)
          const id = e.name.slice(0, -3)
          let mtime = 0
          try {
            mtime = fs.statSync(p).mtimeMs
            const wal = `${p}-wal`
            if (fs.existsSync(wal)) {
              const walMtime = fs.statSync(wal).mtimeMs
              if (walMtime > mtime) mtime = walMtime
            }
            const presenceLock = join(dirname(dir), 'presence', `${id}.lock`)
            if (fs.existsSync(presenceLock)) {
              const lockM = fs.statSync(presenceLock).mtimeMs
              if (lockM > mtime) mtime = lockM
            }
          } catch {
            mtime = 0
          }
          return { id, path: p, mtime }
        })

      for (const f of files) {
        if (!seenIds.has(f.id)) {
          seenIds.add(f.id)
          allFiles.push(f)
        }
      }
    }

    const files = allFiles
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, max)

    for (const f of files) {
      const timeSinceLastActive = Date.now() - f.mtime
      const status: 'active' | 'idle' | 'completed' =
        timeSinceLastActive < 5 * 60 * 1000 ? 'active' : timeSinceLastActive < 30 * 60 * 1000 ? 'idle' : 'completed'
      const lastTime = new Date(f.mtime || Date.now()).toISOString()

      const cached = cache.get(f.path)
      if (cached && cached.mtime === f.mtime) {
        const s: AgentSessionInfo = { ...cached.session, status, lastActiveTime: lastTime }
        list.push(s)
        continue
      }

      const promptTokens = 0
      let rawBuf: Buffer | null = null
      try {
        rawBuf = fs.readFileSync(f.path)
      } catch {
        rawBuf = null
      }

      const { workspace: wsName, workspacePath: wsPath } = rawBuf
        ? extractWorkspaceFromBlob(rawBuf)
        : { workspace: undefined, workspacePath: undefined }

      const sessionObj: AgentSessionInfo = {
        id: f.id,
        agent: 'antigravity',
        title: wsName ? `Antigravity Session (${wsName})` : `Antigravity Session (${f.id.slice(0, 8)})`,
        status,
        startTime: new Date(Math.max(0, f.mtime - 180000)).toISOString(),
        lastActiveTime: lastTime,
        totalTokens: promptTokens,
        model: 'Gemini 3.8 Flash',
        workspace: wsName,
        workspacePath: wsPath,
        tokenBreakdown: {
          promptTokens,
          toolReadTokens: 0,
          completionTokens: 0,
          details: [
            { category: 'Unavailable (no transcript)', tokens: 0, percentage: 0 }
          ]
        }
      }

      cache.set(f.path, { mtime: f.mtime, session: sessionObj })
      cacheDirty = true
      list.push(sessionObj)
    }
  } catch {
    // ignore
  }
  return list
}

/**
 * 讀取 Claude 本地專案日誌與真實 Token 概況（支援 mtime 快速快取）
 */
function scanClaudeSessions(max = 20): AgentSessionInfo[] {
  const projectsDir = join(H, '.claude', 'projects')
  if (!fs.existsSync(projectsDir)) return []

  const list: AgentSessionInfo[] = []
  const cache = loadDashboardCache()

  try {
    // 全部專案目錄都掃：目錄 mtime 在 Windows 不隨檔案 append 更新，任何以目錄時間
    // 排序取前 N 的做法都會漏掉正在活躍的會話（每個目錄仍只取最新 max 支，檔案量級 ~100）。
    const projs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((p) => p.isDirectory())
      .map((p) => ({ name: p.name, path: join(projectsDir, p.name) }))

    for (const td of projs) {
      const fullPath = td.path
      const files = fs.readdirSync(fullPath, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
        .map((f) => {
          const fp = join(fullPath, f.name)
          return { name: f.name, path: fp, mtime: fs.statSync(fp).mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, max)

      for (const f of files) {
        if (!fs.existsSync(f.path)) continue
        let stat: fs.Stats
        try {
          stat = fs.statSync(f.path)
        } catch {
          continue
        }
        const mtime = stat.mtimeMs
        const cached = cache.get(f.path)

        // Fast-Stat 命中：直接複用歷史解析結構
        if (cached && cached.mtime === mtime) {
          const s: AgentSessionInfo = { ...cached.session }
          if (!s.workspacePath || !fs.existsSync(s.workspacePath)) {
            const { workspace: wsName, workspacePath: wsPath } = extractClaudeWorkspace(td.name, s.workspacePath)
            if (wsPath) {
              s.workspacePath = wsPath
              s.workspace = wsName
              cached.session.workspacePath = wsPath
              cached.session.workspace = wsName
              cacheDirty = true
            }
          }
          const timeSinceLastActive = Date.now() - mtime
          s.status =
            timeSinceLastActive < 5 * 60 * 1000
              ? 'active'
              : timeSinceLastActive < 30 * 60 * 1000
              ? 'idle'
              : 'completed'
          s.lastActiveTime = new Date(mtime).toISOString()
          list.push(s)
          continue
        }

        let title = 'Claude Session'
        let promptTokens = 0
        let toolTokens = 0
        let completionTokens = 0
        let model = 'Claude 3.7 Sonnet'
        let sessionCwd: string | undefined = undefined

        try {
          const content = fs.readFileSync(f.path, 'utf8')
          const lines = content.trim().split(/\r?\n/)
          for (const line of lines) {
            try {
              const row = JSON.parse(line)
              if (!sessionCwd && row.cwd) {
                sessionCwd = row.cwd
              }
              if (row.type === 'user' && row.message?.content) {
                const text =
                  typeof row.message.content === 'string'
                    ? row.message.content
                    : Array.isArray(row.message.content)
                    ? row.message.content.map((c: any) => c.text || '').join(' ')
                    : ''
                if (text && title === 'Claude Session') {
                  title = text.split(/\r?\n/)[0].slice(0, 45)
                }
              }
              if (row.attachment?.type === 'model' && row.attachment.identity?.marketingName) {
                model = row.attachment.identity.marketingName
              }
            } catch {
              // ignore
            }
          }
          // 每次 API 呼叫的真實 usage，依 message.id 去重後加總（usage.ts）
          const b = sumDays(fileDays('claude', f.path, content))
          promptTokens = b.input
          toolTokens = b.cacheRead
          completionTokens = b.output
        } catch {
          // ignore
        }

        const { workspace: wsName, workspacePath: wsPath } = extractClaudeWorkspace(td.name, sessionCwd)
        const totalTokens = promptTokens + toolTokens + completionTokens
        const promptPct = totalTokens > 0 ? Math.round((promptTokens / totalTokens) * 100) : 75
        const toolPct = totalTokens > 0 ? Math.round((toolTokens / totalTokens) * 100) : 15
        const compPct = Math.max(0, 100 - promptPct - toolPct)

        const timeSinceLastActive = Date.now() - f.mtime
        const status: 'active' | 'idle' | 'completed' =
          timeSinceLastActive < 5 * 60 * 1000
            ? 'active'
            : timeSinceLastActive < 30 * 60 * 1000
            ? 'idle'
            : 'completed'

        const sessionObj: AgentSessionInfo = {
          id: f.name.replace('.jsonl', ''),
          agent: 'claude',
          title,
          status,
          startTime: new Date(f.mtime - 300000).toISOString(),
          lastActiveTime: new Date(f.mtime).toISOString(),
          totalTokens,
          model,
          workspace: wsName,
          workspacePath: wsPath,
          tokenBreakdown: {
            promptTokens,
            toolReadTokens: toolTokens,
            completionTokens,
            details: [
              { category: 'Input & Cache Write', tokens: promptTokens, percentage: promptPct },
              { category: 'Cache Read', tokens: toolTokens, percentage: toolPct },
              { category: 'Output', tokens: completionTokens, percentage: compPct }
            ]
          }
        }

        cache.set(f.path, { mtime, session: sessionObj })
        cacheDirty = true
        list.push(sessionObj)
      }
    }
  } catch {
    // ignore
  }
  return list
}

/**
 * 讀取 Codex 的 session_index.jsonl，取得每個 session id 對應的最新自動標題。
 * 該檔為 append-only，同一 id 會有多筆（標題隨對話推進而更新），取最後一筆即最新。
 */
function loadCodexTitleMap(): Map<string, string> {
  const map = new Map<string, string>()
  const indexPath = join(H, '.codex', 'session_index.jsonl')
  try {
    const content = fs.readFileSync(indexPath, 'utf8')
    for (const line of content.trim().split(/\r?\n/)) {
      try {
        const row = JSON.parse(line)
        if (row.id && row.thread_name) map.set(row.id, row.thread_name)
      } catch {
        // ignore malformed line
      }
    }
  } catch {
    // session_index.jsonl 可能不存在
  }
  return map
}

/** 遞迴找出 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl，依檔名萃取 session id */
export function findCodexRolloutFiles(max: number): { id: string; path: string; mtime: number }[] {
  const sessionsDir = join(H, '.codex', 'sessions')
  const out: { id: string; path: string; mtime: number }[] = []
  const idRe = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        walk(p, depth + 1)
      } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        const m = e.name.match(idRe)
        if (!m) continue
        try {
          out.push({ id: m[1], path: p, mtime: fs.statSync(p).mtimeMs })
        } catch {
          // ignore
        }
      }
    }
  }
  walk(sessionsDir, 0)
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, max)
}

/**
 * 讀取 Codex 本地 rollout 紀錄與 Token 概況（支援 mtime 快速快取）。
 * Codex 的 token_count 事件是「累計值」（每個 turn 印一次目前為止的總量），
 * 所以取檔案中最後一筆 total_token_usage 即為該 session 的最終總量，不能逐行加總。
 */
function scanCodexSessions(max = 10): AgentSessionInfo[] {
  const sessionsDir = join(H, '.codex', 'sessions')
  if (!fs.existsSync(sessionsDir)) return []

  const titleMap = loadCodexTitleMap()
  const files = findCodexRolloutFiles(max)
  const list: AgentSessionInfo[] = []
  const cache = loadDashboardCache()

  for (const f of files) {
    if (!fs.existsSync(f.path)) continue
    let stat: fs.Stats
    try {
      stat = fs.statSync(f.path)
    } catch {
      continue
    }
    const mtime = stat.mtimeMs
    const cached = cache.get(f.path)

    // Fast-Stat 命中：直接複用歷史解析結構
    if (cached && cached.mtime === mtime) {
      const s: AgentSessionInfo = { ...cached.session }
      const indexTitle = titleMap.get(f.id)
      if (indexTitle) s.title = indexTitle
      const timeSinceLastActive = Date.now() - mtime
      s.status =
        timeSinceLastActive < 5 * 60 * 1000
          ? 'active'
          : timeSinceLastActive < 30 * 60 * 1000
          ? 'idle'
          : 'completed'
      s.lastActiveTime = new Date(mtime).toISOString()
      list.push(s)
      continue
    }

    const indexTitle = titleMap.get(f.id)
    let title = indexTitle || 'Codex Session'
    let promptTokens = 0
    let cachedTokens = 0
    let completionTokens = 0
    let model = 'Codex CLI'
    let wsName: string | undefined
    let wsPath: string | undefined

    try {
      const content = fs.readFileSync(f.path, 'utf8')
      const lines = content.trim().split(/\r?\n/)

      for (const line of lines) {
        try {
          const row = JSON.parse(line)
          if (row.type === 'session_meta' && row.payload?.cwd) {
            const cwd: string = row.payload.cwd
            wsPath = cwd
            wsName = basename(cwd) || cwd
          }
          if (!indexTitle && row.type === 'response_item' && row.payload?.role === 'user') {
            const parts = row.payload.content
            const found = Array.isArray(parts)
              ? parts.find(
                  (c: { type?: string; text?: string }) =>
                    c?.type === 'input_text' && c.text && !c.text.trimStart().startsWith('<')
                )
              : undefined
            if (found?.text) title = found.text.trim().split(/\r?\n/)[0].slice(0, 40)
          }
          const provModel = row.payload?.base_instructions?.provenance?.model
          if (provModel) model = provModel
        } catch {
          // ignore malformed line
        }
      }
      // 累計 total_token_usage 的差值加總（usage.ts），與 Dashboard 總數同一套算法
      const b = sumDays(fileDays('codex', f.path, content))
      promptTokens = b.input
      cachedTokens = b.cacheRead
      completionTokens = b.output
    } catch {
      // ignore unreadable rollout file
    }

    const totalTokens = promptTokens + cachedTokens + completionTokens
    const promptPct = totalTokens > 0 ? Math.round((promptTokens / totalTokens) * 100) : 0
    const cachedPct = totalTokens > 0 ? Math.round((cachedTokens / totalTokens) * 100) : 0
    const compPct = Math.max(0, 100 - promptPct - cachedPct)

    const timeSinceLastActive = Date.now() - f.mtime
    const status: 'active' | 'idle' | 'completed' =
      timeSinceLastActive < 5 * 60 * 1000
        ? 'active'
        : timeSinceLastActive < 30 * 60 * 1000
        ? 'idle'
        : 'completed'

    const sessionObj: AgentSessionInfo = {
      id: f.id,
      agent: 'codex',
      title,
      status,
      startTime: new Date(f.mtime - 300000).toISOString(),
      lastActiveTime: new Date(f.mtime).toISOString(),
      totalTokens,
      model,
      workspace: wsName,
      workspacePath: wsPath,
      tokenBreakdown: {
        promptTokens,
        toolReadTokens: cachedTokens,
        completionTokens,
        details: [
          { category: 'Input (non-cached)', tokens: promptTokens, percentage: promptPct },
          { category: 'Cache Read', tokens: cachedTokens, percentage: cachedPct },
          { category: 'Output', tokens: completionTokens, percentage: compPct }
        ]
      }
    }

    cache.set(f.path, { mtime, session: sessionObj })
    cacheDirty = true
    list.push(sessionObj)
  }

  return list
}

export interface DashboardScan {
  agyBrain: AgentSessionInfo[]
  agyCli: AgentSessionInfo[]
  claude: AgentSessionInfo[]
  codex: AgentSessionInfo[]
  usage: Record<'claude' | 'codex' | 'antigravity', Record<UsageRange, UsageBucket>>
  /** 掃完後快取裡的全部 session：封存／刪除整個工作區時用來找屬於它的 session */
  cached: AgentSessionInfo[] | null
}

/** dashboard:data 需要的所有讀檔工作，順序與搬進 worker 前相同；停用的 CLI 不掃 session 清單 */
export function scanDashboard(enabled: { claude: boolean; codex: boolean }): DashboardScan {
  try {
    const agyBrain = scanAntigravitySessions(30)
    const agyCli = scanAntigravityCliConversations(30)
    const claude = enabled.claude ? scanClaudeSessions(20) : []
    const codex = enabled.codex ? scanCodexSessions(20) : []
    // Token 用量：掃「全部歷史」紀錄檔（不只清單上最近 N 筆 session、也不限已登記工作區），
    // 依每日桶切 all/30d/7d/1d。舊版只加總最近 N 筆 → 每次打開數字都不同。
    const usage = scanAllUsage()
    return { agyBrain, agyCli, claude, codex, usage, cached: cachedSessions() }
  } finally {
    saveDashboardCache()
  }
}
