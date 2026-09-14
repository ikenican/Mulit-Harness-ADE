import { ipcMain, app, BrowserWindow } from 'electron'
import * as pty from '@lydell/node-pty'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import * as crypto from 'crypto'
import { execFileSync } from 'child_process'
import { workspace } from '../index'
import { resolveConnectionEnv } from './conn'
import type { CliLauncher, PtySpawnOptions } from '../../preload/index'

const ptySessions = new Map<string, pty.IPty>()

export interface ActiveSessionMeta {
  id: string
  command: string
  launcherId?: string
  startTime: number
  pid: number
  sessionId?: string
  cwd?: string
}
const ptySessionMetas = new Map<string, ActiveSessionMeta>()

export function getActiveSessionMetas(): ActiveSessionMeta[] {
  return Array.from(ptySessionMetas.values())
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

import { getCustomCliPath } from './settings'
import { findAgentCli } from '../ext/paths'
import type { AgentId } from '../../preload/index'

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
  for (const session of ptySessions.values()) hardKill(session)
  ptySessions.clear()
})

export function registerPtyHandlers(): void {
  ipcMain.handle('pty:launchers', async () => {
    const agentsDir = path.join(workspace.root, 'agents')
    const launchers: CliLauncher[] = []
    
    if (!fs.existsSync(agentsDir)) {
      return launchers
    }

    try {
      const files = fs.readdirSync(agentsDir)
      for (const file of files) {
        if (file.endsWith('.yaml') || file.endsWith('.yml')) {
          const content = fs.readFileSync(path.join(agentsDir, file), 'utf8')
          const parsed = yaml.load(content) as any
          if (parsed && parsed.launcher) {
            const l = parsed.launcher
            const r = resolveCommand(l.cli)
            launchers.push({
              id: l.id,
              name: l.name,
              cli: l.cli,
              command: r.cmd,
              args: [...r.extraArgs, ...(l.args || [])],
              env: l.env || {}
            })
          }
        }
      }
    } catch (e) {
      console.error('Error reading launchers:', e)
    }
    
    return launchers
  })

  ipcMain.handle('pty:spawn', async (event, opts: PtySpawnOptions) => {
    let resolved = opts.command ? resolveCommand(opts.command) : { cmd: isWin ? 'cmd.exe' : 'bash', extraArgs: [] }
    let command = resolved.cmd
    let args = [...resolved.extraArgs, ...(opts.args || [])]
    let env = { ...process.env }
    
    if (opts.launcherId) {
      const agentsDir = path.join(workspace.root, 'agents')
      if (fs.existsSync(agentsDir)) {
        const files = fs.readdirSync(agentsDir)
        for (const file of files) {
          if (file.endsWith('.yaml') || file.endsWith('.yml')) {
            const content = fs.readFileSync(path.join(agentsDir, file), 'utf8')
            const parsed = yaml.load(content) as any
            if (parsed && parsed.launcher && parsed.launcher.id === opts.launcherId) {
              const l = parsed.launcher
              const r = resolveCommand(l.cli)
              command = r.cmd
              args = [...r.extraArgs, ...(l.args || [])]
              env = { ...env, ...(l.env || {}) }
              break
            }
          }
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
    
    try {
      const ptyProcess = pty.spawn(command, args, {
        name: 'xterm-color',
        cols,
        rows,
        cwd: workspace.root,
        env: env as Record<string, string>
      })
      
      ptySessions.set(id, ptyProcess)
      ptySessionMetas.set(id, {
        id,
        command: opts.command || opts.launcherId || 'shell',
        launcherId: opts.launcherId,
        startTime: Date.now(),
        pid: ptyProcess.pid,
        sessionId: opts.sessionId,
        cwd: opts.cwd || workspace.root
      })
      
      ptyProcess.onData((data) => {
        event.sender.send(`pty:data:${id}`, data)
      })
      
      ptyProcess.onExit(({ exitCode }) => {
        event.sender.send(`pty:exit:${id}`, exitCode)
        ptySessions.delete(id)
        ptySessionMetas.delete(id)
      })
      
      return id
    } catch (e: any) {
      throw new Error(`Failed to spawn terminal: ${e.message}`)
    }
  })

  ipcMain.on('pty:write', (event, id: string, data: string) => {
    const session = ptySessions.get(id)
    if (session) {
      session.write(data)
    }
  })

  ipcMain.on('pty:resize', (event, id: string, cols: number, rows: number) => {
    const session = ptySessions.get(id)
    if (session) {
      try {
        session.resize(cols, rows)
      } catch (e) {
        // ignore
      }
    }
  })

  ipcMain.handle('pty:pipe', async (_event, fromId: string, toId: string, text: string): Promise<boolean> => {
    const target = ptySessions.get(toId)
    if (!target) return false
    const msg = text.endsWith('\r') || text.endsWith('\n') ? text : `${text}\r\n`
    target.write(msg)
    return true
  })

  ipcMain.on('pty:kill', (event, id: string) => {
    const session = ptySessions.get(id)
    if (session) {
      hardKill(session)
      ptySessions.delete(id)
      ptySessionMetas.delete(id)
    }
  })
}
