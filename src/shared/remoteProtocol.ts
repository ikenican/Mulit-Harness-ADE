// 遠端控制（手機 ↔ 桌面 Remote Bridge）的 WebSocket 訊息格式。
// 桌面 main（src/main/remote/server.ts）與手機端（src/renderer/remote/）共用這份型別。
// 每則訊息都是 JSON，以 `t` 區分種類。

export interface RemoteSession {
  id: string
  title: string
  /** 啟動用的 key：claude / codex / antigravity / powershell / cmd 或自訂 launcher id */
  launcherKey: string
  windowId: number
  workspaceName: string
  startTime: number
  cols: number
  rows: number
  needsApproval: boolean
  lastOutputAt: number
}

export interface RemoteLauncher {
  key: string
  title: string
  kind: 'agent' | 'shell' | 'custom'
}

export interface RemoteWindow {
  id: number
  workspaceName: string
  workspace: string
  launchers: RemoteLauncher[]
}

export interface RemoteGitFile {
  path: string
  index: string
  workingDir: string
}

export type ClientMessage =
  | { t: 'auth'; token: string }
  | { t: 'attach'; id: string }
  | { t: 'detach'; id: string }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'spawn'; windowId: number; launcherKey: string }
  | { t: 'kill'; id: string }
  | { t: 'handoff'; windowId: number }
  | { t: 'git'; windowId: number }
  | { t: 'visibility'; visible: boolean }
  | { t: 'ping' }

export type ServerMessage =
  | { t: 'authed'; deviceId: string; deviceName: string; hostName: string }
  | {
      t: 'state'
      sessions: RemoteSession[]
      windows: RemoteWindow[]
      /** Bypass 模式開著時，手機要明顯警示：agent 不會再問你就直接執行 */
      bypass: boolean
    }
  | { t: 'snapshot'; id: string; data: string; cols: number; rows: number }
  | { t: 'data'; id: string; d: string }
  | { t: 'resized'; id: string; cols: number; rows: number }
  | { t: 'exit'; id: string; code: number; title: string }
  | { t: 'approval'; id: string; title: string; tail: string }
  | { t: 'spawned'; id: string }
  | { t: 'handoff'; windowId: number; text: string | null }
  | {
      t: 'git'
      windowId: number
      branch: string | null
      ahead: number
      behind: number
      files: RemoteGitFile[]
      error?: string
    }
  | { t: 'error'; message: string }
  | { t: 'pong' }

/** HTTP API（配對與推播訂閱），不走 WebSocket */
export interface PairRequest {
  code: string
  name: string
}
export interface PairResponse {
  token: string
  deviceId: string
}

/** 內建 CLI 的顯示名稱；自訂 launcher 用 yaml 裡的 name */
export const BUILTIN_LAUNCHERS: RemoteLauncher[] = [
  { key: 'claude', title: 'Claude Code', kind: 'agent' },
  { key: 'codex', title: 'Codex', kind: 'agent' },
  { key: 'antigravity', title: 'Antigravity', kind: 'agent' },
  { key: 'powershell', title: 'PowerShell', kind: 'shell' },
  { key: 'cmd', title: 'Command Prompt', kind: 'shell' }
]
