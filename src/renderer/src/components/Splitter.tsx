import { useCallback, useRef } from 'react'
import './splitter.css'

export type SplitterAxis = 'vertical' | 'horizontal'

/**
 * 可拖曳分隔線。vertical = 左右分欄（回報 dx）；horizontal = 上下分列（回報 dy）。
 * 用 setPointerCapture，拖出視窗外也不會斷。
 */
export default function Splitter({
  axis = 'vertical',
  onDelta,
  onReset,
  label,
  area
}: {
  axis?: SplitterAxis
  /** vertical：dx>0 為往右；horizontal：dy>0 為往下 */
  onDelta: (d: number) => void
  onReset: () => void
  label: string
  /** grid-area 名稱（父層用 grid-template-areas 排版時使用） */
  area?: string
}): JSX.Element {
  const last = useRef(0)
  const dragging = useRef(false)
  const isV = axis === 'vertical'

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragging.current = true
      last.current = isV ? e.clientX : e.clientY
      e.currentTarget.setPointerCapture(e.pointerId)
      document.body.classList.add(isV ? 'is-col-resizing' : 'is-row-resizing')
    },
    [isV]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      const cur = isV ? e.clientX : e.clientY
      const d = cur - last.current
      if (d === 0) return
      last.current = cur
      onDelta(d)
    },
    [isV, onDelta]
  )

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      dragging.current = false
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* 已釋放就忽略 */
      }
      document.body.classList.remove('is-col-resizing', 'is-row-resizing')
    },
    []
  )

  // 鍵盤操作：方向鍵微調，Shift 加速，Enter/Space 還原
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 64 : 16
      const dec = isV ? 'ArrowLeft' : 'ArrowUp'
      const inc = isV ? 'ArrowRight' : 'ArrowDown'
      if (e.key === dec) {
        e.preventDefault()
        onDelta(-step)
      } else if (e.key === inc) {
        e.preventDefault()
        onDelta(step)
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onReset()
      }
    },
    [isV, onDelta, onReset]
  )

  return (
    <div
      className={`splitter splitter-${axis}`}
      style={area ? { gridArea: area } : undefined}
      role="separator"
      aria-orientation={isV ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      title={`${label} — drag to resize, double-click to reset, arrow keys to nudge`}
    >
      <span className="splitter-grip" />
    </div>
  )
}
