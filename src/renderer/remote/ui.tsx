import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ICheck, IChevronLeft, IWifiOff } from './icons'
import { t } from './i18n'
import type { ConnState } from './conn'

// 手機端共用元件：行為比照 iOS 原生（導覽列、sheet、action sheet、下拉選單、開關）。

/** 導覽列：返回鍵用 chevron + 上一頁名稱（不用「返回」文字），捲動後加分隔線 */
export function NavBar({
  title,
  subtitle,
  backLabel,
  onBack,
  trailing,
  scrolled,
  children
}: {
  title: string
  subtitle?: string
  backLabel?: string
  onBack?: () => void
  trailing?: ReactNode
  scrolled?: boolean
  children?: ReactNode
}): JSX.Element {
  return (
    <header className={`navbar glass ${scrolled ? 'scrolled' : ''}`}>
      <div className="navbar-row">
        {onBack ? (
          <button className="nav-back" onClick={onBack} aria-label={`${t('back')}${backLabel ? `：${backLabel}` : ''}`}>
            <IChevronLeft size={24} />
            {backLabel && <span>{backLabel}</span>}
          </button>
        ) : (
          <span />
        )}
        <h1 className="navbar-title">
          <span>{title}</span>
          {subtitle && <span className="t-foot">{subtitle}</span>}
        </h1>
        <div className="nav-trailing">{trailing}</div>
      </div>
      {children}
    </header>
  )
}

/** 捲動超過大標題後，導覽列顯示小標題與分隔線 */
export function useScrolled(threshold = 40): boolean {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const on = (): void => setScrolled(window.scrollY > threshold)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [threshold])
  return scrolled
}

/** 底部 sheet：有 grabber、可往下滑關閉、點背景關閉 */
export function Sheet({
  title,
  onClose,
  leading,
  trailing,
  children
}: {
  title: string
  onClose: () => void
  leading?: ReactNode
  trailing?: ReactNode
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; dy: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const start = (e: React.TouchEvent): void => {
    const body = ref.current?.querySelector('.sheet-body')
    // 內容捲在中間時，往下滑是捲內容，不是關 sheet
    if (body && body.scrollTop > 0 && !(e.target as HTMLElement).closest('.sheet-grab, .sheet-head')) return
    drag.current = { y: e.touches[0].clientY, dy: 0 }
  }
  const move = (e: React.TouchEvent): void => {
    if (!drag.current || !ref.current) return
    drag.current.dy = Math.max(0, e.touches[0].clientY - drag.current.y)
    ref.current.style.transform = `translateY(${drag.current.dy}px)`
    ref.current.style.transition = 'none'
  }
  const end = (): void => {
    if (!drag.current || !ref.current) return
    const { dy } = drag.current
    drag.current = null
    ref.current.style.transition = 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)'
    if (dy > 110) {
      ref.current.style.transform = 'translateY(100%)'
      window.setTimeout(onClose, 200)
    } else {
      ref.current.style.transform = ''
    }
  }

  return (
    <div className="sheet-layer">
      <div className="scrim" onClick={onClose} />
      <div
        className="sheet"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onTouchStart={start}
        onTouchMove={move}
        onTouchEnd={end}
      >
        <div className="sheet-grab" aria-hidden="true" />
        <div className="sheet-head">
          <div>{leading}</div>
          <h2>{title}</h2>
          <div style={{ justifySelf: 'end' }}>{trailing}</div>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}

/** 破壞性動作的確認：iOS action sheet，取消永遠在最下面、粗體 */
export function ConfirmSheet({
  title,
  message,
  action,
  onConfirm,
  onCancel
}: {
  title: string
  message: string
  action: string
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <div className="sheet-layer">
      <div className="scrim" onClick={onCancel} />
      <div className="action-sheet" role="alertdialog" aria-label={title}>
        <div className="action-group">
          <p className="msg">
            <b>{title}</b>
            {message}
          </p>
          <button className="destructive" onClick={onConfirm}>
            {action}
          </button>
        </div>
        <div className="action-group">
          <button className="cancel" onClick={onCancel} autoFocus>
            {t('cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

export interface MenuItem {
  label: string
  note?: string
  icon?: ReactNode
  checked?: boolean
  destructive?: boolean
  onSelect: () => void
}

/** 導覽列右上角的 More 下拉選單 */
export function Menu({ items, onClose }: { items: MenuItem[]; onClose: () => void }): JSX.Element {
  return (
    <div className="menu-layer" onClick={onClose}>
      <div className="menu glass" role="menu" onClick={(e) => e.stopPropagation()}>
        {items.map((it) => (
          <button
            key={it.label}
            role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={it.checked}
            className={it.destructive ? 'destructive' : ''}
            onClick={() => {
              onClose()
              it.onSelect()
            }}
          >
            {it.checked !== undefined && <span className="check">{it.checked && <ICheck size={18} />}</span>}
            <span className="item-main">
              {it.label}
              {it.note && <span className="item-note">{it.note}</span>}
            </span>
            {it.icon}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Switch({
  checked,
  disabled,
  label,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <span className="switch">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </span>
  )
}

/** 斷線時浮在導覽列下方的狀態膠囊（連上就消失，不佔版面） */
export function ConnCapsule({ state }: { state: ConnState }): JSX.Element | null {
  if (state === 'open' || state === 'unauthorized') return null
  const offline = state === 'closed'
  return (
    <div className={`conn glass ${offline ? 'offline' : ''}`} role="status" aria-live="polite">
      {offline && <IWifiOff size={18} />}
      {offline ? t('offline') : t('connecting')}
    </div>
  )
}
