// 手機端唯一的圖示來源：線條 2px、圓端，比照 SF Symbols 的 regular 字重，
// 與旁邊 17px 文字視覺重量一致。純裝飾的圖示一律 aria-hidden，意義由旁邊文字或按鈕的 aria-label 提供。

type P = { size?: number; className?: string }

function Svg({ size = 22, className, children }: P & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const IChevronLeft = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M15 5l-7 7 7 7" strokeWidth={2.4} />
  </Svg>
)
export const IChevronRight = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M9 5l7 7-7 7" />
  </Svg>
)
export const IGear = (p: P): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" strokeWidth={1.8} />
  </Svg>
)
export const IPlus = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const IArrowUp = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" strokeWidth={2.4} />
  </Svg>
)
export const IEllipsis = (p: P): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12h.01M12 12h.01M16 12h.01" strokeWidth={2.6} />
  </Svg>
)
export const IBell = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </Svg>
)
export const IHand = (p: P): JSX.Element => (
  // 「等你回覆」：舉手，比沙漏更直接表示「輪到你了」
  <Svg {...p}>
    <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5M14 10.5V5.5a1.5 1.5 0 0 1 3 0V14" />
    <path d="M8 11.5a1.5 1.5 0 0 0-3 0V14a7 7 0 0 0 7 7h.5a5.5 5.5 0 0 0 4.5-5.5V14" />
  </Svg>
)
export const IDoc = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M7 3h7l4 4v14H7z" />
    <path d="M14 3v4h4M10 12h5M10 16h5" />
  </Svg>
)
export const IBranch = (p: P): JSX.Element => (
  <Svg {...p}>
    <circle cx="7" cy="5.5" r="2" />
    <circle cx="7" cy="18.5" r="2" />
    <circle cx="17" cy="8" r="2" />
    <path d="M7 7.5v9M17 10c0 4-10 2.5-10 6.5" />
  </Svg>
)
export const IWarning = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4M12 17h.01" strokeWidth={2.4} />
  </Svg>
)
export const IWifiOff = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M14.5 10.4A10 10 0 0 1 19 13M2 9.5a15 15 0 0 1 4.5-2.8M11 6a15 15 0 0 1 11 3.5M12 20h.01" />
  </Svg>
)
export const IDesktop = (p: P): JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M9 20h6M12 16v4" />
  </Svg>
)
export const IShare = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M12 3v12M8 7l4-4 4 4" />
    <path d="M6 11H5v10h14V11h-1" />
  </Svg>
)
export const ICheck = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" strokeWidth={2.4} />
  </Svg>
)
export const IStop = (p: P): JSX.Element => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
)
export const IResize = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6" />
  </Svg>
)

// —— Agent 標誌：每家形狀不同（不是只靠顏色分辨），白色圖形放在品牌色圓角方塊上，比照 iOS 設定 App 的圖示 ——

const MARKS: Record<string, { bg: string; path: JSX.Element }> = {
  claude: {
    bg: '#C15F3C',
    path: (
      <path
        fill="#fff"
        d="M12 2c.55 0 1 .45 1 1v5.59l3.29-3.3a1 1 0 1 1 1.42 1.42L14.41 10H20a1 1 0 1 1 0 2h-5.59l3.3 3.29a1 1 0 0 1-1.42 1.42L13 13.41V19a1 1 0 1 1-2 0v-5.59l-3.29 3.3a1 1 0 0 1-1.42-1.42L9.59 12H4a1 1 0 1 1 0-2h5.59L6.29 6.71a1 1 0 0 1 1.42-1.42L11 8.59V3c0-.55.45-1 1-1z"
      />
    )
  },
  codex: {
    bg: '#0F8A6B',
    path: (
      <g fill="none" stroke="#fff" strokeWidth={1.9} strokeLinejoin="round">
        <path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z" />
        <path d="M12 8.2l3.3 1.9v3.8L12 15.8l-3.3-1.9v-3.8z" />
      </g>
    )
  },
  antigravity: {
    bg: '#5B3FD6',
    path: <path fill="#fff" d="M12 2c0 5.52-4.48 10-10 10 5.52 0 10 4.48 10 10 0-5.52 4.48-10 10-10-5.52 0-10-4.48-10-10z" />
  },
  shell: {
    bg: '#48484A',
    path: (
      <g fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 7l5 5-5 5M12.5 17.5H19" />
      </g>
    )
  }
}

export function AgentMark({ launcherKey, size = 30 }: { launcherKey: string; size?: number }): JSX.Element {
  const k = launcherKey.toLowerCase()
  const m = k.includes('claude')
    ? MARKS.claude
    : k.includes('codex')
      ? MARKS.codex
      : k.includes('antigravity') || k.includes('agy')
        ? MARKS.antigravity
        : MARKS.shell
  return (
    <span className="mark" style={{ width: size, height: size, background: m.bg }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} focusable="false">
        {m.path}
      </svg>
    </span>
  )
}
