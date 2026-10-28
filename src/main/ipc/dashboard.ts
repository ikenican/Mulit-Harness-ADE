import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { join, basename, dirname } from 'path'
import { homedir } from 'os'
import type { Worker } from 'worker_threads'
import { getActiveSessionMetas } from './pty'
import { getAllProjectWindows } from '../index'
import {
  isCliEnabled,
  isProtectedPath,
  getRecentWorkspaces,
  addRecentWorkspace,
  removeRecentWorkspace,
  notifyJumpListUpdate,
  setOnRecentWorkspaceAdded
} from './settings'
import type { AgentId, BgTask, DashboardData, AgentSessionInfo, DashboardWorkspaceInfo } from '../../preload/index'
import { scanAllUsage, setUsageDataDir } from './usage'
import { claudeBgTasks, codexBgTasks, antigravityBgTasks } from './bgTasksParse'
import {
  normalizePath,
  isSameWorkspace,
  extractAntigravityWorkspace,
  extractClaudeWorkspace,
  normalizeForClaude,
  findCodexRolloutFiles,
  loadDashboardCache,
  invalidateSessionCache,
  setScanContext,
  scanDashboard,
  type DashboardScan
} from './sessionScan'
import createScanWorker from './dashboardWorker?nodeWorker'

const H = homedir()

/** 最近開啟＋各開啟中視窗的工作區：Antigravity 紀錄歸屬工作區時的兜底比對 */
function knownWorkspaces(): string[] {
  return [...getRecentWorkspaces(), ...getAllProjectWindows().map((w) => w.workspaceRoot)]
}

// ── 掃描放在 worker thread：讀上百個紀錄檔時 main process（所有 IPC 與視窗事件）不會卡住 ──
// worker 起不來或掛掉就退回在 main 直接掃（結果相同，只是會卡），下次再試著重開 worker。

type WorkerReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }

let scanWorker: Worker | null = null
let workerBroken = false
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
/** 最近一次掃描後快取裡的全部 session；快取被清掉時為 null（與搬進 worker 前的 memCache 對應） */
let lastCachedSessions: AgentSessionInfo[] | null = null

function failPending(err: Error): void {
  for (const p of pending.values()) p.reject(err)
  pending.clear()
}

function getScanWorker(): Worker | null {
  if (scanWorker || workerBroken) return scanWorker
  try {
    const w = createScanWorker({ workerData: { dataDir: app.getPath('userData') } })
    w.on('message', (m: WorkerReply) => {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.ok) p.resolve(m.value)
      else p.reject(new Error(m.error))
    })
    w.on('error', (e) => {
      console.error('[Dashboard] scan worker error:', e)
      failPending(e instanceof Error ? e : new Error(String(e)))
    })
    w.on('exit', (code) => {
      if (scanWorker === w) scanWorker = null
      failPending(new Error(`scan worker exited (${code})`))
    })
    w.unref()
    scanWorker = w
  } catch (e) {
    // 建不起來（例如打包後找不到 worker 檔）就不要每次都重試
    console.error('[Dashboard] scan worker unavailable, scanning on the main thread:', e)
    workerBroken = true
  }
  return scanWorker
}

function inWorker<T>(msg: Record<string, unknown>): Promise<T> | null {
  const w = getScanWorker()
  if (!w) return null
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    w.postMessage({ ...msg, id })
  })
}

async function runDashboardScan(enabled: { claude: boolean; codex: boolean }): Promise<DashboardScan> {
  const job = inWorker<DashboardScan>({ type: 'scan', enabled, known: knownWorkspaces() })
  if (job) {
    try {
      return await job
    } catch (e) {
      console.error('[Dashboard] scan worker failed, scanning on the main thread:', e)
    }
  }
  return scanDashboard(enabled)
}

async function runUsageScan(): Promise<ReturnType<typeof scanAllUsage>> {
  const job = inWorker<ReturnType<typeof scanAllUsage>>({ type: 'usage' })
  if (job) {
    try {
      return await job
    } catch (e) {
      console.error('[Dashboard] usage worker failed, scanning on the main thread:', e)
    }
  }
  return scanAllUsage()
}

// main 這份（unmarkDeletedOrArchivedWorkspace、掃描退回 main 時）用即時的工作區清單
setScanContext({ knownWorkspaces })

export function invalidateDashboardMemoryCache(): void {
  lastCachedSessions = null
  invalidateSessionCache()
  scanWorker?.postMessage({ type: 'invalidate' })
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

    if (lastCachedSessions) {
      for (const s of lastCachedSessions) {
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

const bgCache = new Map<string, { mtimeMs: number; tasks: BgTask[] }>()
/** 路徑比對用：斜線統一、小寫、去尾斜線（JSON 跳脫過的 \\\\ 也會收成一個 /） */
const normPath = (s: string): string => s.replace(/[\\/]+/g, '/').toLowerCase().replace(/\/$/, '')

function listFiles(dir: string, filter: (name: string) => boolean): string[] {
  try {
    return fs.readdirSync(dir).filter(filter).map((n) => join(dir, n))
  } catch {
    return []
  }
}

/** 這個工作區 12 小時內有寫入的 Claude／Codex／Antigravity 會話裡的背景任務（新到舊） */
export function scanBgTasks(workspacePath: string): BgTask[] {
  const root = normPath(workspacePath)
  if (!root) return []
  // ponytail: 會話中途被關掉的任務不會有結束通知，最多卡成「執行中」12 小時；要精準再比對 live 會話 id
  const since = Date.now() - 12 * 3600_000
  const sources: { files: string[]; parse: (text: string) => BgTask[]; belongs: (text: string) => boolean }[] = []

  // Claude：~/.claude/projects/<工作區 slug>/*.jsonl，目錄本身就代表工作區
  const projectsDir = join(H, '.claude', 'projects')
  const slug = normalizeForClaude(workspacePath.replace(/[\\/]+$/, '')).toLowerCase()
  const claudeDir = listFiles(projectsDir, (n) => n.toLowerCase() === slug)[0]
  if (claudeDir) sources.push({ files: listFiles(claudeDir, (n) => n.endsWith('.jsonl')), parse: claudeBgTasks, belongs: () => true })

  // Codex：第一行 session_meta 的 cwd
  sources.push({
    files: findCodexRolloutFiles(30).filter((f) => f.mtime >= since).map((f) => f.path),
    parse: codexBgTasks,
    belongs: (text) => {
      try {
        const cwd = normPath(JSON.parse(text.slice(0, text.indexOf('\n'))).payload?.cwd || '')
        return cwd === root || cwd.startsWith(root + '/')
      } catch {
        return false
      }
    }
  })

  // Antigravity：沒有固定的 cwd 欄位，以工具參數裡出現過這個工作區路徑為準
  sources.push({
    files: ['antigravity-ide', 'antigravity-cli', 'antigravity'].flatMap((d) =>
      listFiles(join(H, '.gemini', d, 'brain'), (n) => !n.startsWith('.')).map((p) =>
        join(p, '.system_generated', 'logs', 'transcript.jsonl')
      )
    ),
    parse: antigravityBgTasks,
    belongs: (text) => normPath(text).includes(root)
  })

  const out: BgTask[] = []
  for (const { files, parse, belongs } of sources) {
    for (const p of files) {
      try {
        const { mtimeMs } = fs.statSync(p)
        if (mtimeMs < since) continue
        const key = `${root}|${p}`
        let c = bgCache.get(key)
        if (c?.mtimeMs !== mtimeMs) {
          const text = fs.readFileSync(p, 'utf8')
          bgCache.set(key, (c = { mtimeMs, tasks: belongs(text) ? parse(text) : [] }))
        }
        out.push(...c.tasks)
      } catch {
        // 不存在、寫入中或被刪，跳過
      }
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function registerDashboardHandlers(): void {
  // 掃描退回 main 執行時用的快取位置（worker 由 workerData 拿到同一個路徑）
  setScanContext({ dataDir: app.getPath('userData') })
  setUsageDataDir(app.getPath('userData'))

  ipcMain.handle('dashboard:bgTasks', (_e, workspacePath: string) => scanBgTasks(workspacePath || ''))
  // 只要 token 用量（Vibe 終端上方狀態列用），不跑整套 session 掃描
  ipcMain.handle('dashboard:usage', () => runUsageScan())

  // 掃描現在是非同步的（worker），多個視窗同時輪詢時共用進行中的那一次
  let inflight: Promise<DashboardData> | null = null

  ipcMain.handle('dashboard:data', async (_e, force?: boolean): Promise<DashboardData> => {
    if (!force && inflight) return inflight
    if (force) invalidateDashboardMemoryCache()

    const runScan = async (): Promise<DashboardData> => {
        // 2. 抓取歷史真實會話記錄（依 Settings 啟用狀態過濾）——讀檔都在 worker
        const scan = await runDashboardScan({ claude: isCliEnabled('claude'), codex: isCliEnabled('codex') })
        lastCachedSessions = scan.cached

        // 封存／刪除標記與活躍 PTY 在掃描「之後」才讀：掃描期間使用者的操作也算進這次結果
        const state = loadDashboardState()
        const deletedSet = new Set(state.deletedIds)
        const archivedSet = new Set(state.archivedIds)

        // 1. 抓取目前活躍終端 PTY 行程
        const activePtySessions = getActiveSessionMetas()

        const agyBrainSessions = scan.agyBrain
        const agyCliSessions = scan.agyCli
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

    const claudeSessions = scan.claude
      .filter((s) => !deletedSet.has(s.id))
      .map((s) => ({ ...s, isArchived: archivedSet.has(s.id) }))

    const codexSessions = scan.codex
      .filter((s) => !deletedSet.has(s.id))
      .map((s) => ({ ...s, isArchived: archivedSet.has(s.id) }))

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
      const targetCwd = p.cwd || ''

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
    // 「目前工作區」由各視窗 renderer 用自己的 workspaceRoot 判斷；main 只知道聚焦視窗，不可在此標記
    const userWorkspacesList: DashboardWorkspaceInfo[] = [
      ...activeUserPaths.map((p) => ({ path: p, name: basename(p) || p, isArchived: false })),
      ...archivedUserPaths.map((p) => ({ path: p, name: basename(p) || p, isArchived: true }))
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

    // 6. Token 用量：worker 掃完整歷史（見 sessionScan.scanDashboard）
    const usageByRange = scan.usage
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
    }

    const p = runScan().finally(() => {
      if (inflight === p) inflight = null
    })
    inflight = p
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
        if (lastCachedSessions) {
          for (const s of lastCachedSessions) {
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

        if (lastCachedSessions) {
          for (const s of lastCachedSessions) {
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
      if (lastCachedSessions) {
        for (const s of lastCachedSessions) {
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
