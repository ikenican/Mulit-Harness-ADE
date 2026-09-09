import { useSyncExternalStore } from 'react'

// ── 極簡跨 panel 狀態（第二個整合縫合處）──────────────────────────────
// panel 只透過這些函式/hook 互動，彼此不直接 import。不要在 panel 內改這個檔。
//   openFile(path)  → 中央進入編輯模式並載入該檔（FileTree 點檔用）
//   openDiff(path)  → 中央進入 Git diff 模式（Git panel 點變更檔用）
//   bumpGit()       → 通知 Git panel 重新抓 status（存檔 / commit 後呼叫）
//   toggleTheme()   → 切換亮暗；panel 需 JS 感知主題時讀 useWorkbench().theme
export type Theme = 'light' | 'dark'

/** 要送進終端的文字（例如 markdown code block 的指令）。nonce 遞增即代表有新的一筆。 */
export interface TerminalDispatch {
  text: string
  /** shell = 送到（必要時新開）一般 shell；active = 目前分頁 */
  target: 'shell' | 'active'
  nonce: number
}

export interface WorkbenchState {
  activeFilePath: string | null
  /** 已開啟的檔案分頁（依開啟順序） */
  openTabs: string[]
  viewMode: 'edit' | 'diff'
  gitTick: number // 遞增即代表 git 狀態該刷新
  theme: Theme
  terminalDispatch: TerminalDispatch | null
}

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('wb-theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* localStorage 不可用時忽略 */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
}

let state: WorkbenchState = {
  activeFilePath: null,
  openTabs: [],
  viewMode: 'edit',
  gitTick: 0,
  theme: initialTheme(),
  terminalDispatch: null
}
applyTheme(state.theme)

const listeners = new Set<() => void>()

function set(patch: Partial<WorkbenchState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function openFile(path: string): void {
  const tabs = state.openTabs.includes(path) ? state.openTabs : [...state.openTabs, path]
  set({ activeFilePath: path, viewMode: 'edit', openTabs: tabs })
}
export function openDiff(path: string): void {
  const tabs = state.openTabs.includes(path) ? state.openTabs : [...state.openTabs, path]
  set({ activeFilePath: path, viewMode: 'diff', openTabs: tabs })
}

/** 關閉分頁；關掉的若是當前檔，改選旁邊那個 */
export function closeTab(path: string): void {
  const idx = state.openTabs.indexOf(path)
  if (idx === -1) return
  const tabs = state.openTabs.filter((p) => p !== path)
  const nextActive =
    state.activeFilePath === path ? (tabs[Math.max(0, idx - 1)] ?? null) : state.activeFilePath
  set({ openTabs: tabs, activeFilePath: nextActive })
}
export function bumpGit(): void {
  set({ gitTick: state.gitTick + 1 })
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

export function toggleTheme(): void {
  const next: Theme = state.theme === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  try {
    localStorage.setItem('wb-theme', next)
  } catch {
    /* 忽略 */
  }
  set({ theme: next })
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
