// 版面尺寸與終端停靠位置，存 localStorage，重開沿用。
export type Dock = 'right' | 'bottom'

export interface LayoutState {
  leftW: number
  rightW: number
  termH: number
  dock: Dock
}

export const DEFAULT_LAYOUT: LayoutState = {
  leftW: 264,
  rightW: 460,
  termH: 300,
  dock: 'right'
}

const KEY = 'wb-layout'

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v))

/** 各軸的下限；上限依視窗大小另算，避免把中央區擠成 0 */
export const LIMITS = {
  leftMin: 180,
  leftMax: 560,
  rightMin: 300,
  rightMax: 900,
  termMin: 120,
  /** 中央區至少留這麼多 */
  centerMin: 320
}

export function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_LAYOUT }
    const p = JSON.parse(raw) as Partial<LayoutState>
    return {
      leftW: typeof p.leftW === 'number' ? p.leftW : DEFAULT_LAYOUT.leftW,
      rightW: typeof p.rightW === 'number' ? p.rightW : DEFAULT_LAYOUT.rightW,
      termH: typeof p.termH === 'number' ? p.termH : DEFAULT_LAYOUT.termH,
      dock: p.dock === 'bottom' ? 'bottom' : 'right'
    }
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
}

export function saveLayout(l: LayoutState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(l))
  } catch {
    /* 無痕視窗等情況忽略 */
  }
}
