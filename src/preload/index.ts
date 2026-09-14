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
    setWorkspaceRoot: (path: string): Promise<boolean> =>
      ipcRenderer.invoke('files:setWorkspaceRoot', path),
    pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('files:pickWorkspace'),
    openExternal: (path: string, customToolPath?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('files:openExternal', path, customToolPath),
    showInFolder: (path: string): Promise<void> => ipcRenderer.invoke('files:showInFolder', path),
    stat: (path: string): Promise<FileStat> => ipcRenderer.invoke('files:stat', path),
    pickExecutable: (title?: string): Promise<string | null> =>
      ipcRenderer.invoke('files:pickExecutable', title),
    detectDocTools: (): Promise<DocToolPaths> => ipcRenderer.invoke('files:detectDocTools'),
    onExternalChange: (
      cb: (info: { path: string; relativePath: string; eventType: string }) => void
    ): (() => void) => {
      const listener = (
        _event: unknown,
        info: { path: string; relativePath: string; eventType: string }
      ): void => cb(info)
      ipcRenderer.on('files:externalChange', listener)
      return () => ipcRenderer.removeListener('files:externalChange', listener)
    },
    onTreeChange: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('files:treeChange', listener)
      return () => ipcRenderer.removeListener('files:treeChange', listener)
    }
  },
  // OS 原生通知 —— main/ipc/notify.ts
  notify: {
    show: (title: string, body: string): void => ipcRenderer.send('notify:show', title, body)
  },
  // 擴充管理（Skill / MCP / Plugin 跨 agent）—— main/ipc/ext.ts
  ext: {
    agents: (): Promise<AgentStatus[]> => ipcRenderer.invoke('ext:agents'),
    inventory: (): Promise<ExtItem[]> => ipcRenderer.invoke('ext:inventory'),
    manifest: (): Promise<ExtManifest> => ipcRenderer.invoke('ext:manifest'),
    saveManifest: (m: ExtManifest): Promise<void> => ipcRenderer.invoke('ext:saveManifest', m),
    planSync: (): Promise<FileChange[]> => ipcRenderer.invoke('ext:planSync'),
    applySync: (): Promise<{ written: string[] }> => ipcRenderer.invoke('ext:applySync'),
    trustWorkspace: (): Promise<boolean> => ipcRenderer.invoke('ext:trustWorkspace'),
    installCodex: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('ext:installCodex'),
    toggleItem: (kind: string, id: string, enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('ext:toggleItem', kind, id, enabled)
  },
  // 連線憑證（值只進 OS 加密儲存，不回傳給 renderer）—— main/ipc/conn.ts
  conn: {
    list: (): Promise<ConnectionInfo[]> => ipcRenderer.invoke('conn:list'),
    set: (name: string, value: string): Promise<void> =>
      ipcRenderer.invoke('conn:set', name, value),
    remove: (name: string): Promise<void> => ipcRenderer.invoke('conn:remove', name)
  },
  // 設定管理（CLI 路徑等）—— main/ipc/settings.ts
  settings: {
    get: (): Promise<WorkbenchSettings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<WorkbenchSettings>): Promise<WorkbenchSettings> =>
      ipcRenderer.invoke('settings:set', patch),
    testCliPath: (path: string): Promise<{ ok: boolean; version?: string; error?: string }> =>
      ipcRenderer.invoke('settings:testCliPath', path)
  },
  // 儀表板與使用量統計 —— main/ipc/dashboard.ts
  dashboard: {
    data: (): Promise<DashboardData> => ipcRenderer.invoke('dashboard:data'),
    archiveSession: (sessionId: string, archive: boolean): Promise<boolean> =>
      ipcRenderer.invoke('dashboard:archiveSession', sessionId, archive),
    deleteSession: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('dashboard:deleteSession', sessionId)
  },
  // Git —— main/ipc/git.ts
  git: {
    status: (): Promise<GitStatus> => ipcRenderer.invoke('git:status'),
    log: (limit?: number): Promise<GitCommit[]> => ipcRenderer.invoke('git:log', limit),
    graph: (limit?: number): Promise<GitGraphNode[]> => ipcRenderer.invoke('git:graph', limit),
    diff: (path: string): Promise<{ head: string; work: string }> =>
      ipcRenderer.invoke('git:diff', path),
    stage: (path: string): Promise<void> => ipcRenderer.invoke('git:stage', path),
    unstage: (path: string): Promise<void> => ipcRenderer.invoke('git:unstage', path),
    commit: (message: string): Promise<void> => ipcRenderer.invoke('git:commit', message),
    restore: (path: string): Promise<void> => ipcRenderer.invoke('git:restore', path),
    branches: (): Promise<{ current: string; all: string[] }> =>
      ipcRenderer.invoke('git:branches'),
    checkout: (branch: string): Promise<void> => ipcRenderer.invoke('git:checkout', branch),
    commitDetails: (hash: string): Promise<GitCommitDetail> =>
      ipcRenderer.invoke('git:commitDetails', hash),
    commitFileDiff: (
      hash: string,
      filePath: string,
      parentHash?: string
    ): Promise<{ original: string; modified: string }> =>
      ipcRenderer.invoke('git:commitFileDiff', hash, filePath, parentHash)
  },
  // CLI 終端殼（node-pty）—— main/ipc/pty.ts
  pty: {
    spawn: (opts: PtySpawnOptions): Promise<string> => ipcRenderer.invoke('pty:spawn', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    pipe: (fromId: string, toId: string, text: string): Promise<boolean> =>
      ipcRenderer.invoke('pty:pipe', fromId, toId, text),
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
  },
  // 視窗管理（獨立彈出終端等）
  window: {
    detachTerminal: (): Promise<boolean> => ipcRenderer.invoke('window:openTerminalWindow'),
    attachTerminal: (): Promise<boolean> => ipcRenderer.invoke('window:closeTerminalWindow'),
    setTitleBarTheme: (theme: 'light' | 'dark'): Promise<boolean> =>
      ipcRenderer.invoke('window:setTitleBarTheme', theme),
    onTerminalAttached: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('terminal:attached', listener)
      return () => ipcRenderer.removeListener('terminal:attached', listener)
    }
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

export interface GitGraphNode {
  hash: string
  parents: string[]
  author: string
  date: string
  refs: string[]
  message: string
}

export interface GitCommitFileChange {
  path: string
  status: string
}

export interface GitCommitDetail {
  hash: string
  fullHash: string
  parents: string[]
  author: string
  date: string
  message: string
  files: GitCommitFileChange[]
}

export interface DocToolPaths {
  word?: string
  excel?: string
  powerpoint?: string
  pdf?: string
  [key: string]: string | undefined
}

export interface FileStat {
  size: number
  mtime: string
  isFile: boolean
}

export interface WorkbenchSettings {
  cliPaths: {
    claude?: string
    antigravity?: string
    codex?: string
    powershell?: string
    cmd?: string
    [key: string]: string | undefined
  }
  cliEnabled?: {
    claude?: boolean
    antigravity?: boolean
    codex?: boolean
    powershell?: boolean
    cmd?: boolean
    [key: string]: boolean | undefined
  }
  docToolPaths?: DocToolPaths
  autoOpenAgentModifiedFiles?: boolean
  language?: 'en' | 'zh-TW'
}

export interface SessionTokenBreakdown {
  promptTokens: number
  toolReadTokens: number
  completionTokens: number
  details: {
    category: string
    tokens: number
    percentage: number
  }[]
}

export interface AgentSessionInfo {
  id: string
  agent: AgentId
  title: string
  status: 'active' | 'waiting_approval' | 'idle' | 'completed' | 'error'
  startTime: string
  lastActiveTime: string
  totalTokens: number
  tokenBreakdown: SessionTokenBreakdown
  model?: string
  isArchived?: boolean
  workspace?: string
  workspacePath?: string
}

export interface WindowUsage {
  usedPct: number
  resetsAt?: string | null
  resetsInSeconds?: number | null
  tokens?: number
  label?: string
}

export interface AgentUsageSummary {
  agent: AgentId
  label: string
  totalSessions: number
  activeSessions: number
  totalTokens: number
  promptTokens: number
  toolTokens: number
  completionTokens: number
  usedPct?: number
  quotaLimit?: number
  fiveHour?: WindowUsage
  weekly?: WindowUsage
}

export interface DashboardData {
  agents: Record<AgentId, AgentUsageSummary>
  sessions: AgentSessionInfo[]
}

export interface CliLauncher {
  id: string
  name: string
  cli: 'claude' | 'codex' | 'antigravity'
  command: string
  args: string[]
  env?: Record<string, string>
}
// ── 擴充管理型別 ──────────────────────────────────────────────────
export type AgentId = 'claude' | 'antigravity' | 'codex'
export type ExtKind = 'skill' | 'mcp' | 'plugin'

/** 某個擴充在某個 agent 上的狀態 */
export type SupportState =
  | 'installed' // 已裝且可用
  | 'missing' // 支援但尚未裝
  | 'unsupported' // 該 agent 沒有這個概念
  | 'pending' // 尚未支援（Codex）
  | 'error' // 裝了但讀取/設定有問題

export interface AgentSupport {
  agent: AgentId
  state: SupportState
  detail?: string
}

export interface ExtItem {
  id: string
  kind: ExtKind
  name: string
  description?: string
  version?: string
  /** 由 workbench manifest 管理（可同步），或只是掃到的既有安裝 */
  managed: boolean
  agents: AgentSupport[]
  /** 需要的連線憑證名稱（來自 env 的 ${conn:x} 佔位） */
  needsConnection?: string[]
  enabled?: boolean
}

export interface AgentStatus {
  agent: AgentId
  label: string
  /** CLI 執行檔是否存在 */
  cliFound: boolean
  cliPath?: string
  configHome?: string
  /** workbench 是否支援管理這個 agent */
  supported: boolean
  pending: boolean
  counts: { skill: number; mcp: number; plugin: number }
  notes: string[]
}

export interface ManifestMcp {
  id: string
  command: string
  args?: string[]
  env?: Record<string, string>
  targets: AgentId[]
}
export interface ManifestSkill {
  id: string
  /** 相對工作區的來源資料夾，內含 SKILL.md */
  path: string
  targets: AgentId[]
}
export interface ManifestPlugin {
  id: string
  /** Claude: <plugin>@<marketplace>；Antigravity: plugin 目錄名 */
  targets: AgentId[]
}
export interface ExtManifest {
  version: number
  skills: ManifestSkill[]
  mcp: ManifestMcp[]
  plugins: ManifestPlugin[]
}

/** 同步前的變更預覽（before/after 餵給 Monaco DiffEditor） */
export interface FileChange {
  path: string
  agent: AgentId
  before: string
  after: string
  note?: string
}

export interface ConnectionInfo {
  name: string
  /** 只回報有沒有設定，永遠不回傳值 */
  isSet: boolean
  usedBy: string[]
}

export interface PtySpawnOptions {
  launcherId?: string
  command?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
  sessionId?: string
}
