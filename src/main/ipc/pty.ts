import { ipcMain, app, type WebContents } from 'electron'
import { EventEmitter } from 'events'
import * as pty from '@lydell/node-pty'
import { Terminal as ScreenMirror } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import * as crypto from 'crypto'
import { execFileSync } from 'child_process'
import { getWorkspaceForEvent } from '../index'
import { looksLikeApprovalPrompt } from '../../shared/approvalDetect'
import { detectDevPort } from '../../shared/portDetect'
import { resolveConnectionEnv } from './conn'
import type { CliLauncher, PtySpawnOptions } from '../../preload/index'

export interface ActiveSessionMeta {
  id: string
  command: string
  launcherId?: string
  startTime: number
  pid: number
  sessionId?: string
  cwd?: string
  args?: string[]
}

/**
 * 訂閱某個 pty 輸出的一方。桌面視窗是一個 subscriber，遠端控制的手機也是；
 * pty 不再只綁死一個 webContents，才能同時被桌面與手機看到。
 */
export interface PtySubscriber {
  data: (ptyId: string, chunk: string) => void
  exit: (ptyId: string, code: number) => void
  /** 尺寸變了：跟 data 同一條順序送達，接收端照順序 resize 才會跟 main 的畫面一致 */
  resized?: (ptyId: string, cols: number, rows: number) => void
}

interface PtyEntry {
  proc: pty.IPty
  meta: ActiveSessionMeta
  /** 顯示名稱（Claude Code / Codex / 自訂 launcher 名稱…） */
  title: string
  /** 擁有者視窗的 webContents id：視窗關掉時連帶收掉 pty（沿用原本語意） */
  ownerId: number
  workspace: string
  cols: number
  rows: number
  /** 最後一段原始輸出：審批卡片擷取提示文字、dev server 網址偵測用 */
  tail: string
  /**
   * main 自己的終端畫面（headless xterm）。中途接上的 subscriber（手機、桌面 attach）拿它序列化的畫面，
   * 不能重播原始輸出：那些輸出是在各種寬度下畫的，用現在的寬度重播游標定位全錯，TUI 會疊成好幾份。
   */
  screen: ScreenMirror
  serializer: SerializeAddon
  /** Claude Code / Antigravity CLI：改尺寸時會清掉重印整段對話 */
  reprintsOnResize: boolean
  subs: Map<string, PtySubscriber>
  needsApproval: boolean
  lastOutputAt: number
  /** 近期還在吐輸出＝執行中。由 main 判定，遠端直接用，不讓手機拿自己的時鐘去比對 */
  busy: boolean
  busyTimer: NodeJS.Timeout | null
  /** 這個終端印出來的本機 dev server port（手機預覽用） */
  devPort: number | null
  /** 被使用者關掉（而不是自己結束）：遠端不必推播「任務結束」 */
  killed: boolean
}

const TAIL_LIMIT = 16 * 1024
const SCREEN_SCROLLBACK = 5000
/** 停止輸出多久算「閒置」 */
const BUSY_IDLE_MS = 4000

const entries = new Map<string, PtyEntry>()

/** pty 生命週期事件：遠端控制橋接層靠這個推播「待審批」與 session 清單變化 */
export const ptyEvents = new EventEmitter()
ptyEvents.setMaxListeners(50)

export interface PtySessionInfo {
  id: string
  title: string
  command: string
  launcherId?: string
  workspace: string
  ownerId: number
  cwd?: string
  startTime: number
  cols: number
  rows: number
  needsApproval: boolean
  lastOutputAt: number
  /** 近期還在吐輸出（main 判定的「執行中」） */
  busy: boolean
  /** 終端印出的本機 dev server port，沒有就 null */
  devPort: number | null
}

function toInfo(id: string, e: PtyEntry): PtySessionInfo {
  return {
    id,
    title: e.title,
    command: e.meta.command,
    launcherId: e.meta.launcherId,
    workspace: e.workspace,
    ownerId: e.ownerId,
    cwd: e.meta.cwd,
    startTime: e.meta.startTime,
    cols: e.cols,
    rows: e.rows,
    needsApproval: e.needsApproval,
    lastOutputAt: e.lastOutputAt,
    busy: e.busy,
    devPort: e.devPort
  }
}

export function getActiveSessionMetas(): ActiveSessionMeta[] {
  return Array.from(entries.values()).map((e) => e.meta)
}

export function listPtySessions(): PtySessionInfo[] {
  return Array.from(entries.entries()).map(([id, e]) => toInfo(id, e))
}

export function getPtySession(id: string): PtySessionInfo | null {
  const e = entries.get(id)
  return e ? toInfo(id, e) : null
}

/**
 * 訂閱 pty 輸出；回傳目前畫面（含捲動歷史）讓呼叫端先補上。找不到 pty 回 null。
 * subscriber 只在 screen 處理完某段輸出後才收到那段（見 feed），所以此刻序列化的畫面
 * 剛好涵蓋「之前送過的全部」，之後的輸出一段不漏、也不重複。
 */
export function subscribePty(
  id: string,
  key: string,
  sub: PtySubscriber
): { data: string; cols: number; rows: number } | null {
  const e = entries.get(id)
  if (!e) return null
  e.subs.set(key, sub)
  return { data: e.serializer.serialize({ scrollback: SCREEN_SCROLLBACK }), cols: e.screen.cols, rows: e.screen.rows }
}

/** 最後一段原始輸出（不訂閱），給審批卡片擷取提示文字用 */
export function getPtyScrollback(id: string): string | null {
  return entries.get(id)?.tail ?? null
}

/** 依序送進 screen；screen 處理完才轉給 subscriber，screen 永遠不落後任何 subscriber */
function feed(e: PtyEntry, data: string, deliver: (sub: PtySubscriber) => void): void {
  e.screen.write(data, () => {
    for (const sub of e.subs.values()) deliver(sub)
  })
}

/**
 * Windows ConPTY 改尺寸後一定整頁重畫可見區，所以先清掉可見區：舊畫面不會被 reflow 折行、推進捲動歷史變成殘片。
 * Claude Code / Antigravity 改尺寸時會清掉重印整段對話（2026-10 實錄 ConPTY 輸出確認），但 ConPTY 不轉送
 * 「清除捲動歷史」，舊的那份會留在歷史裡變成重複，所以連捲動歷史一起清，留下的就是它重印的那一份。
 * ponytail: 靠 CLI 種類判斷；哪天 CLI 改成不重印，這裡會清掉它的歷史，要改成偵測重印。
 */
function resizePrelude(e: PtyEntry): string {
  if (process.platform !== 'win32') return ''
  return e.reprintsOnResize ? '\x1b[H\x1b[2J\x1b[3J' : '\x1b[H\x1b[2J'
}

export function unsubscribePty(id: string, key: string): void {
  entries.get(id)?.subs.delete(key)
}

export function writePty(id: string, data: string): boolean {
  const e = entries.get(id)
  if (!e) return false
  e.proc.write(data)
  // 有人輸入就代表在回應提示，清掉待審批狀態
  if (e.needsApproval) {
    e.needsApproval = false
    ptyEvents.emit('changed')
  }
  return true
}

export function resizePty(id: string, cols: number, rows: number): void {
  const e = entries.get(id)
  if (!e || cols < 2 || rows < 2 || (cols === e.cols && rows === e.rows)) return
  try {
    e.proc.resize(cols, rows)
  } catch {
    return
  }
  e.cols = cols
  e.rows = rows
  // ConPTY 的重畫下一輪事件才會進 onData，這裡同步排進去就一定排在它前面
  const prelude = resizePrelude(e)
  if (prelude) feed(e, prelude, (sub) => sub.data(id, prelude))
  e.screen.write('', () => {
    e.screen.resize(cols, rows)
    for (const sub of e.subs.values()) sub.resized?.(id, cols, rows)
  })
}

export function killPty(id: string): void {
  const e = entries.get(id)
  if (!e) return
  e.killed = true
  hardKill(e.proc)
  finish(id, e, -1)
}

export function cleanupPtyForWindow(webContentsId: number): void {
  for (const [id, e] of Array.from(entries.entries())) {
    if (e.ownerId === webContentsId) {
      e.killed = true
      hardKill(e.proc)
      finish(id, e, -1)
    }
  }
}

/** 從表中移除並發出 exit 事件；onExit 與視窗關閉都可能呼叫，只處理一次 */
function finish(id: string, e: PtyEntry, code: number): void {
  if (entries.get(id) !== e) return
  if (e.busyTimer) {
    clearTimeout(e.busyTimer)
    e.busyTimer = null
  }
  e.busy = false
  entries.delete(id)
  // 排在還沒處理完的輸出後面，subscriber 才收得到最後幾段
  e.screen.write('', () => e.screen.dispose())
  ptyEvents.emit('exit', id, code, e.title, e.killed)
  ptyEvents.emit('changed')
}

/** 桌面視窗當 subscriber：送到 `pty:data:<id>` / `pty:exit:<id>` 頻道（renderer 端契約不變） */
function webContentsSubscriber(wc: WebContents): PtySubscriber {
  // 視窗被關掉後 pty 不一定跟著結束（例如彈出的終端視窗），
  // 對已銷毀的 webContents 呼叫 .send() 會讓整個 main process 崩潰，所以一律先檢查。
  return {
    data: (id, chunk) => {
      try {
        if (!wc.isDestroyed()) wc.send(`pty:data:${id}`, chunk)
      } catch {
        // ignore destroyed sender
      }
    },
    resized: (id, cols, rows) => {
      try {
        if (!wc.isDestroyed()) wc.send(`pty:resized:${id}`, cols, rows)
      } catch {
        // ignore destroyed sender
      }
    },
    exit: (id, code) => {
      try {
        if (!wc.isDestroyed()) wc.send(`pty:exit:${id}`, code)
      } catch {
        // ignore destroyed sender
      }
    }
  }
}

const isWin = process.platform === 'win32'

/**
 * 確實終止 pty 及其子行程。
 *
 * 為什麼不能只靠 node-pty 的 kill()：Windows 上它會先 fork
 * conpty_console_list_agent 去列舉 console 行程，而該 helper 在 Electron 下
 * 會以「AttachConsole failed」崩潰；node-pty 因此要等滿 5 秒 timeout 才真的動手。
 * 結果是關終端後 shell 還多活 5 秒，關 app 時更直接留下孤兒行程。
 * 所以這裡先自己把 process tree 殺掉，再呼叫 kill() 收尾釋放 handle。
 */
function hardKill(p: pty.IPty): void {
  const pid = p.pid
  try {
    if (isWin) {
      // /T 連子行程一起、/F 強制；已結束的 pid 會回非 0，忽略即可
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    /* 行程已不在就忽略 */
  }
  try {
    p.kill()
  } catch {
    /* 已被 taskkill 帶走時會丟例外，忽略 */
  }
}

import { getCustomCliPath, isCliBypassPermissions } from './settings'
import { findAgentCli } from '../ext/paths'
import type { AgentId } from '../../preload/index'

/**
 * 依 Agent 類別取得 Bypass Mode 所需的命令列參數：
 * - Claude Code: claude --permission-mode bypassPermissions
 * - Codex: codex --dangerously-bypass-approvals-and-sandbox
 * - Antigravity: agy --dangerously-skip-permissions
 */
export function getAgentBypassArgs(agent: string): string[] {
  const a = agent.toLowerCase()
  if (a === 'claude' || a.includes('claude')) {
    return ['--permission-mode', 'bypassPermissions']
  }
  if (a === 'codex' || a.includes('codex')) {
    return ['--dangerously-bypass-approvals-and-sandbox']
  }
  if (a === 'antigravity' || a === 'agy' || a.includes('agy') || a.includes('antigravity')) {
    return ['--dangerously-skip-permissions']
  }
  return []
}

export function applyAgentBypassArgs(agent: string, currentArgs: string[]): string[] {
  const bypassArgs = getAgentBypassArgs(agent)
  if (bypassArgs.length === 0) return currentArgs

  const result = [...currentArgs]
  const a = agent.toLowerCase()
  if (a === 'claude' || a.includes('claude')) {
    if (!result.includes('--permission-mode')) {
      result.push(...bypassArgs)
    }
  } else if (a === 'codex' || a.includes('codex')) {
    if (!result.includes('--dangerously-bypass-approvals-and-sandbox')) {
      result.push(...bypassArgs)
    }
  } else if (a === 'antigravity' || a === 'agy' || a.includes('agy') || a.includes('antigravity')) {
    if (!result.includes('--dangerously-skip-permissions')) {
      result.push(...bypassArgs)
    }
  }
  return result
}

/**
 * 依 Agent 類別套用預設通用參數：
 * - Codex: 注入 --no-alt-screen 停用備用螢幕緩衝區，改為 inline 串流模式以完整保留 scrollback 歷史
 */
export function applyAgentDefaultArgs(commandOrAgent: string, currentArgs: string[], targetAgent?: AgentId | null): string[] {
  const result = [...currentArgs]
  const isCodex = targetAgent === 'codex' || commandOrAgent.toLowerCase().includes('codex')
  if (isCodex && !result.includes('--no-alt-screen')) {
    result.push('--no-alt-screen')
  }
  return result
}

/**
 * 邏輯名稱 → 實際執行檔與前置參數。
 * 優先讀取 settings 中的自訂路徑，Windows 腳本自動帶起正確的解譯器。
 */
function resolveCommand(name: string): { cmd: string; extraArgs: string[] } {
  const isAgent = name === 'claude' || name === 'antigravity' || name === 'codex'
  let custom = getCustomCliPath(name)
  let target = custom || name

  if (!custom) {
    if (isAgent) {
      const detected = findAgentCli(name as AgentId)
      if (detected) {
        target = detected
      } else if (name === 'antigravity') {
        target = 'agy'
      }
    } else {
      switch (name) {
        case 'powershell':
          target = isWin ? 'powershell.exe' : 'pwsh'
          break
        case 'pwsh':
          target = 'pwsh'
          break
        case 'cmd':
          target = isWin ? 'cmd.exe' : 'sh'
          break
        case 'bash':
          target = 'bash'
          break
      }
    }
  }

  // Windows 平台相容性處理 (.ps1, .cmd, .bat, .exe)
  if (isWin) {
    const lower = target.toLowerCase()
    if (!lower.endsWith('.exe') && !lower.endsWith('.cmd') && !lower.endsWith('.bat') && !lower.endsWith('.ps1')) {
      if (fs.existsSync(`${target}.cmd`)) target = `${target}.cmd`
      else if (fs.existsSync(`${target}.exe`)) target = `${target}.exe`
      else if (fs.existsSync(`${target}.bat`)) target = `${target}.bat`
      else if (fs.existsSync(`${target}.ps1`)) target = `${target}.ps1`
    }

    if (target.toLowerCase().endsWith('.ps1')) {
      return { cmd: 'powershell.exe', extraArgs: ['-ExecutionPolicy', 'Bypass', '-File', target] }
    }
    if (target.toLowerCase().endsWith('.cmd') || target.toLowerCase().endsWith('.bat')) {
      return { cmd: 'cmd.exe', extraArgs: ['/c', target] }
    }
  }

  return { cmd: target, extraArgs: [] }
}

app.on('before-quit', () => {
  for (const e of entries.values()) hardKill(e.proc)
  entries.clear()
})

const BUILTIN_TITLES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  cmd: 'Command Prompt',
  bash: 'Bash'
}

// agents/*.yaml 跟著 repo 走，所以它是「不受信任的輸入」：
// 只能從已知的 CLI 裡挑一個，不能自己指定要跑哪個執行檔。
const KNOWN_CLI = new Set(['claude', 'codex', 'antigravity', 'powershell', 'pwsh', 'cmd', 'bash'])

// 這些環境變數能在別人的行程裡插入程式碼（NODE_OPTIONS --require、PATH 換掉執行檔…），
// 就算 cli 本身是正牌的官方 CLI 也一樣，所以 yaml 不准碰。
const BLOCKED_ENV = /^(NODE_OPTIONS|NODE_REPL_EXTERNAL_MODULE|PATH|LD_PRELOAD|LD_AUDIT|LD_LIBRARY_PATH|DYLD_.*|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|RUBYOPT|ELECTRON_RUN_AS_NODE|BASH_ENV|ENV)$/i

function sanitizeLauncherEnv(env: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!env || typeof env !== 'object') return out
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (BLOCKED_ENV.test(k)) {
      console.warn(`[pty] launcher env ${k} ignored: not allowed from agents/*.yaml`)
      continue
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
  }
  return out
}

/** 讀取工作區 agents/*.yaml 的 launcher 定義（已過濾成安全的形狀） */
function readLauncherDefs(ws: string): Array<{ id: string; name: string; cli: string; args: string[]; env: Record<string, string> }> {
  const agentsDir = path.join(ws, 'agents')
  if (!ws || !fs.existsSync(agentsDir)) return []
  const out: Array<{ id: string; name: string; cli: string; args: string[]; env: Record<string, string> }> = []
  try {
    for (const file of fs.readdirSync(agentsDir)) {
      if (file.endsWith('.yaml') || file.endsWith('.yml')) {
        const content = fs.readFileSync(path.join(agentsDir, file), 'utf8')
        const parsed = yaml.load(content) as any
        const l = parsed?.launcher
        if (!l || typeof l.id !== 'string' || !l.id) continue
        if (typeof l.cli !== 'string' || !KNOWN_CLI.has(l.cli)) {
          console.warn(`[pty] launcher ${l.id} skipped: cli "${l.cli}" is not one of ${[...KNOWN_CLI].join(', ')}`)
          continue
        }
        out.push({
          id: l.id,
          name: typeof l.name === 'string' && l.name ? l.name : l.id,
          cli: l.cli,
          args: Array.isArray(l.args) ? l.args.filter((a: unknown): a is string => typeof a === 'string') : [],
          env: sanitizeLauncherEnv(l.env)
        })
      }
    }
  } catch (e) {
    console.error('Error reading launchers:', e)
  }
  return out
}

export function listLaunchers(ws: string): CliLauncher[] {
  return readLauncherDefs(ws).map((l) => {
    const r = resolveCommand(l.cli)
    let launcherArgs = [...r.extraArgs, ...(l.args || [])]
    if (isCliBypassPermissions()) {
      launcherArgs = applyAgentBypassArgs(l.cli, launcherArgs)
    }
    return {
      id: l.id,
      name: l.name,
      cli: l.cli,
      command: r.cmd,
      args: launcherArgs,
      env: l.env || {},
      // yaml 自己有加參數或環境變數才算「真的自訂」。沒有的話它只是內建 CLI 的別名，
      // 呼叫端可以不要重複列出（手機上會變成兩個一模一樣的「Claude Code」）。
      hasExtras: (l.args || []).length > 0 || Object.keys(l.env || {}).length > 0
    }
  })
}

/**
 * 啟動一個 pty 並登記到共用表。桌面 renderer（pty:spawn）與遠端控制（手機開新終端）共用這一條路。
 * owner 是擁有者視窗的 webContents：視窗關閉時 pty 跟著收掉。
 */
export function spawnPty(
  opts: PtySpawnOptions,
  ctx: { workspace: string; owner: WebContents; subscribeOwner: boolean }
): string {
  let resolved = opts.command ? resolveCommand(opts.command) : { cmd: isWin ? 'cmd.exe' : 'bash', extraArgs: [] }
  let command = resolved.cmd
  let args = [...resolved.extraArgs, ...(opts.args || [])]
  let env = { ...process.env }
  let targetAgent: AgentId | null = null
  let title = opts.title || (opts.command ? BUILTIN_TITLES[opts.command] || opts.command : 'Shell')

  if (opts.command === 'claude' || opts.command === 'antigravity' || opts.command === 'codex') {
    targetAgent = opts.command as AgentId
  }

  if (opts.launcherId) {
    const l = readLauncherDefs(ctx.workspace).find((x) => x.id === opts.launcherId)
    if (l) {
      const r = resolveCommand(l.cli)
      command = r.cmd
      // opts.args 要留著：resume 用的 --resume/--conversation 是從這裡進來的，
      // 覆蓋掉的話自訂 launcher 開的會話永遠是全新對話。
      args = [...r.extraArgs, ...(l.args || []), ...(opts.args || [])]
      env = { ...env, ...(l.env || {}) }
      if (l.cli === 'claude' || l.cli === 'antigravity' || l.cli === 'codex') {
        targetAgent = l.cli as AgentId
      }
      if (!opts.title && l.name) title = l.name
    }
  }

  // 若啟用 CLI 略過權限模式 (Bypass Permissions Mode)，依據 Agent 類別自動注入 bypass 參數
  if (isCliBypassPermissions()) {
    if (targetAgent) {
      args = applyAgentBypassArgs(targetAgent, args)
    } else {
      const cmdLower = (opts.command || command).toLowerCase()
      if (cmdLower.includes('claude')) {
        args = applyAgentBypassArgs('claude', args)
      } else if (cmdLower.includes('codex')) {
        args = applyAgentBypassArgs('codex', args)
      } else if (cmdLower.includes('antigravity') || cmdLower.includes('agy')) {
        args = applyAgentBypassArgs('antigravity', args)
      }
    }
  }

  // Agent 通用預設參數注入（例如 Codex 自動注入 --no-alt-screen 保留 scrollback 歷史）
  args = applyAgentDefaultArgs(opts.command || command, args, targetAgent)
  // Claude Code 的 fullscreen TUI（settings "tui": "fullscreen"）走備用螢幕＋滑鼠模式：沒有 scrollback、游標停在畫面中段，
  // 手機只看得到一頁且審批選項解析不到。等同 Codex 的 --no-alt-screen；launcher 自己有設就尊重。
  const isClaude = targetAgent === 'claude' || (opts.command || command).toLowerCase().includes('claude')
  if (isClaude) {
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN ??= '1'
  }

  // 憑證只在此刻注入：MCP server 由 CLI 子行程繼承 env 取得，
  // 因此不需要（也不該）把明文寫進任何 agent 設定檔。
  env = { ...env, ...resolveConnectionEnv() }

  // 防禦處理：若呼叫 agy / antigravity CLI 且帶有 --conversation <id>，
  // 檢查該 session 是否在 CLI 本地資料庫 (~/.gemini/antigravity-cli/conversations/) 中。
  // 若為 IDE 專屬 session 或不存在的 CLI 紀錄，過濾掉 --conversation 避免 agy 印出 'warning: conversation "<id>" not found'
  const cmdLower = command.toLowerCase()
  const isAntigravity = targetAgent === 'antigravity' || cmdLower.includes('agy') || opts.command === 'antigravity' || opts.launcherId === 'antigravity'
  if (isAntigravity) {
    const convIdx = args.indexOf('--conversation')
    if (convIdx !== -1 && args[convIdx + 1]) {
      const targetId = args[convIdx + 1]
      const H = process.env.USERPROFILE || process.env.HOME || ''
      const cliDb = path.join(H, '.gemini', 'antigravity-cli', 'conversations', `${targetId}.db`)
      if (!fs.existsSync(cliDb)) {
        // 移除 --conversation 及該 ID
        args.splice(convIdx, 2)
      }
    }
  }

  const id = crypto.randomUUID()
  const cols = opts.cols || 80
  const rows = opts.rows || 24

  const ws = ctx.workspace
  const spawnCwd =
    opts.cwd && fs.existsSync(opts.cwd)
      ? opts.cwd
      : ws && fs.existsSync(ws)
        ? ws
        : process.env.USERPROFILE || process.env.HOME || process.cwd()
  const ptyProcess = pty.spawn(command, args, {
    name: 'xterm-color',
    cols,
    rows,
    cwd: spawnCwd,
    env: env as Record<string, string>
  })

  const entry: PtyEntry = {
    proc: ptyProcess,
    meta: {
      id,
      command: opts.command || opts.launcherId || 'shell',
      launcherId: opts.launcherId,
      startTime: Date.now(),
      pid: ptyProcess.pid,
      sessionId: opts.sessionId,
      cwd: spawnCwd,
      args
    },
    title,
    ownerId: ctx.owner.id,
    workspace: ws,
    cols,
    rows,
    tail: '',
    // windowsPty：ConPTY 長高時是在底下補空行（不是把歷史拉回畫面），照它的行為算才不會被重畫蓋掉歷史
    screen: new ScreenMirror({ cols, rows, scrollback: SCREEN_SCROLLBACK, allowProposedApi: true, windowsPty: { backend: 'conpty' } }),
    serializer: new SerializeAddon(),
    reprintsOnResize: isClaude || isAntigravity,
    subs: new Map(),
    needsApproval: false,
    lastOutputAt: Date.now(),
    busy: false,
    busyTimer: null,
    devPort: null,
    killed: false
  }
  entry.screen.loadAddon(entry.serializer as unknown as Parameters<ScreenMirror['loadAddon']>[0])
  if (ctx.subscribeOwner) entry.subs.set(`wc:${ctx.owner.id}`, webContentsSubscriber(ctx.owner))
  entries.set(id, entry)

  ptyProcess.onData((data) => {
    entry.lastOutputAt = Date.now()
    entry.tail = (entry.tail + data).slice(-TAIL_LIMIT)
    feed(entry, data, (sub) => sub.data(id, data))

    // 「執行中／閒置」由 main 判定後廣播（只在狀態翻轉時發），
    // 否則遠端只能拿手機自己的時鐘去比 lastOutputAt：時鐘有偏差就永遠顯示錯，
    // 而且 state 不是每次輸出都重送，閒置與執行中會卡在舊值。
    if (!entry.busy) {
      entry.busy = true
      ptyEvents.emit('activity', id, true)
    }
    if (entry.busyTimer) clearTimeout(entry.busyTimer)
    entry.busyTimer = setTimeout(() => {
      entry.busyTimer = null
      entry.busy = false
      ptyEvents.emit('activity', id, false)
    }, BUSY_IDLE_MS)
    entry.busyTimer.unref?.()

    // dev server 網址：看 scrollback 尾段而不是單一 chunk，
    // 否則 Vite 那行被切成兩塊時就抓不到 port。
    const port = detectDevPort(entry.tail.slice(-4000))
    if (port && port !== entry.devPort) {
      entry.devPort = port
      ptyEvents.emit('changed')
    }

    // 待審批偵測：false→true 才發事件，避免同一個提示連發推播
    if (!entry.needsApproval && looksLikeApprovalPrompt(data)) {
      entry.needsApproval = true
      ptyEvents.emit('approval', id)
      ptyEvents.emit('changed')
    }
  })

  ptyProcess.onExit(({ exitCode }) => {
    feed(entry, '', (sub) => sub.exit(id, exitCode))
    finish(id, entry, exitCode)
  })

  ptyEvents.emit('changed')
  return id
}

export function registerPtyHandlers(): void {
  ipcMain.handle('pty:launchers', async (event) => {
    return listLaunchers(getWorkspaceForEvent(event))
  })

  ipcMain.handle('pty:spawn', async (event, opts: PtySpawnOptions) => {
    try {
      return spawnPty(opts, {
        workspace: getWorkspaceForEvent(event),
        owner: event.sender,
        subscribeOwner: true
      })
    } catch (e: any) {
      throw new Error(`Failed to spawn terminal: ${e.message}`)
    }
  })

  // 接上一個已存在的 pty（例如手機開的終端要出現在桌面分頁）：回傳 scrollback 並開始轉送輸出
  ipcMain.handle('pty:attach', async (event, id: string) => {
    const wc = event.sender
    const snap = subscribePty(id, `wc:${wc.id}`, webContentsSubscriber(wc))
    return snap && { snapshot: snap.data, cols: snap.cols, rows: snap.rows }
  })

  ipcMain.on('pty:write', (_event, id: string, data: string) => {
    writePty(id, data)
  })

  ipcMain.on('pty:resize', (_event, id: string, cols: number, rows: number) => {
    resizePty(id, cols, rows)
  })

  ipcMain.handle('pty:pipe', async (_event, _fromId: string, toId: string, text: string): Promise<boolean> => {
    const msg = text.endsWith('\r') || text.endsWith('\n') ? text : `${text}\r\n`
    return writePty(toId, msg)
  })

  ipcMain.on('pty:kill', (_event, id: string) => {
    killPty(id)
  })
}
