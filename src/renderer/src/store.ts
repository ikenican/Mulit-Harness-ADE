import { useSyncExternalStore } from 'react'
import type { AgentId } from '../../preload/index'

// ── 極簡跨 panel 狀態（第二個整合縫合處）──────────────────────────────
// panel 只透過這些函式/hook 互動，彼此不直接 import。不要在 panel 內改這個檔。
//   openFile(path)  → 中央進入編輯模式並載入該檔（FileTree 點檔用）
//   openDiff(path)  → 中央進入 Git diff 模式（Git panel 點變更檔用）
//   bumpGit()       → 通知 Git panel 重新抓 status（存檔 / commit 後呼叫）
//   toggleTheme()   → 切換亮暗；panel 需 JS 感知主題時讀 useWorkbench().theme
export type Theme = 'light' | 'dark' | 'light-morandi' | 'dark-morandi'
export type Language = 'en' | 'zh-TW'
export type SidebarTab = 'dashboard' | 'files' | 'git'

/** 要送進終端的文字（例如 markdown code block 的指令）。nonce 遞增即代表有新的一筆。 */
export interface TerminalDispatch {
  text: string
  /** shell = 送到（必要時新開）一般 shell；active = 目前分頁 */
  target: 'shell' | 'active'
  nonce: number
}

/** 跨面板請求開啟/切換對應之 Agent CLI 終端會話 */
export interface TerminalOpenSessionRequest {
  id?: string
  agent: AgentId
  title?: string
  status?: string
  workspacePath?: string
  ensureRightDock?: boolean
  nonce: number
}

/** 跨面板檢視特定 Git Commit 比對差異 */
export interface GitCommitDiffTarget {
  commitHash: string
  parentHash?: string
  commitMessage?: string
  filePath: string
  files?: Array<{ path: string; status: string }>
}

export type SettingsTab = 'appearance' | 'cli' | 'doctools' | 'extensions' | 'about'

export interface SettingsModalState {
  isOpen: boolean
  tab: SettingsTab
}

export interface WorkbenchState {
  activeFilePath: string | null
  /** 已開啟的檔案分頁（依開啟順序） */
  openTabs: string[]
  viewMode: 'edit' | 'diff'
  activeCommitDiff: GitCommitDiffTarget | null
  gitTick: number // 遞增即代表 git 狀態該刷新
  settingsTick: number // 遞增即代表設定（如 CLI 啟用狀態）該刷新
  theme: Theme
  terminalDispatch: TerminalDispatch | null
  terminalOpenSession: TerminalOpenSessionRequest | null
  workspaceRoot: string
  centerMaximized: boolean
  isTerminalDetached: boolean
  settingsModal: SettingsModalState
  language: Language
  sidebarTab: SidebarTab
  /** 檔案樹變更計數器，促使 FileTreePanel 自動更新 */
  fileTreeTick: number
  /** 記錄被終端 Agent 修改過的工作區檔案集合（供 Editor Tabs 呈現視覺標記） */
  agentModifiedFiles: Set<string>
  /** 每個檔案的外部變更計數器，促使 Editor 自動重新載入最新磁碟內容 */
  fileReloadTick: Record<string, number>
  /** 編輯器即時內容草稿（供 PreviewPanel 等即時自動更新 Markdown/HTML 預覽，無需手動按 Refresh） */
  editorDraft: { path: string; text: string; version: number } | null
}

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('wb-theme')
    if (
      saved === 'light' ||
      saved === 'dark' ||
      saved === 'light-morandi' ||
      saved === 'dark-morandi'
    ) {
      return saved as Theme
    }
  } catch {
    /* localStorage 不可用時忽略 */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  try {
    const isDark = theme === 'dark' || theme === 'dark-morandi'
    window.api?.window?.setTitleBarTheme?.(isDark ? 'dark' : 'light')
  } catch {
    /* ignore */
  }
}

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem('wb-language')
    if (saved === 'en' || saved === 'zh-TW') {
      return saved
    }
  } catch {
    /* localStorage 不可用時忽略 */
  }
  if (typeof navigator !== 'undefined' && navigator.language) {
    if (navigator.language.toLowerCase().startsWith('zh')) {
      return 'zh-TW'
    }
  }
  return 'en'
}

let state: WorkbenchState = {
  activeFilePath: null,
  openTabs: [],
  viewMode: 'edit',
  activeCommitDiff: null,
  gitTick: 0,
  settingsTick: 0,
  theme: initialTheme(),
  language: initialLanguage(),
  terminalDispatch: null,
  terminalOpenSession: null,
  workspaceRoot: '',
  centerMaximized: false,
  isTerminalDetached: false,
  settingsModal: { isOpen: false, tab: 'appearance' },
  sidebarTab: 'files',
  fileTreeTick: 0,
  agentModifiedFiles: new Set<string>(),
  fileReloadTick: {},
  editorDraft: null
}
applyTheme(state.theme)

// 異步載入後端工作區根目錄與偏好設定
if (typeof window !== 'undefined' && window.api?.files?.workspaceRoot) {
  window.api.files
    .workspaceRoot()
    .then((root) => {
      if (root && !state.workspaceRoot) {
        set({ workspaceRoot: root })
      }
    })
    .catch(() => {})
}

// 異步同步後端儲存之語言設定（若本機尚未指定或後端有更優先紀錄）
if (typeof window !== 'undefined' && window.api?.settings?.get) {
  window.api.settings
    .get()
    .then((s) => {
      if (s?.language && (s.language === 'en' || s.language === 'zh-TW')) {
        const local = localStorage.getItem('wb-language')
        if (!local && s.language !== state.language) {
          set({ language: s.language })
        }
      }
    })
    .catch(() => {})
}

// 監聽工作區檔案樹整體變更（新增/刪除/改名等）自動遞增 fileTreeTick 與 gitTick
if (typeof window !== 'undefined' && window.api?.files?.onTreeChange) {
  window.api.files.onTreeChange(() => {
    set({
      fileTreeTick: state.fileTreeTick + 1,
      gitTick: state.gitTick + 1
    })
  })
}

// 監聽後端工作區檔案變更（終端機 Agent 修改檔案時自動開檔與標記）
if (typeof window !== 'undefined' && window.api?.files?.onExternalChange) {
  window.api.files.onExternalChange(async ({ path }) => {
    try {
      const settings = await window.api.settings.get().catch(() => null)
      const autoOpen = settings?.autoOpenAgentModifiedFiles ?? true

      // 1. 標記該檔案為 Agent 所修改
      const nextModified = new Set(state.agentModifiedFiles)
      nextModified.add(path)

      // 2. 遞增檔案重載計數器，促使 Editor 自動載入磁碟最新文字
      const nextTicks = {
        ...state.fileReloadTick,
        [path]: (state.fileReloadTick[path] || 0) + 1
      }

      // 3. 遞增 Git 刷新計數器，讓左側 Git Panel 即時更新狀態
      const nextGitTick = state.gitTick + 1

      // 4. 若開啟自動分頁功能，將檔案開啟並切換至中央 Editor
      let nextTabs = state.openTabs
      let nextActive = state.activeFilePath
      let nextViewMode = state.viewMode

      if (autoOpen) {
        if (!nextTabs.includes(path)) {
          nextTabs = [...nextTabs, path]
        }
        nextActive = path
        nextViewMode = 'edit'
      }

      set({
        agentModifiedFiles: nextModified,
        fileReloadTick: nextTicks,
        gitTick: nextGitTick,
        openTabs: nextTabs,
        activeFilePath: nextActive,
        viewMode: nextViewMode,
        centerMaximized: false
      })
    } catch (err) {
      console.error('[Store] onExternalChange handler error:', err)
    }
  })
}

const listeners = new Set<() => void>()

function set(patch: Partial<WorkbenchState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function markAgentModified(path: string): void {
  const next = new Set(state.agentModifiedFiles)
  next.add(path)
  set({ agentModifiedFiles: next })
}

export function clearAgentModified(path: string): void {
  if (!state.agentModifiedFiles.has(path)) return
  const next = new Set(state.agentModifiedFiles)
  next.delete(path)
  set({ agentModifiedFiles: next })
}

export function setWorkspaceRoot(path: string): void {
  set({ workspaceRoot: path })
}

export function setSidebarTab(tab: SidebarTab): void {
  set({ sidebarTab: tab })
}

export async function switchWorkspace(path: string): Promise<boolean> {
  if (path && window.api?.files?.setWorkspaceRoot) {
    const ok = await window.api.files.setWorkspaceRoot(path).catch(() => false)
    if (ok) {
      set({
        workspaceRoot: path,
        sidebarTab: 'files',
        fileTreeTick: state.fileTreeTick + 1,
        gitTick: state.gitTick + 1
      })
      return true
    }
  }
  // If no path or path doesn't exist on disk, still switch sidebar to files
  set({ sidebarTab: 'files' })
  return false
}

export function toggleCenterMaximized(): void {
  set({ centerMaximized: !state.centerMaximized })
}

export function setCenterMaximized(val: boolean): void {
  set({ centerMaximized: val })
}

export function setTerminalDetached(val: boolean): void {
  set({ isTerminalDetached: val })
}

export function openFile(path: string): void {
  const tabs = state.openTabs.includes(path) ? state.openTabs : [...state.openTabs, path]
  set({ activeFilePath: path, viewMode: 'edit', openTabs: tabs, activeCommitDiff: null })
}

export function openDiff(path: string): void {
  const tabs = state.openTabs.includes(path) ? state.openTabs : [...state.openTabs, path]
  set({ activeFilePath: path, viewMode: 'diff', openTabs: tabs, activeCommitDiff: null })
}

export function openCommitDiff(target: GitCommitDiffTarget): void {
  const tabId = target.filePath
    ? `commit:${target.commitHash.slice(0, 7)}:${target.filePath}`
    : `commit:${target.commitHash.slice(0, 7)}`
  const tabs = state.openTabs.includes(tabId) ? state.openTabs : [...state.openTabs, tabId]
  set({
    activeFilePath: tabId,
    viewMode: 'diff',
    activeCommitDiff: target,
    openTabs: tabs,
    centerMaximized: false
  })
}

export function selectTab(tabId: string): void {
  if (tabId.startsWith('commit:')) {
    const parts = tabId.split(':')
    const hash = parts[1]
    const filePath = parts.slice(2).join(':')
    const target: GitCommitDiffTarget =
      state.activeCommitDiff && state.activeCommitDiff.commitHash.startsWith(hash)
        ? { ...state.activeCommitDiff, filePath }
        : { commitHash: hash, filePath }
    set({
      activeFilePath: tabId,
      viewMode: 'diff',
      activeCommitDiff: target
    })
  } else {
    openFile(tabId)
  }
}

/** 關閉分頁；關掉的若是當前檔，改選旁邊那個 */
export function closeTab(path: string): void {
  const idx = state.openTabs.indexOf(path)
  if (idx === -1) return
  const tabs = state.openTabs.filter((p) => p !== path)
  const nextActive =
    state.activeFilePath === path ? (tabs[Math.max(0, idx - 1)] ?? null) : state.activeFilePath
  const isCommit = nextActive ? nextActive.startsWith('commit:') : false
  set({
    openTabs: tabs,
    activeFilePath: nextActive,
    viewMode: isCommit ? 'diff' : (nextActive ? state.viewMode : 'edit'),
    activeCommitDiff: isCommit ? state.activeCommitDiff : null
  })
}
export function bumpGit(): void {
  set({ gitTick: state.gitTick + 1 })
}
export function bumpFileTree(): void {
  set({ fileTreeTick: state.fileTreeTick + 1 })
}
export function bumpSettings(): void {
  set({ settingsTick: state.settingsTick + 1 })
}
export function setEditorDraft(path: string, text: string): void {
  const current = state.editorDraft
  if (current && current.path === path && current.text === text) return
  set({
    editorDraft: {
      path,
      text,
      version: (current?.version || 0) + 1
    }
  })
}
export function clearEditorDraft(path?: string): void {
  if (!path || state.editorDraft?.path === path) {
    set({ editorDraft: null })
  }
}
export function openSettings(tab: SettingsTab = 'appearance'): void {
  set({ settingsModal: { isOpen: true, tab } })
}
export function closeSettings(): void {
  set({ settingsModal: { isOpen: false, tab: state.settingsModal.tab } })
}
export function setSettingsTab(tab: SettingsTab): void {
  set({ settingsModal: { ...state.settingsModal, tab } })
}
/**
 * 把文字送進終端。刻意「只貼上、不自動送出」——指令要不要執行由使用者按 Enter 決定。
 */
export function sendToTerminal(text: string, target: 'shell' | 'active' = 'shell'): void {
  set({
    terminalDispatch: {
      text,
      target,
      nonce: (state.terminalDispatch?.nonce ?? 0) + 1
    }
  })
}

/**
  * 開啟或切換至特定 Agent CLI 終端會話（如點選 Dashboard session）。
  * 自動解除中央最大化，並派發給 TerminalPanel 與 App 版面。
  */
export function openTerminalSession(req: {
  id?: string
  agent: AgentId
  title?: string
  status?: string
  workspacePath?: string
  ensureRightDock?: boolean
}): void {
  if (state.centerMaximized) {
    set({ centerMaximized: false })
  }
  set({
    terminalOpenSession: {
      ...req,
      ensureRightDock: req.ensureRightDock ?? true,
      nonce: (state.terminalOpenSession?.nonce ?? 0) + 1
    }
  })
}

export function setTheme(theme: Theme): void {
  if (state.theme === theme) return
  applyTheme(theme)
  try {
    localStorage.setItem('wb-theme', theme)
  } catch {
    /* 忽略 */
  }
  set({ theme })
}

export function setLanguage(language: Language): void {
  if (state.language === language) return
  try {
    localStorage.setItem('wb-language', language)
  } catch {
    /* 忽略 */
  }
  set({ language })
  window.api?.settings?.set?.({ language }).catch(() => {})
}

export function toggleTheme(): void {
  let next: Theme = 'dark'
  if (state.theme === 'dark') next = 'light'
  else if (state.theme === 'light') next = 'light-morandi'
  else if (state.theme === 'light-morandi') next = 'dark-morandi'
  else if (state.theme === 'dark-morandi') next = 'dark'
  setTheme(next)
}

export function useWorkbench(): WorkbenchState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}

/** 跨面板拖曳之 Agent Session 酬載 */
export interface DraggedSessionPayload {
  type: 'agent-session'
  id: string
  agent: AgentId
  title: string
  status: string
  workspace?: string
  workspacePath?: string
  model?: string
  totalTokens?: number
}

let activeDraggedSession: DraggedSessionPayload | null = null

export function setDraggedSession(session: DraggedSessionPayload | null): void {
  activeDraggedSession = session
}

export function getDraggedSession(): DraggedSessionPayload | null {
  return activeDraggedSession
}
