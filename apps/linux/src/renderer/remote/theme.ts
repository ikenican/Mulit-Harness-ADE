// 外觀：跟隨系統（預設）、淺色、深色，存在這支手機的 localStorage。
// 解析後寫進 <html data-theme>，CSS 只看這個屬性；跟隨系統時會隨 iPhone 切換即時更新。

export type ThemePref = 'auto' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const KEY = 'aw.remote.theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<(t: Theme) => void>()

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

let pref: ThemePref = readPref()

export function currentTheme(): Theme {
  return pref === 'auto' ? (media.matches ? 'dark' : 'light') : pref
}

function apply(): void {
  const theme = currentTheme()
  document.documentElement.dataset.theme = theme
  // 狀態列顏色跟著主題（莫蘭迪背景色）
  for (const m of Array.from(document.querySelectorAll('meta[name="theme-color"]'))) m.remove()
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  meta.content = theme === 'dark' ? '#1c2023' : '#ece7df'
  document.head.appendChild(meta)
  for (const cb of listeners) cb(theme)
}

export function getThemePref(): ThemePref {
  return pref
}

export function setThemePref(p: ThemePref): void {
  pref = p
  try {
    if (p === 'auto') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, p)
  } catch {
    // 寫不進去就只在這次生效
  }
  apply()
}

export function onThemeChange(cb: (t: Theme) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

media.addEventListener('change', () => {
  if (pref === 'auto') apply()
})

apply()
