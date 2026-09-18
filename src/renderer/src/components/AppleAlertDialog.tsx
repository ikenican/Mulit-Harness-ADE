import React, { useEffect } from 'react'
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
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onConfirm, onClose])

  if (!isOpen) return null

  return createPortal(
    <div className="apple-alert-backdrop" onClick={onClose}>
      <div
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
