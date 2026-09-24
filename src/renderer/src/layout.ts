// 版面尺寸與終端停靠位置，存 localStorage，重開沿用。
export type Dock = 'right' | 'bottom'

export interface LayoutState {
  leftW: number
  rightW: number
  termH: number
  dock: Dock
  leftCollapsed?: boolean
}

export const DEFAULT_LAYOUT: LayoutState = {
  leftW: 280,
  rightW: 460,
  termH: 300,
  dock: 'bottom',
  leftCollapsed: false
}

const KEY = 'wb-layout'

/** Vibe 模式：圖示列（Sessions／Status／Handoff／Files／Git 懸浮）｜終端（對話）｜成品 */
export const VIBE_DEFAULT_LAYOUT: LayoutState = {
  leftW: 260,
  rightW: 640, // 終端（對話）欄寬；成品吃剩下
  termH: 300,
  dock: 'right',
  leftCollapsed: false
}
const VIBE_KEY = 'wb-layout-vibe-v4'

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v))

/** 各軸的下限；上限依視窗大小另算，避免把中央區擠成 0 */
export const LIMITS = {
  leftMin: 260,
  leftMax: 560,
  rightMin: 340,
  rightMax: 900,
  termMin: 120,
  /** 中央區至少留這麼多 */
  centerMin: 280
}

export function loadLayout(mode: 'developer' | 'vibe' = 'developer'): LayoutState {
  if (mode === 'vibe') {
    try {
      const p = JSON.parse(localStorage.getItem(VIBE_KEY) || 'null') as Partial<LayoutState> | null
      return { ...VIBE_DEFAULT_LAYOUT, ...(p || {}), dock: 'right' }
    } catch {
      return { ...VIBE_DEFAULT_LAYOUT }
    }
  }
  try {
    const raw = localStorage.getItem(KEY)
    const migrated = localStorage.getItem(KEY + '-migrated-v2')
    if (!raw) {
      localStorage.setItem(KEY + '-migrated-v2', 'true')
      return { ...DEFAULT_LAYOUT }
    }
    const p = JSON.parse(raw) as Partial<LayoutState>
    const dock: Dock = !migrated ? 'bottom' : (p.dock === 'right' ? 'right' : 'bottom')
    if (!migrated) localStorage.setItem(KEY + '-migrated-v2', 'true')
    const isCollapsed = Boolean(p.leftCollapsed)
    return {
      leftW: typeof p.leftW === 'number'
        ? (isCollapsed ? 0 : Math.max(LIMITS.leftMin, p.leftW))
        : DEFAULT_LAYOUT.leftW,
      rightW: typeof p.rightW === 'number' ? Math.max(LIMITS.rightMin, p.rightW) : DEFAULT_LAYOUT.rightW,
      termH: typeof p.termH === 'number' ? Math.max(LIMITS.termMin, p.termH) : DEFAULT_LAYOUT.termH,
      dock,
      leftCollapsed: isCollapsed
    }
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
}

export function saveLayout(l: LayoutState, mode: 'developer' | 'vibe' = 'developer'): void {
  try {
    localStorage.setItem(mode === 'vibe' ? VIBE_KEY : KEY, JSON.stringify(l))
  } catch {
    /* 無痕視窗等情況忽略 */
  }
}
