import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ICheck, IChevronLeft, IconMark, IWarning, IWifiOff } from './icons'
import { t } from './i18n'
import type { ConnState } from './conn'

// 手機端共用元件。行為比照 iOS（返回、sheet、確認、選單、開關），外觀沿用桌面版的泡泡與莫蘭迪色。

/** 導覽列：左右是玻璃圓鈕，中間標題；clear＝在頂端時透明（首頁用），捲動後才出現毛玻璃 */
export function NavBar({
  title,
  subtitle,
  backLabel,
  onBack,
  trailing,
  scrolled,
  clear,
  children
}: {
  title: string
  subtitle?: string
  backLabel?: string
  onBack?: () => void
  trailing?: ReactNode
  scrolled?: boolean
  clear?: boolean
  children?: ReactNode
}): JSX.Element {
  return (
    <header className={`navbar glass ${clear ? 'clear' : ''} ${scrolled ? 'scrolled' : ''}`}>
      <div className="navbar-row">
        {onBack ? (
          <button className="circle-btn press" onClick={onBack} aria-label={backLabel ? `${t('back')}：${backLabel}` : t('back')}>
            <IChevronLeft size={22} />
          </button>
        ) : (
          <span />
        )}
        <h1 className="navbar-title">
          <span>{title}</span>
          {subtitle && <span className="t-foot">{subtitle}</span>}
        </h1>
        <div style={{ justifySelf: 'center' }}>{trailing}</div>
      </div>
      {children}
    </header>
  )
}

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

/** 底部 sheet：浮起的大泡泡，有 grabber、可往下滑關閉、點背景關閉 */
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
    ref.current.style.transition = 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)'
    if (dy > 110) {
      ref.current.style.transform = 'translateY(110%)'
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

/** 破壞性動作的確認：同桌面 AppleAlertDialog 的樣子（染色圖示塊 + 標題 + 說明 + 兩顆膠囊鈕） */
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
      <div className="action-sheet" role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-msg">
        <div className="action-card">
          <IconMark tone="danger-mark" size={52}>
            <IWarning size={24} />
          </IconMark>
          <b id="confirm-title">{title}</b>
          <p id="confirm-msg">{message}</p>
          <div className="action-btns">
            <button className="destructive press" onClick={onConfirm}>
              {action}
            </button>
            <button className="cancel press" onClick={onCancel} autoFocus>
              {t('cancel')}
            </button>
          </div>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="menu-layer" onClick={onClose}>
      <div className="menu" role="menu" onClick={(e) => e.stopPropagation()}>
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

/** 斷線時浮在導覽列下方的膠囊（連上就消失） */
export function ConnCapsule({ state }: { state: ConnState }): JSX.Element | null {
  if (state === 'open' || state === 'unauthorized') return null
  const offline = state === 'closed'
  return (
    <div className={`conn pill ${offline ? 'danger' : 'idle'}`} role="status" aria-live="polite">
      {offline ? <IWifiOff size={16} /> : <span className="dot" />}
      {offline ? t('offline') : t('connecting')}
    </div>
  )
}
