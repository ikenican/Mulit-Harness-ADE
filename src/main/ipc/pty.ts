import { ipcMain, app, type WebContents } from 'electron'
import { EventEmitter } from 'events'
import * as pty from '@lydell/node-pty'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import * as crypto from 'crypto'
import { execFileSync } from 'child_process'
import { getWorkspaceForEvent } from '../index'
import { looksLikeApprovalPrompt } from '../../shared/approvalDetect'
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
  /** 最後一段輸出，給中途接上的 subscriber（例如手機）補畫面 */
  scrollback: string
  subs: Map<string, PtySubscriber>
  needsApproval: boolean
  lastOutputAt: number
  /** 被使用者關掉（而不是自己結束）：遠端不必推播「任務結束」 */
  killed: boolean
}

const SCROLLBACK_LIMIT = 256 * 1024

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
    lastOutputAt: e.lastOutputAt
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

/** 訂閱 pty 輸出；回傳目前的 scrollback 讓呼叫端先補畫面。找不到 pty 回 null。 */
export function subscribePty(id: string, key: string, sub: PtySubscriber): string | null {
  const e = entries.get(id)
  if (!e) return null
  e.subs.set(key, sub)
  return e.scrollback
}

/** 目前的 scrollback（不訂閱），給審批卡片擷取提示文字用 */
export function getPtyScrollback(id: string): string | null {
  return entries.get(id)?.scrollback ?? null
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
  if (!e || cols < 2 || rows < 2) return
  try {
    e.proc.resize(cols, rows)
    e.cols = cols
    e.rows = rows
    ptyEvents.emit('resized', id, cols, rows)
  } catch {
    // ignore
  }
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
  entries.delete(id)
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

/** 讀取工作區 agents/*.yaml 的 launcher 定義（原始 yaml 物件） */
function readLauncherDefs(ws: string): any[] {
  const agentsDir = path.join(ws, 'agents')
  if (!ws || !fs.existsSync(agentsDir)) return []
  const out: any[] = []
  try {
    for (const file of fs.readdirSync(agentsDir)) {
      if (file.endsWith('.yaml') || file.endsWith('.yml')) {
        const content = fs.readFileSync(path.join(agentsDir, file), 'utf8')
        const parsed = yaml.load(content) as any
        if (parsed && parsed.launcher) out.push(parsed.launcher)
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
      env: l.env || {}
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

  // 憑證只在此刻注入：MCP server 由 CLI 子行程繼承 env 取得，
  // 因此不需要（也不該）把明文寫進任何 agent 設定檔。
  env = { ...env, ...resolveConnectionEnv() }

  // 防禦處理：若呼叫 agy / antigravity CLI 且帶有 --conversation <id>，
  // 檢查該 session 是否在 CLI 本地資料庫 (~/.gemini/antigravity-cli/conversations/) 中。
  // 若為 IDE 專屬 session 或不存在的 CLI 紀錄，過濾掉 --conversation 避免 agy 印出 'warning: conversation "<id>" not found'
  const cmdLower = command.toLowerCase()
  if (cmdLower.includes('agy') || opts.command === 'antigravity' || opts.launcherId === 'antigravity') {
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
    scrollback: '',
    subs: new Map(),
    needsApproval: false,
    lastOutputAt: Date.now(),
    killed: false
  }
  if (ctx.subscribeOwner) entry.subs.set(`wc:${ctx.owner.id}`, webContentsSubscriber(ctx.owner))
  entries.set(id, entry)

  ptyProcess.onData((data) => {
    entry.lastOutputAt = Date.now()
    entry.scrollback += data
    if (entry.scrollback.length > SCROLLBACK_LIMIT) {
      // 從換行處切，減少把 ANSI 序列切一半造成的亂碼
      let cut = entry.scrollback.length - SCROLLBACK_LIMIT
      const nl = entry.scrollback.indexOf('\n', cut)
      if (nl !== -1 && nl - cut < 4096) cut = nl + 1
      entry.scrollback = entry.scrollback.slice(cut)
    }
    for (const sub of entry.subs.values()) sub.data(id, data)

    // 待審批偵測：false→true 才發事件，避免同一個提示連發推播
    if (!entry.needsApproval && looksLikeApprovalPrompt(data)) {
      entry.needsApproval = true
      ptyEvents.emit('approval', id)
      ptyEvents.emit('changed')
    }
  })

  ptyProcess.onExit(({ exitCode }) => {
    for (const sub of entry.subs.values()) sub.exit(id, exitCode)
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
    const snapshot = subscribePty(id, `wc:${wc.id}`, webContentsSubscriber(wc))
    return snapshot === null ? null : { snapshot }
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
