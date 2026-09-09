import { ipcMain, app, BrowserWindow } from 'electron'
import * as pty from '@lydell/node-pty'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import * as crypto from 'crypto'
import { workspace } from '../index'
import { resolveConnectionEnv } from './conn'
import type { CliLauncher, PtySpawnOptions } from '../../preload/index'

const ptySessions = new Map<string, pty.IPty>()

const isWin = process.platform === 'win32'

/**
 * 邏輯名稱 → 實際執行檔。集中在這裡，UI 與 yaml 只需要用邏輯名。
 * 注意 antigravity 的執行檔實際叫 agy（實機探測結果），不是 antigravity。
 */
function resolveCommand(name: string): string {
  switch (name) {
    case 'antigravity':
      return 'agy'
    case 'powershell':
      return isWin ? 'powershell.exe' : 'pwsh'
    case 'pwsh':
      return 'pwsh'
    case 'cmd':
      return isWin ? 'cmd.exe' : 'sh'
    case 'bash':
      return 'bash'
    default:
      return name
  }
}

app.on('before-quit', () => {
  for (const session of ptySessions.values()) {
    try {
      session.kill()
    } catch (e) {
      // ignore
    }
  }
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
            launchers.push({
              id: l.id,
              name: l.name,
              cli: l.cli,
              command: resolveCommand(l.cli),
              args: l.args || [],
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
    let command = opts.command ? resolveCommand(opts.command) : isWin ? 'cmd.exe' : 'bash'
    let args = opts.args || []
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
              command = resolveCommand(l.cli)
              args = l.args || []
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
      
      ptyProcess.onData((data) => {
        event.sender.send(`pty:data:${id}`, data)
      })
      
      ptyProcess.onExit(({ exitCode }) => {
        event.sender.send(`pty:exit:${id}`, exitCode)
        ptySessions.delete(id)
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

  ipcMain.on('pty:kill', (event, id: string) => {
    const session = ptySessions.get(id)
    if (session) {
      try {
        session.kill()
      } catch (e) {
        // ignore
      }
      ptySessions.delete(id)
    }
  })
}
