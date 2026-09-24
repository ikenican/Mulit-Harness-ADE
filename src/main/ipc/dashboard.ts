import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { join, basename, dirname } from 'path'
import { homedir } from 'os'
import { getActiveSessionMetas } from './pty'
import { workspace, getAllProjectWindows } from '../index'
import {
  isCliEnabled,
  isProtectedPath,
  getRecentWorkspaces,
  addRecentWorkspace,
  removeRecentWorkspace,
  notifyJumpListUpdate,
  setOnRecentWorkspaceAdded
} from './settings'
import type { AgentId, DashboardData, AgentSessionInfo, DashboardWorkspaceInfo } from '../../preload/index'
import { scanAllUsage, fileDays } from './usage'
import { sumDays } from './usageParse'

const H = homedir()

function normalizePath(p?: string): string {
  if (!p) return ''
  return p.replace(/\\+/g, '/').replace(/\/+/g, '/').toLowerCase().replace(/\/+$/, '')
}

function isSameWorkspace(wsPath1?: string, wsName1?: string, wsPath2?: string, wsName2?: string): boolean {
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
      for (const m of matches) {
        let clean = m.replace(/\\\\/g, '\\').trim()
        while (clean.length > 3 && !fs.existsSync(clean)) {
          clean = dirname(clean)
        }
        if (clean.length > 3 && fs.existsSync(clean) && !clean.toLowerCase().includes('appdata') && !clean.toLowerCase().includes('temp')) {
          return { workspace: basename(clean) || clean, workspacePath: clean }
        }
      }
    }
  } catch {}
  if (workspace.root && fs.existsSync(workspace.root)) {
    return { workspace: basename(workspace.root), workspacePath: workspace.root }
  }
  return { workspace: undefined, workspacePath: undefined }
}

/**
 * 從 Antigravity 會話日誌中萃取工作區名稱與真實路徑
 */
function extractAntigravityWorkspace(logPath: string): { workspace: string; workspacePath?: string } {
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

    // 2. 兜底：若日誌內容精確包含當前工作區路徑，關聯當前工作區
    if (workspace.root) {
      const normWs = normalizePath(workspace.root)
      const normContent = content.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase()
      if (normContent.includes(normWs)) {
        return { workspace: basename(workspace.root), workspacePath: workspace.root }
      }
    }
  } catch {
    // ignore
  }

  // 兜底保底：若目前工作區存在，回歸當前工作區，避免散落成孤兒分組
  if (workspace.root && fs.existsSync(workspace.root)) {
    return { workspace: basename(workspace.root), workspacePath: workspace.root }
  }

  return { workspace: 'Antigravity Workspace', workspacePath: undefined }
}

/**
 * 將目錄名稱轉換為 Claude 編碼格式，用於反解比對
 */
function normalizeForClaude(str: string): string {
  // Claude Code 在 ~/.claude/projects/ 將各個非英數字元（如空白、連字號、底線）逐一轉成 '-'
  // 例如 'Claude Agent - Personal' -> 'Claude-Agent---Personal'（保留連字號前後各別的 dash）
  return str.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * 從 Claude 專案日誌或目錄名稱中萃取工作區名稱與真實路徑
 */
function extractClaudeWorkspace(dirName: string, jsonlCwd?: string): { workspace: string; workspacePath?: string } {
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

  // 策略 4：若目錄名稱包含當前 workspace.root 的名稱（含正規化比對）
  if (workspace.root) {
    const wsBase = basename(workspace.root).toLowerCase()
    const normWsBase = normalizeForClaude(wsBase).toLowerCase()
    if (dirName.toLowerCase().includes(wsBase) || dirName.toLowerCase().includes(normWsBase)) {
      return { workspace: basename(workspace.root), workspacePath: workspace.root }
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
  version: 2
  sessions: Record<string, CachedSessionEntry>
}

let memCache: Map<string, CachedSessionEntry> | null = null
let cacheDirty = false

export function invalidateDashboardMemoryCache(): void {
  memCache = null
}

function cacheFilePath(): string {
  return join(workspace.root, '.workbench', 'dashboard-cache.json')
}

function loadDashboardCache(): Map<string, CachedSessionEntry> {
  if (memCache) return memCache
  memCache = new Map()
  try {
    const p = cacheFilePath()
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8')) as DashboardCacheStore
      if (data && data.version === 2 && typeof data.sessions === 'object') {
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
  if (!cacheDirty || !memCache || !workspace.root || isProtectedPath(workspace.root)) return
  try {
    const dir = join(workspace.root, '.workbench')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const sessionsObj: Record<string, CachedSessionEntry> = {}
    for (const [k, v] of memCache.entries()) {
      sessionsObj[k] = v
    }
    const store: DashboardCacheStore = {
      version: 2,
      sessions: sessionsObj
    }
    fs.writeFileSync(cacheFilePath(), JSON.stringify(store), 'utf8')
    cacheDirty = false
  } catch {
    // ignore
  }
}

/**
 * 從歷史 Agent 會話與快取中探索可用的專案工作區路徑（供 JumpList / 最近專案推薦）
 */
export function getRecentWorkspacesFromDashboard(): string[] {
  const results = new Set<string>()

  // 1. 從記憶體快取或檔案快取提取
  try {
    const cache = loadDashboardCache()
    const sorted = Array.from(cache.values()).sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    for (const entry of sorted) {
      const p = entry.session.workspacePath
      if (p && !isProtectedPath(p) && fs.existsSync(p)) {
        try {
          if (fs.statSync(p).isDirectory()) {
            results.add(path.resolve(p))
          }
        } catch {}
      }
      if (results.size >= 10) break
    }
  } catch {}

  // 2. 探測 ~/.claude/projects 目錄
  try {
    const claudeDir = join(H, '.claude', 'projects')
    if (fs.existsSync(claudeDir)) {
      const entries = fs.readdirSync(claudeDir, { withFileTypes: true })
      const dirsWithTime: { name: string; mtime: number }[] = []
      for (const e of entries) {
        if (e.isDirectory() && e.name.match(/^[A-Za-z]--/)) {
          try {
            const st = fs.statSync(join(claudeDir, e.name))
            dirsWithTime.push({ name: e.name, mtime: st.mtimeMs })
          } catch {}
        }
      }
      dirsWithTime.sort((a, b) => b.mtime - a.mtime)

      for (const d of dirsWithTime) {
        const decoded = extractClaudeWorkspace(d.name)
        if (decoded.workspacePath && !isProtectedPath(decoded.workspacePath) && fs.existsSync(decoded.workspacePath)) {
          results.add(path.resolve(decoded.workspacePath))
        }
        if (results.size >= 15) break
      }
    }
  } catch {}

  return Array.from(results)
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
            if (row.type === 'USER_INPUT' && row.content) {
              const match = row.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)
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
function findCodexRolloutFiles(max: number): { id: string; path: string; mtime: number }[] {
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
    let wsName = workspace.root ? basename(workspace.root) : 'Workspace'
    let wsPath = workspace.root || ''

    try {
      const content = fs.readFileSync(f.path, 'utf8')
      const lines = content.trim().split(/\r?\n/)

      for (const line of lines) {
        try {
          const row = JSON.parse(line)
          if (row.type === 'session_meta' && row.payload?.cwd) {
            wsPath = row.payload.cwd
            wsName = basename(wsPath) || wsName
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

export interface DashboardState {
  archivedIds: string[]
  deletedIds: string[]
  archivedWorkspaces: string[]
  deletedWorkspaces: string[]
}

function stateFilePath(): string {
  try {
    return join(app.getPath('userData'), 'dashboard-state.json')
  } catch {
    return join(process.env['APPDATA'] || process.cwd(), 'agent-workbench', 'dashboard-state.json')
  }
}

export function loadDashboardState(): DashboardState {
  try {
    const p = stateFilePath()
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      return {
        archivedIds: Array.isArray(parsed.archivedIds) ? parsed.archivedIds : [],
        deletedIds: Array.isArray(parsed.deletedIds) ? parsed.deletedIds : [],
        archivedWorkspaces: Array.isArray(parsed.archivedWorkspaces) ? parsed.archivedWorkspaces : [],
        deletedWorkspaces: Array.isArray(parsed.deletedWorkspaces) ? parsed.deletedWorkspaces : []
      }
    }
  } catch {
    // ignore
  }
  return { archivedIds: [], deletedIds: [], archivedWorkspaces: [], deletedWorkspaces: [] }
}

export function saveDashboardState(state: DashboardState): void {
  try {
    const p = stateFilePath()
    const dir = dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
    console.warn('[Dashboard] Failed to save dashboard state:', err)
  }
}

export function unmarkDeletedOrArchivedWorkspace(dir: string): void {
  try {
    if (!dir) return
    const norm = normalizePath(dir)
    const wsName = (dir.split(/[\\/]/).filter(Boolean).pop() || dir).trim().toLowerCase()
    const state = loadDashboardState()
    let changed = false

    const isMatch = (target?: string): boolean => {
      if (!target) return false
      const nt = normalizePath(target)
      if (nt === norm || nt.endsWith('/' + norm) || norm.endsWith('/' + nt)) return true
      const base = (target.split(/[\\/]/).filter(Boolean).pop() || target).trim().toLowerCase()
      if (base && wsName && (base === wsName || nt === wsName || base.endsWith('/' + wsName))) return true
      return false
    }

    // 1. 從 deletedWorkspaces 與 archivedWorkspaces 移除
    const prevDelCount = state.deletedWorkspaces.length
    state.deletedWorkspaces = state.deletedWorkspaces.filter((w) => !isMatch(w))
    if (state.deletedWorkspaces.length !== prevDelCount) changed = true

    const prevArchCount = state.archivedWorkspaces.length
    state.archivedWorkspaces = state.archivedWorkspaces.filter((w) => !isMatch(w))
    if (state.archivedWorkspaces.length !== prevArchCount) changed = true

    // 2. 解除屬於該工作區的所有會話的 deletedIds 與 archivedIds 標記
    const unmarkIds = new Set<string>()

    if (memCache) {
      for (const entry of memCache.values()) {
        const s = entry.session
        if (isSameWorkspace(s.workspacePath, s.workspace, dir, wsName) || isMatch(s.workspacePath) || isMatch(s.workspace)) {
          unmarkIds.add(s.id)
        }
      }
    }

    // 探測 Claude 專案日誌目錄
    try {
      const claudeDir = join(H, '.claude', 'projects')
      if (fs.existsSync(claudeDir)) {
        for (const e of fs.readdirSync(claudeDir, { withFileTypes: true })) {
          if (e.isDirectory()) {
            const decoded = extractClaudeWorkspace(e.name)
            if (isSameWorkspace(decoded.workspacePath, decoded.workspace, dir, wsName) || isMatch(decoded.workspacePath) || isMatch(decoded.workspace)) {
              const fullP = join(claudeDir, e.name)
              for (const f of fs.readdirSync(fullP)) {
                if (f.endsWith('.jsonl')) {
                  unmarkIds.add(f.slice(0, -6))
                }
              }
            }
          }
        }
      }
    } catch {}

    // 探測 Antigravity brain
    try {
      for (const b of [join(H, '.gemini', 'antigravity-ide', 'brain'), join(H, '.gemini', 'antigravity-cli', 'brain'), join(H, '.gemini', 'antigravity', 'brain')]) {
        if (!fs.existsSync(b)) continue
        for (const e of fs.readdirSync(b, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith('.')) {
            const logPath = join(b, e.name, '.system_generated', 'logs', 'transcript.jsonl')
            if (fs.existsSync(logPath)) {
              const { workspace: aWs, workspacePath: aPath } = extractAntigravityWorkspace(logPath)
              if (isSameWorkspace(aPath, aWs, dir, wsName) || isMatch(aPath) || isMatch(aWs)) {
                unmarkIds.add(e.name)
              }
            }
          }
        }
      }
    } catch {}

    if (unmarkIds.size > 0) {
      const prevDelIds = state.deletedIds.length
      state.deletedIds = state.deletedIds.filter((id) => !unmarkIds.has(id))
      if (state.deletedIds.length !== prevDelIds) changed = true

      const prevArchIds = state.archivedIds.length
      state.archivedIds = state.archivedIds.filter((id) => !unmarkIds.has(id))
      if (state.archivedIds.length !== prevArchIds) changed = true
    }

    if (changed) {
      saveDashboardState(state)
    }
    invalidateDashboardMemoryCache()
    notifyJumpListUpdate()
  } catch (err) {
    console.warn('[Dashboard] Failed to unmarkDeletedOrArchivedWorkspace:', err)
  }
}

setOnRecentWorkspaceAdded((dir) => {
  unmarkDeletedOrArchivedWorkspace(dir)
})

let activeScanPromise: Promise<DashboardData> | null = null

export function registerDashboardHandlers(): void {
  // 只要 token 用量（Vibe 終端上方狀態列用），不跑整套 session 掃描
  ipcMain.handle('dashboard:usage', () => scanAllUsage())

  ipcMain.handle('dashboard:data', async (_e, force?: boolean): Promise<DashboardData> => {
    if (force) {
      invalidateDashboardMemoryCache()
    } else if (activeScanPromise) {
      return activeScanPromise
    }

    const runScan = async (): Promise<DashboardData> => {
      try {
        const state = loadDashboardState()
        const deletedSet = new Set(state.deletedIds)
        const archivedSet = new Set(state.archivedIds)

        // 1. 抓取目前活躍終端 PTY 行程
        const activePtySessions = getActiveSessionMetas()

        // 2. 抓取歷史真實會話記錄（依 Settings 啟用狀態過濾）
        const agyBrainSessions = scanAntigravitySessions(30)
        const agyCliSessions = scanAntigravityCliConversations(30)
        const agySessionMap = new Map<string, AgentSessionInfo>()

        // 優先收納 scanAntigravitySessions (具有完整日誌與 Token 細節)
        for (const s of agyBrainSessions) {
          agySessionMap.set(s.id, s)
        }

        // 補充或更新 scanAntigravityCliConversations
        for (const s of agyCliSessions) {
          if (agySessionMap.has(s.id)) {
            const existing = agySessionMap.get(s.id)!
            const existingTime = new Date(existing.lastActiveTime).getTime()
            const cliTime = new Date(s.lastActiveTime).getTime()
            if (cliTime > existingTime) {
              existing.lastActiveTime = s.lastActiveTime
              existing.status = s.status
            }
          } else {
            agySessionMap.set(s.id, s)
          }
        }

        const agySessions = isCliEnabled('antigravity')
          ? Array.from(agySessionMap.values())
              .filter((s) => !deletedSet.has(s.id))
              .map((s) => ({ ...s, isArchived: archivedSet.has(s.id) }))
          : []

    const claudeSessions = isCliEnabled('claude')
      ? scanClaudeSessions(20)
          .filter((s) => !deletedSet.has(s.id))
          .map((s) => ({ ...s, isArchived: archivedSet.has(s.id) }))
      : []

    const codexSessions = isCliEnabled('codex')
      ? scanCodexSessions(20)
          .filter((s) => !deletedSet.has(s.id))
          .map((s) => ({ ...s, isArchived: archivedSet.has(s.id) }))
      : []

    // 3. 智慧關聯活躍進程與真實 Session
    // 只有真正屬於已啟用的 Agent CLI 進程才需要關聯；普通 Shell (PowerShell/CMD/Bash) 與停用之 Agent 不作為 Session 呈現
    const standaloneSessions: AgentSessionInfo[] = []
    const matchedSet = new Set<string>()

    for (const p of activePtySessions) {
      const cmd = (p.command || '').toLowerCase()
      const lid = (p.launcherId || '').toLowerCase()
      const isClaude = isCliEnabled('claude') && (cmd.includes('claude') || lid.includes('claude'))
      const isAgy = isCliEnabled('antigravity') && (cmd.includes('agy') || cmd.includes('antigravity') || lid.includes('antigravity'))
      const isCodex = isCliEnabled('codex') && (cmd.includes('codex') || lid.includes('codex'))

      if (!isClaude && !isAgy && !isCodex) {
        // 一般 shell 或已停用 Agent 不當作 Agent Session，杜絕幽靈假卡片
        continue
      }

      const agentType: AgentId = isClaude ? 'claude' : isAgy ? 'antigravity' : 'codex'
      const candidates =
        agentType === 'claude'
          ? claudeSessions
          : agentType === 'antigravity'
          ? agySessions
          : codexSessions
      const targetCwd = p.cwd || workspace.root

      // 提取有效關聯 Session ID（優先取 sessionId，若無則從命令參數中解析）
      let effectiveSessionId = p.sessionId
      if (!effectiveSessionId && p.args) {
        const rIdx = p.args.findIndex((a) => a === '--resume' || a === '-r' || a === '--conversation')
        if (rIdx !== -1 && p.args[rIdx + 1] && !p.args[rIdx + 1].startsWith('-')) {
          effectiveSessionId = p.args[rIdx + 1]
        } else {
          const resumeCmdIdx = p.args.findIndex((a) => a === 'resume')
          if (resumeCmdIdx !== -1 && p.args[resumeCmdIdx + 1] && !p.args[resumeCmdIdx + 1].startsWith('-')) {
            effectiveSessionId = p.args[resumeCmdIdx + 1]
          }
        }
      }

      // 優先 1：若 PTY 帶有明確關聯的 sessionId 或從啟動參數提取到 session ID
      let matched = effectiveSessionId ? candidates.find((s) => s.id === effectiveSessionId && !matchedSet.has(s.id)) : undefined

      // 帶有明確 sessionId 的 PTY（由 Dashboard 點卡片開啟）只認那一支會話；
      // 找不到就讓它成為獨立卡片，不可退回下列模糊比對去點亮別人的卡片。
      const allowFuzzyMatch = !effectiveSessionId

      // 優先 2：同工作區且在 PTY 啟動前不久或之後活躍之 Session
      if (!matched && allowFuzzyMatch) {
        matched = candidates.find(
          (s) =>
            !s.isArchived &&
            !matchedSet.has(s.id) &&
            isSameWorkspace(s.workspacePath, s.workspace, targetCwd) &&
            new Date(s.lastActiveTime).getTime() >= p.startTime - 60000
        )
      }

      // 優先 3：同工作區目錄中最新活躍之 Session（只要 PTY 正在該工作區運行對應 Agent，該工作區最新會話即為目前活躍之會話）
      if (!matched && allowFuzzyMatch) {
        const sameWsCandidates = candidates
          .filter(
            (s) =>
              !s.isArchived &&
              !matchedSet.has(s.id) &&
              isSameWorkspace(s.workspacePath, s.workspace, targetCwd)
          )
          .sort((a, b) => new Date(b.lastActiveTime).getTime() - new Date(a.lastActiveTime).getTime())

        if (sameWsCandidates.length > 0) {
          matched = sameWsCandidates[0]
        }
      }

      // 優先 4：若 PTY 正在運行但工作區未直接命中（例如使用者在終端內手動 cd 切換、深層子專案或暫時路徑）：
      // 自動關聯至該 Agent 近期（30 分鐘內）最新活躍之真實會話
      if (!matched && allowFuzzyMatch) {
        const recentGlobalCandidates = candidates
          .filter(
            (s) =>
              !s.isArchived &&
              !matchedSet.has(s.id) &&
              Date.now() - new Date(s.lastActiveTime).getTime() < 30 * 60 * 1000
          )
          .sort((a, b) => new Date(b.lastActiveTime).getTime() - new Date(a.lastActiveTime).getTime())

        if (recentGlobalCandidates.length > 0) {
          matched = recentGlobalCandidates[0]
        }
      }

      if (matched) {
        matchedSet.add(matched.id)
        matched.status = 'active'
        matched.lastActiveTime = new Date().toISOString()
      } else if (!deletedSet.has(p.id)) {
        const normTarget = normalizePath(targetCwd)
        if (normTarget && state.deletedWorkspaces.some((w) => normalizePath(w) === normTarget)) {
          continue
        }
        const isWsArchived = Boolean(
          archivedSet.has(p.id) ||
          (normTarget && state.archivedWorkspaces.some((w) => normalizePath(w) === normTarget))
        )
        const currentName = targetCwd ? basename(targetCwd) : 'Workspace'
        standaloneSessions.push({
          id: p.id,
          agent: agentType,
          title: `${agentType === 'claude' ? 'Claude Code' : agentType === 'antigravity' ? 'Antigravity' : 'Codex'} (Active Session)`,
          status: 'active',
          startTime: new Date(p.startTime).toISOString(),
          lastActiveTime: new Date().toISOString(),
          totalTokens: 0,
          model: agentType === 'claude' ? 'Claude 3.7 Sonnet' : agentType === 'antigravity' ? 'Gemini 3.8 Flash' : 'Codex CLI',
          isArchived: isWsArchived,
          workspace: currentName,
          workspacePath: targetCwd,
          tokenBreakdown: {
            promptTokens: 0,
            toolReadTokens: 0,
            completionTokens: 0,
            details: [
              { category: 'Context & System Prompt', tokens: 0, percentage: 0 },
              { category: 'Tool Execution & Files', tokens: 0, percentage: 0 },
              { category: 'Thinking & Generation', tokens: 0, percentage: 0 }
            ]
          }
        })
      }
    }

    // 4. 取得使用者真正開啟過的所有合法工作區（recentWorkspaces + 各開啟中視窗之 workspaceRoot）
    const userPathsSet = new Set<string>()
    for (const p of getRecentWorkspaces()) {
      if (p && !isProtectedPath(p)) {
        userPathsSet.add(path.resolve(p))
      }
    }
    for (const pw of getAllProjectWindows()) {
      if (pw.workspaceRoot && !isProtectedPath(pw.workspaceRoot)) {
        userPathsSet.add(path.resolve(pw.workspaceRoot))
      }
    }
    if (workspace.root && !isProtectedPath(workspace.root)) {
      userPathsSet.add(path.resolve(workspace.root))
    }

    const deletedWorkspacesSet = new Set(state.deletedWorkspaces.map((w) => normalizePath(w)))
    const archivedWorkspacesSet = new Set(state.archivedWorkspaces.map((w) => normalizePath(w)))

    // 排除已刪除者
    const activeUserPaths: string[] = []
    for (const p of userPathsSet) {
      const norm = normalizePath(p)
      if (!deletedWorkspacesSet.has(norm) && !archivedWorkspacesSet.has(norm)) {
        activeUserPaths.push(p)
      }
    }

    const archivedUserPaths: string[] = []
    for (const p of state.archivedWorkspaces) {
      const norm = normalizePath(p)
      if (!deletedWorkspacesSet.has(norm)) {
        archivedUserPaths.push(p)
      }
    }

    const allAllowedPaths = [...activeUserPaths, ...archivedUserPaths]
    const currentRoot = workspace.root ? path.resolve(workspace.root) : ''
    const userWorkspacesList: DashboardWorkspaceInfo[] = [
      ...activeUserPaths.map((p) => ({
        path: p,
        name: basename(p) || p,
        isCurrent: Boolean(currentRoot && normalizePath(currentRoot) === normalizePath(p)),
        isArchived: false
      })),
      ...archivedUserPaths.map((p) => ({
        path: p,
        name: basename(p) || p,
        isCurrent: Boolean(currentRoot && normalizePath(currentRoot) === normalizePath(p)),
        isArchived: true
      }))
    ]

    // 判斷某 session 是否屬於使用者合法工作區之一
    const matchUserWorkspace = (s: AgentSessionInfo): { matched: boolean; isArchived: boolean; matchedPath?: string } => {
      if (standaloneSessions.some((st) => st.id === s.id)) {
        return { matched: true, isArchived: false }
      }
      for (const p of allAllowedPaths) {
        const pName = basename(p)
        if (isSameWorkspace(s.workspacePath, s.workspace, p, pName)) {
          const isArchived = archivedWorkspacesSet.has(normalizePath(p)) || archivedSet.has(s.id)
          return { matched: true, isArchived, matchedPath: p }
        }
      }
      // 活躍會話（即使在外部終端新開專案目錄）或具有有效工作區實體目錄之會話：
      // 只要未被使用者明確隱藏 (deletedWorkspaces)，均允許在 Dashboard 呈現，確保外面執行的 CLI 不會遺失
      if (s.status === 'active' || (s.workspacePath && fs.existsSync(s.workspacePath) && !isProtectedPath(s.workspacePath))) {
        const normWs = s.workspacePath ? normalizePath(s.workspacePath) : ''
        if (normWs && deletedWorkspacesSet.has(normWs)) {
          return { matched: false, isArchived: false }
        }
        const isArchived = Boolean(archivedSet.has(s.id) || (normWs && archivedWorkspacesSet.has(normWs)))
        return { matched: true, isArchived, matchedPath: s.workspacePath }
      }
      return { matched: false, isArchived: false }
    }

    const filterUserSessions = (list: AgentSessionInfo[]): AgentSessionInfo[] => {
      const res: AgentSessionInfo[] = []
      for (const s of list) {
        const m = matchUserWorkspace(s)
        if (m.matched) {
          res.push({
            ...s,
            isArchived: m.isArchived,
            // 絕不覆寫該會話本身已有的真實工作區路徑與名稱，只在缺失時才以匹配工作區回填
            workspacePath: s.workspacePath || m.matchedPath,
            workspace: s.workspace || (m.matchedPath ? basename(m.matchedPath) : s.workspace)
          })
        }
      }
      return res
    }

    const filteredAgy = filterUserSessions(agySessions)
    const filteredClaude = filterUserSessions(claudeSessions)
    const filteredCodex = filterUserSessions(codexSessions)

    // 合併清單：活躍的優先排在最前，其餘依最後活躍時間排序
    const allSessions = [...standaloneSessions, ...filteredAgy, ...filteredClaude, ...filteredCodex].sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1
      if (a.status !== 'active' && b.status === 'active') return 1
      return new Date(b.lastActiveTime).getTime() - new Date(a.lastActiveTime).getTime()
    })

    // 6. Token 用量：掃「全部歷史」紀錄檔（不只清單上最近 N 筆 session、也不限已登記工作區），
    //    依每日桶切 all/30d/7d/1d。舊版只加總最近 N 筆 → 每次打開數字都不同。
    const usageByRange = scanAllUsage()
    const computeAgentUsage = (agentId: AgentId) => {
      const list = allSessions.filter((s) => s.agent === agentId)
      const u = usageByRange[agentId].all
      return {
        total: u.input + u.cacheRead + u.output,
        prompt: u.input,
        tool: u.cacheRead,
        comp: u.output,
        totalSessions: list.length,
        activeSessions: list.filter((s) => s.status === 'active').length
      }
    }

    // 7. 計算各 Agent 統計指標
    const claudeUsage = computeAgentUsage('claude')
    const agyUsage = computeAgentUsage('antigravity')
    const codexUsage = computeAgentUsage('codex')

    const data: DashboardData = {
      agents: {
        claude: {
          agent: 'claude',
          label: 'Claude Code',
          totalSessions: claudeUsage.totalSessions,
          activeSessions: claudeUsage.activeSessions,
          totalTokens: claudeUsage.total,
          promptTokens: claudeUsage.prompt,
          toolTokens: claudeUsage.tool,
          completionTokens: claudeUsage.comp
        },
        antigravity: {
          agent: 'antigravity',
          label: 'Antigravity',
          estimated: true,
          totalSessions: agyUsage.totalSessions,
          activeSessions: agyUsage.activeSessions,
          totalTokens: agyUsage.total,
          promptTokens: agyUsage.prompt,
          toolTokens: agyUsage.tool,
          completionTokens: agyUsage.comp
        },
        codex: {
          agent: 'codex',
          label: 'Codex',
          totalSessions: codexUsage.totalSessions,
          activeSessions: codexUsage.activeSessions,
          totalTokens: codexUsage.total,
          promptTokens: codexUsage.prompt,
          toolTokens: codexUsage.tool,
          completionTokens: codexUsage.comp
        }
      },
      usageByRange,
      sessions: allSessions,
      userWorkspaces: userWorkspacesList,
      archivedWorkspaces: state.archivedWorkspaces,
      deletedWorkspaces: state.deletedWorkspaces
    }

        return data
      } finally {
        activeScanPromise = null
        saveDashboardCache()
      }
    }

    const p = runScan()
    activeScanPromise = p
    return p
  })

  ipcMain.handle('dashboard:archiveSession', async (_e, id: string, archive: boolean): Promise<boolean> => {
    const state = loadDashboardState()
    if (archive) {
      if (!state.archivedIds.includes(id)) state.archivedIds.push(id)
    } else {
      state.archivedIds = state.archivedIds.filter((x) => x !== id)
    }
    saveDashboardState(state)
    return true
  })

  ipcMain.handle('dashboard:archiveSessions', async (_e, ids: string[], archive: boolean): Promise<boolean> => {
    const state = loadDashboardState()
    const idSet = new Set(ids)
    if (archive) {
      for (const id of ids) {
        if (!state.archivedIds.includes(id)) state.archivedIds.push(id)
      }
    } else {
      state.archivedIds = state.archivedIds.filter((x) => !idSet.has(x))
    }
    saveDashboardState(state)
    return true
  })

  ipcMain.handle('dashboard:deleteSession', async (_e, id: string): Promise<boolean> => {
    const state = loadDashboardState()
    if (!state.deletedIds.includes(id)) {
      state.deletedIds.push(id)
    }
    state.archivedIds = state.archivedIds.filter((x) => x !== id)
    saveDashboardState(state)
    return true
  })

  ipcMain.handle('dashboard:deleteSessions', async (_e, ids: string[]): Promise<boolean> => {
    const state = loadDashboardState()
    const idSet = new Set(ids)
    for (const id of ids) {
      if (!state.deletedIds.includes(id)) {
        state.deletedIds.push(id)
      }
    }
    state.archivedIds = state.archivedIds.filter((x) => !idSet.has(x))
    saveDashboardState(state)
    return true
  })

  ipcMain.handle(
    'dashboard:archiveWorkspace',
    async (_e, wsPath: string, archive: boolean, sessionIds?: string[]): Promise<boolean> => {
      if (!wsPath) return false
      const state = loadDashboardState()
      const norm = normalizePath(wsPath)
      const wsName = (wsPath.split(/[\\/]/).filter(Boolean).pop() || wsPath).trim()

      const isTargetWs = (wPath?: string, wName?: string): boolean => {
        if (!wPath && !wName) return false
        if (isSameWorkspace(wPath, wName, wsPath, wsName)) return true
        if (wPath) {
          const nw = normalizePath(wPath)
          if (nw === norm || nw.endsWith('/' + norm) || norm.endsWith('/' + nw)) return true
        }
        const n = (wName || (wPath ? basename(wPath) : '')).trim().toLowerCase()
        if (n && (n === wsName.toLowerCase() || n === norm)) return true
        return false
      }

      if (archive) {
        if (!state.archivedWorkspaces.some((w) => isTargetWs(w, basename(w)))) {
          state.archivedWorkspaces.push(wsPath)
        }
        state.deletedWorkspaces = state.deletedWorkspaces.filter((w) => !isTargetWs(w, basename(w)))

        // 同步標記前端傳入的特定 session IDs
        if (Array.isArray(sessionIds) && sessionIds.length > 0) {
          for (const id of sessionIds) {
            if (!state.archivedIds.includes(id)) state.archivedIds.push(id)
          }
        }

        // 同步標記記憶體快取中屬於該工作區的所有 session
        if (memCache) {
          for (const entry of memCache.values()) {
            const s = entry.session
            if (isTargetWs(s.workspacePath, s.workspace)) {
              if (!state.archivedIds.includes(s.id)) state.archivedIds.push(s.id)
            }
          }
        }
      } else {
        state.archivedWorkspaces = state.archivedWorkspaces.filter((w) => !isTargetWs(w, basename(w)))

        if (Array.isArray(sessionIds) && sessionIds.length > 0) {
          const idSet = new Set(sessionIds)
          state.archivedIds = state.archivedIds.filter((id) => !idSet.has(id))
        }

        if (memCache) {
          for (const entry of memCache.values()) {
            const s = entry.session
            if (isTargetWs(s.workspacePath, s.workspace)) {
              state.archivedIds = state.archivedIds.filter((id) => id !== s.id)
            }
          }
        }
        if (fs.existsSync(wsPath)) {
          addRecentWorkspace(wsPath)
        }
      }
      invalidateDashboardMemoryCache()
      saveDashboardState(state)
      notifyJumpListUpdate()
      return true
    }
  )

  ipcMain.handle(
    'dashboard:deleteWorkspace',
    async (_e, wsPath: string, sessionIds?: string[]): Promise<boolean> => {
      if (!wsPath) return false
      const state = loadDashboardState()
      const norm = normalizePath(wsPath)
      const wsName = (wsPath.split(/[\\/]/).filter(Boolean).pop() || wsPath).trim()

      const isTargetWs = (wPath?: string, wName?: string): boolean => {
        if (!wPath && !wName) return false
        if (isSameWorkspace(wPath, wName, wsPath, wsName)) return true
        if (wPath) {
          const nw = normalizePath(wPath)
          if (nw === norm || nw.endsWith('/' + norm) || norm.endsWith('/' + nw)) return true
        }
        const n = (wName || (wPath ? basename(wPath) : '')).trim().toLowerCase()
        if (n && (n === wsName.toLowerCase() || n === norm)) return true
        return false
      }

      state.archivedWorkspaces = state.archivedWorkspaces.filter((w) => !isTargetWs(w, basename(w)))
      if (!state.deletedWorkspaces.some((w) => isTargetWs(w, basename(w)))) {
        state.deletedWorkspaces.push(wsPath)
      }

      // 同步隱藏所屬 session IDs
      if (Array.isArray(sessionIds) && sessionIds.length > 0) {
        for (const id of sessionIds) {
          if (!state.deletedIds.includes(id)) state.deletedIds.push(id)
        }
        const idSet = new Set(sessionIds)
        state.archivedIds = state.archivedIds.filter((id) => !idSet.has(id))
      }

      // 同步隱藏記憶體快取中屬於該工作區的所有 session
      if (memCache) {
        for (const entry of memCache.values()) {
          const s = entry.session
          if (isTargetWs(s.workspacePath, s.workspace)) {
            if (!state.deletedIds.includes(s.id)) state.deletedIds.push(s.id)
            state.archivedIds = state.archivedIds.filter((id) => id !== s.id)
          }
        }
      }

      if (fs.existsSync(wsPath)) {
        removeRecentWorkspace(wsPath)
      }
      invalidateDashboardMemoryCache()
      saveDashboardState(state)
      notifyJumpListUpdate()
      return true
    }
  )

  ipcMain.handle('dashboard:unmarkWorkspace', async (_e, wsPath: string): Promise<boolean> => {
    if (!wsPath) return false
    unmarkDeletedOrArchivedWorkspace(wsPath)
    return true
  })
}
