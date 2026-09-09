import { contextBridge, ipcRenderer } from 'electron'

// ── Workbench IPC 契約（唯一整合縫合處）────────────────────────────────
// 所有 renderer panel 一律透過 window.api.* 呼叫；main 端各 handler 檔各自實作。
// 新增方法時，這裡加一條 + src/preload/index.d.ts 加型別 + 對應 main/ipc/*.ts 實作 handle。
const api = {
  // 檔案 / 檔案樹 —— main/ipc/files.ts
  files: {
    read: (path: string): Promise<string> => ipcRenderer.invoke('files:read', path),
    write: (path: string, content: string): Promise<void> =>
      ipcRenderer.invoke('files:write', path, content),
    list: (dir: string): Promise<FsEntry[]> => ipcRenderer.invoke('files:list', dir),
    exists: (path: string): Promise<boolean> => ipcRenderer.invoke('files:exists', path),
    workspaceRoot: (): Promise<string> => ipcRenderer.invoke('files:workspaceRoot'),
    pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('files:pickWorkspace')
  },
  // OS 原生通知 —— main/ipc/notify.ts
  notify: {
    show: (title: string, body: string): void => ipcRenderer.send('notify:show', title, body)
  },
  // Git —— main/ipc/git.ts
  git: {
    status: (): Promise<GitStatus> => ipcRenderer.invoke('git:status'),
    log: (limit?: number): Promise<GitCommit[]> => ipcRenderer.invoke('git:log', limit),
    diff: (path: string): Promise<{ head: string; work: string }> =>
      ipcRenderer.invoke('git:diff', path),
    stage: (path: string): Promise<void> => ipcRenderer.invoke('git:stage', path),
    unstage: (path: string): Promise<void> => ipcRenderer.invoke('git:unstage', path),
    commit: (message: string): Promise<void> => ipcRenderer.invoke('git:commit', message),
    restore: (path: string): Promise<void> => ipcRenderer.invoke('git:restore', path),
    branches: (): Promise<{ current: string; all: string[] }> =>
      ipcRenderer.invoke('git:branches'),
    checkout: (branch: string): Promise<void> => ipcRenderer.invoke('git:checkout', branch)
  },
  // CLI 終端殼（node-pty）—— main/ipc/pty.ts
  pty: {
    spawn: (opts: PtySpawnOptions): Promise<string> => ipcRenderer.invoke('pty:spawn', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    onData: (id: string, cb: (data: string) => void): (() => void) => {
      const ch = `pty:data:${id}`
      const listener = (_e: unknown, data: string): void => cb(data)
      ipcRenderer.on(ch, listener)
      return () => ipcRenderer.removeListener(ch, listener)
    },
    onExit: (id: string, cb: (code: number) => void): (() => void) => {
      const ch = `pty:exit:${id}`
      const listener = (_e: unknown, code: number): void => cb(code)
      ipcRenderer.on(ch, listener)
      return () => ipcRenderer.removeListener(ch, listener)
    },
    // 讀取 agents/*.yaml launcher 定義
    launchers: (): Promise<CliLauncher[]> => ipcRenderer.invoke('pty:launchers')
  }
}

contextBridge.exposeInMainWorld('api', api)

export type WorkbenchApi = typeof api

// —— 契約用到的資料型別（renderer 與 main 共用）——
export interface FsEntry {
  name: string
  path: string
  isDir: boolean
}
export interface GitFileChange {
  path: string
  index: string // staged 狀態碼
  working_dir: string // 工作區狀態碼
}
export interface GitStatus {
  isRepo: boolean
  current: string
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: string[]
}
export interface GitCommit {
  hash: string
  date: string
  message: string
  author: string
}
export interface CliLauncher {
  id: string
  name: string
  cli: 'claude' | 'codex' | 'antigravity'
  command: string
  args: string[]
  env?: Record<string, string>
}
export interface PtySpawnOptions {
  launcherId?: string
  command?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
}
