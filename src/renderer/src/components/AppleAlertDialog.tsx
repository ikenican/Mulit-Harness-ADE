import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { IconTrash, IconFolderMinus } from './Icons'
import './appleAlertDialog.css'

export interface AppleAlertDialogProps {
  isOpen: boolean
  title: string
  description?: string
  detail?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  isDestructive?: boolean
  icon?: React.ReactNode
  onConfirm: () => void | Promise<void>
  onClose: () => void
}

export default function AppleAlertDialog({
  isOpen,
  title,
  description,
  detail,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  isDestructive = true,
  icon,
  onConfirm,
  onClose
}: AppleAlertDialogProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef({ onClose, onConfirm })
  actionsRef.current = { onClose, onConfirm }
  useEffect(() => {
    if (!isOpen) return
    const previousFocus = document.activeElement as HTMLElement | null
    dialogRef.current?.querySelector<HTMLButtonElement>('.apple-alert-btn-cancel')?.focus()
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        actionsRef.current.onClose()
      } else if (e.key === 'Tab') {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')
        if (!controls?.length) return
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      } else if (e.key === 'Enter' && document.activeElement?.tagName !== 'BUTTON') {
        e.preventDefault()
        e.stopPropagation()
        actionsRef.current.onConfirm()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      previousFocus?.focus()
    }
  }, [isOpen])

  if (!isOpen) return null

  return createPortal(
    <div className="apple-alert-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="apple-alert-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="apple-alert-title"
        aria-describedby="apple-alert-desc"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Icon Badge */}
        <div className={`apple-alert-icon-wrap ${isDestructive ? 'destructive' : ''}`}>
          {icon || (isDestructive ? <IconTrash size={22} /> : <IconFolderMinus size={24} />)}
        </div>

        {/* Content */}
        <div className="apple-alert-content">
          <h3 id="apple-alert-title" className="apple-alert-title">
            {title}
          </h3>
          {description && (
            <p id="apple-alert-desc" className="apple-alert-desc">
              {description}
            </p>
          )}

          {detail && <div className="apple-alert-detail">{detail}</div>}
        </div>

        {/* Button Actions: Cancel (Leading) and Action (Trailing) per Apple HIG */}
        <div className="apple-alert-actions">
          <button
            type="button"
            className="apple-alert-btn apple-alert-btn-cancel"
            onClick={onClose}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`apple-alert-btn ${
              isDestructive ? 'apple-alert-btn-destructive' : 'apple-alert-btn-primary'
            }`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
