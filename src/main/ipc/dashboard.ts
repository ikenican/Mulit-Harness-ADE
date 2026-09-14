import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { join, basename, dirname } from 'path'
import { homedir } from 'os'
import { getActiveSessionMetas } from './pty'
import { workspace } from '../index'
import { isCliEnabled, isProtectedPath } from './settings'
import type { AgentId, DashboardData, AgentSessionInfo } from '../../preload/index'

const H = homedir()

/**
 * 簡易從字元數推算 Token 數（中英混和平均 1 token ~ 3.5 字元）
 */
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.5)
}

function normalizePath(p?: string): string {
  if (!p) return ''
  return p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}

function isSameWorkspace(wsPath1?: string, wsName1?: string, wsPath2?: string, wsName2?: string): boolean {
  const norm1 = normalizePath(wsPath1)
  const norm2 = normalizePath(wsPath2)
  if (norm1 && norm2) {
    if (norm1 === norm2 || norm1.endsWith('/' + norm2) || norm2.endsWith('/' + norm1)) {
      return true
    }
  }
  const n1 = (wsName1 || (wsPath1 ? basename(wsPath1) : '')).trim().toLowerCase()
  const n2 = (wsName2 || (wsPath2 ? basename(wsPath2) : '')).trim().toLowerCase()
  if (n1 && n2 && n1 === n2) {
    return true
  }
  return false
}

/**
 * 從 Antigravity 會話日誌中萃取工作區名稱與真實路徑
 */
function extractAntigravityWorkspace(logPath: string): { workspace: string; workspacePath?: string } {
  if (!fs.existsSync(logPath)) {
    return { workspace: 'Antigravity Session', workspacePath: undefined }
  }

  try {
    const fd = fs.openSync(logPath, 'r')
    const buf = Buffer.alloc(65536)
    const bytesRead = fs.readSync(fd, buf, 0, 65536, 0)
    fs.closeSync(fd)
    const header = buf.toString('utf8', 0, bytesRead)

    // 1. 最高優先級：若日誌包含當前 workspace.root，直接關聯當前專案
    if (workspace.root) {
      const normWs = normalizePath(workspace.root)
      const normHeader = header.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase()
      if (normHeader.includes(normWs)) {
        return { workspace: basename(workspace.root), workspacePath: workspace.root }
      }
    }

    // 2. 匹配 [URI] -> [CorpusName] 格式
    const uriMatch = header.match(/([a-zA-Z]:[^\r\n]+?)\s*->\s*[^\r\n]+/)
    if (uriMatch && uriMatch[1]) {
      const target = uriMatch[1].trim()
      if (target.length > 3 && fs.existsSync(target)) {
        return { workspace: basename(target) || target, workspacePath: target }
      }
    }

    // 3. 匹配 Cwd (工具調用參數，排除引號與跳脫字元)
    const cwdMatch = header.match(/"[Cc]wd"\s*:\s*(?:"\\?"|")([^"\r\n]+?)(?:\\?"|")/)
    if (cwdMatch && cwdMatch[1]) {
      const target = cwdMatch[1].replace(/^[\\"]+|[\\"]+$/g, '').replace(/\\\\/g, '\\').trim()
      if (target.length > 3 && fs.existsSync(target)) {
        return { workspace: basename(target) || target, workspacePath: target }
      }
    }

    // 4. 匹配 Active Document: <path>
    const docMatch = header.match(/(?:Active Document|Other open documents: -)\s*[:\-]?\s*([A-Za-z]:[^\r\n"()]+)/)
    if (docMatch && docMatch[1]) {
      const full = docMatch[1].trim()
      const dir = dirname(full)
      if (dir.length > 3 && fs.existsSync(dir)) {
        return { workspace: basename(dir) || dir, workspacePath: dir }
      }
    }
  } catch {
    // ignore
  }

  return { workspace: 'Antigravity Workspace', workspacePath: undefined }
}

/**
 * 從 Claude 專案日誌或目錄名稱中萃取工作區名稱與真實路徑
 */
function extractClaudeWorkspace(dirName: string, jsonlCwd?: string): { workspace: string; workspacePath?: string } {
  if (jsonlCwd && jsonlCwd.trim()) {
    const cleanCwd = jsonlCwd.trim()
    return { workspace: basename(cleanCwd) || cleanCwd, workspacePath: cleanCwd }
  }

  // 若目錄名稱包含當前 workspace.root 的名稱
  if (workspace.root) {
    const wsBase = basename(workspace.root).toLowerCase()
    if (dirName.toLowerCase().includes(wsBase)) {
      return { workspace: basename(workspace.root), workspacePath: workspace.root }
    }
  }

  // Claude 專案目錄格式如：D--Cloud-OneDrive-AI-workspace-...
  // 嘗試反解目錄名為真實磁碟路徑
  let restored = dirName
  if (restored.match(/^[A-Za-z]--/)) {
    restored = restored.charAt(0) + ':\\' + restored.slice(3).replace(/--/g, '\\').replace(/-/g, ' ')
  }
  if (fs.existsSync(restored)) {
    return { workspace: basename(restored) || restored, workspacePath: restored }
  }

  const parts = dirName.split('--')
  const lastPart = parts[parts.length - 1] || dirName
  const cleanName = lastPart.replace(/^.*?-([A-Za-z0-9_\-\s]+)$/, '$1') || lastPart

  return { workspace: cleanName || dirName, workspacePath: undefined }
}

interface CachedSessionEntry {
  mtime: number
  session: AgentSessionInfo
}

interface DashboardCacheStore {
  version: 1
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
      if (data && data.version === 1 && typeof data.sessions === 'object') {
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
      version: 1,
      sessions: sessionsObj
    }
    fs.writeFileSync(cacheFilePath(), JSON.stringify(store), 'utf8')
    cacheDirty = false
  } catch {
    // ignore
  }
}

/**
 * 讀取 Antigravity 本地會話日誌與真實 Token 概況（支援 mtime 快速快取）
 */
function scanAntigravitySessions(max = 20): AgentSessionInfo[] {
  const brainDir = join(H, '.gemini', 'antigravity-ide', 'brain')
  if (!fs.existsSync(brainDir)) return []

  const list: AgentSessionInfo[] = []
  const cache = loadDashboardCache()

  try {
    const entries = fs.readdirSync(brainDir, { withFileTypes: true })
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'tempmediaStorage')
      .map((e) => {
        const p = join(brainDir, e.name)
        const logPath = join(p, '.system_generated', 'logs', 'transcript.jsonl')
        let mtime = 0
        try {
          if (fs.existsSync(logPath)) {
            mtime = fs.statSync(logPath).mtimeMs
          } else {
            mtime = fs.statSync(p).mtimeMs
          }
        } catch {
          mtime = 0
        }
        return { name: e.name, path: p, logPath, mtime }
      })
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
      const lastTimeMs = stat.mtimeMs
      const cached = cache.get(logPath)

      // Fast-Stat 命中：未修改的會話完全免讀檔免解析，0.01ms 瞬開
      if (cached && cached.mtime === lastTimeMs) {
        const s: AgentSessionInfo = { ...cached.session }
        const timeSinceLastActive = Date.now() - lastTimeMs
        s.status =
          timeSinceLastActive < 90 * 1000
            ? 'active'
            : timeSinceLastActive < 15 * 60 * 1000
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
              promptTokens += estimateTokens(row.content)
            }
            if (row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE') {
              if (row.thinking) completionTokens += estimateTokens(row.thinking)
              if (row.content) completionTokens += estimateTokens(row.content)
            } else if (row.type === 'RUN_COMMAND' || row.type === 'VIEW_FILE' || row.type === 'SYSTEM_MESSAGE') {
              if (row.content) toolTokens += estimateTokens(row.content)
            }
          } catch {
            // ignore malformed line
          }
        }
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
        timeSinceLastActive < 90 * 1000
          ? 'active'
          : timeSinceLastActive < 15 * 60 * 1000
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
            { category: 'Context & System Prompt', tokens: promptTokens, percentage: promptPct },
            { category: 'Tool Execution & Files', tokens: toolTokens, percentage: toolPct },
            { category: 'Thinking & Generation', tokens: completionTokens, percentage: compPct }
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
 * 讀取 Claude 本地專案日誌與真實 Token 概況（支援 mtime 快速快取）
 */
function scanClaudeSessions(max = 20): AgentSessionInfo[] {
  const projectsDir = join(H, '.claude', 'projects')
  if (!fs.existsSync(projectsDir)) return []

  const list: AgentSessionInfo[] = []
  const cache = loadDashboardCache()

  try {
    const projs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((p) => p.isDirectory())
      .map((p) => {
        const fp = join(projectsDir, p.name)
        return { name: p.name, path: fp, mtime: fs.statSync(fp).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
      // 掃描最近活躍的各專案目錄，絕不隨意 fallback 硬指定其他無關專案
      .slice(0, 10)

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
          const timeSinceLastActive = Date.now() - mtime
          s.status = timeSinceLastActive < 15 * 60 * 1000 ? 'idle' : 'completed'
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
              if (row.message?.usage) {
                const u = row.message.usage
                const inp = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
                if (inp > 0) promptTokens = Math.max(promptTokens, inp)
                if (u.output_tokens) completionTokens += u.output_tokens
              }
              if (row.type === 'tool_use' || row.type === 'tool_result') {
                const len = JSON.stringify(row).length
                toolTokens += Math.ceil(len / 3.5)
              }
            } catch {
              // ignore
            }
          }
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
          timeSinceLastActive < 15 * 60 * 1000
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
              { category: 'Context & System Prompt', tokens: promptTokens, percentage: promptPct },
              { category: 'Tool Execution & Files', tokens: toolTokens, percentage: toolPct },
              { category: 'Thinking & Generation', tokens: completionTokens, percentage: compPct }
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
      s.status = timeSinceLastActive < 15 * 60 * 1000 ? 'idle' : 'completed'
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
          const usage = row.payload?.info?.total_token_usage
          if (usage) {
            cachedTokens = usage.cached_input_tokens || 0
            if (usage.input_tokens || usage.output_tokens) {
              promptTokens = usage.input_tokens || 0
              completionTokens = usage.output_tokens || 0
            } else if (usage.total_tokens) {
              // 某些 resumed/壓縮過的 session，input/output 明細會歸零但 total_tokens
              // 仍保留真實累計值——此時把它算進 prompt，避免整個 session 顯示成 0 token。
              promptTokens = usage.total_tokens
              completionTokens = 0
            }
          }
          const provModel = row.payload?.base_instructions?.provenance?.model
          if (provModel) model = provModel
        } catch {
          // ignore malformed line
        }
      }
    } catch {
      // ignore unreadable rollout file
    }

    const totalTokens = promptTokens + completionTokens
    const promptPct = totalTokens > 0 ? Math.round((promptTokens / totalTokens) * 100) : 85
    const compPct = Math.max(0, 100 - promptPct)
    const cachedPct = promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0

    const sessionObj: AgentSessionInfo = {
      id: f.id,
      agent: 'codex',
      title,
      status: 'completed',
      startTime: new Date(f.mtime - 300000).toISOString(),
      lastActiveTime: new Date(f.mtime).toISOString(),
      totalTokens,
      model,
      workspace: wsName,
      workspacePath: wsPath,
      tokenBreakdown: {
        promptTokens,
        toolReadTokens: 0,
        completionTokens,
        details: [
          { category: 'Context & System Prompt', tokens: promptTokens, percentage: promptPct },
          { category: 'Cached Input Context', tokens: cachedTokens, percentage: cachedPct },
          { category: 'Thinking & Generation', tokens: completionTokens, percentage: compPct }
        ]
      }
    }

    cache.set(f.path, { mtime, session: sessionObj })
    cacheDirty = true
    list.push(sessionObj)
  }

  return list
}

interface DashboardState {
  archivedIds: string[]
  deletedIds: string[]
}

function stateFilePath(): string {
  return join(workspace.root, '.workbench', 'dashboard-state.json')
}

function loadDashboardState(): DashboardState {
  try {
    const p = stateFilePath()
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      return {
        archivedIds: Array.isArray(parsed.archivedIds) ? parsed.archivedIds : [],
        deletedIds: Array.isArray(parsed.deletedIds) ? parsed.deletedIds : []
      }
    }
  } catch {
    // ignore
  }
  return { archivedIds: [], deletedIds: [] }
}

function saveDashboardState(state: DashboardState): void {
  if (!workspace.root || isProtectedPath(workspace.root)) return
  try {
    const p = stateFilePath()
    fs.mkdirSync(join(workspace.root, '.workbench'), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // ignore
  }
}

let activeScanPromise: Promise<DashboardData> | null = null

export function registerDashboardHandlers(): void {
  ipcMain.handle('dashboard:data', async (): Promise<DashboardData> => {
    if (activeScanPromise) {
      return activeScanPromise
    }

    activeScanPromise = (async () => {
      try {
        const state = loadDashboardState()
        const deletedSet = new Set(state.deletedIds)
        const archivedSet = new Set(state.archivedIds)

        // 1. 抓取目前活躍終端 PTY 行程
        const activePty = getActiveSessionMetas()
        const activePtySessions = activePty.filter((p) => !deletedSet.has(p.id))

        // 2. 抓取歷史真實會話記錄（依 Settings 啟用狀態過濾）
        const agySessions = isCliEnabled('antigravity')
          ? scanAntigravitySessions(20)
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

      // 優先 1：若 PTY 帶有明確關聯的 sessionId（例如點擊 resume 或 handoff）
      let matched = p.sessionId ? candidates.find((s) => s.id === p.sessionId && !matchedSet.has(s.id)) : undefined

      // 優先 2：同工作區且在 PTY 啟動前不久或之後活躍之 Session
      if (!matched) {
        matched = candidates.find(
          (s) =>
            !s.isArchived &&
            !matchedSet.has(s.id) &&
            isSameWorkspace(s.workspacePath, s.workspace, targetCwd) &&
            new Date(s.lastActiveTime).getTime() >= p.startTime - 60000
        )
      }

      // 優先 3：同工作區目錄中最新之 Session
      if (!matched) {
        matched = candidates.find(
          (s) =>
            !s.isArchived &&
            !matchedSet.has(s.id) &&
            isSameWorkspace(s.workspacePath, s.workspace, targetCwd)
        )
      }

      if (matched) {
        matchedSet.add(matched.id)
        matched.status = 'active'
        matched.lastActiveTime = new Date().toISOString()
      } else {
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
          isArchived: archivedSet.has(p.id),
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

    // 4. 合併清單：活躍的優先排在最前，其餘依最後活躍時間排序
    const allSessions = [...standaloneSessions, ...agySessions, ...claudeSessions, ...codexSessions].sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1
      if (a.status !== 'active' && b.status === 'active') return 1
      return new Date(b.lastActiveTime).getTime() - new Date(a.lastActiveTime).getTime()
    })

    // 6. 計算各 Agent 真實 Token 統計指標
    const computeAgentUsage = (agentId: AgentId) => {
      const list = allSessions.filter((s) => s.agent === agentId)
      let total = list.reduce((acc, s) => acc + (s.totalTokens || 0), 0)
      let prompt = list.reduce((acc, s) => acc + (s.tokenBreakdown?.promptTokens || 0), 0)
      let tool = list.reduce((acc, s) => acc + (s.tokenBreakdown?.toolReadTokens || 0), 0)
      let comp = list.reduce((acc, s) => acc + (s.tokenBreakdown?.completionTokens || 0), 0)

      if (total > 0 && prompt === 0 && comp === 0) {
        prompt = Math.round(total * 0.73)
        tool = Math.round(total * 0.17)
        comp = Math.max(0, total - prompt - tool)
      }

      const activeCount = list.filter((s) => s.status === 'active').length
      return {
        total,
        prompt,
        tool,
        comp,
        totalSessions: list.length,
        activeSessions: activeCount
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
      sessions: allSessions
    }

        return data
      } finally {
        activeScanPromise = null
        saveDashboardCache()
      }
    })()

    return activeScanPromise
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

  ipcMain.handle('dashboard:deleteSession', async (_e, id: string): Promise<boolean> => {
    const state = loadDashboardState()
    if (!state.deletedIds.includes(id)) {
      state.deletedIds.push(id)
    }
    state.archivedIds = state.archivedIds.filter((x) => x !== id)
    saveDashboardState(state)
    return true
  })
}
