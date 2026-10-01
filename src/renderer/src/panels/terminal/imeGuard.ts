import type { Terminal } from '@xterm/xterm'

// xterm 5.5 finalizes composition on non-229 keydown, then sends it again
// on compositionend. Its 229 fallback also diffs the entire retained textarea.
// Let compositionend own commits, and use InputEvent.data for IME passthrough.
const composing = new WeakSet<Terminal>()
const pending = new WeakSet<Terminal>()

export function isImeKey(term: Terminal, e: KeyboardEvent): boolean {
  return composing.has(term) || e.isComposing || e.key === 'Process' || e.keyCode === 229
}

/** 在 term.open() 之後呼叫；回傳解除監聽的函式 */
export function trackComposition(term: Terminal): () => void {
  const ta = term.textarea
  const el = term.element
  if (!ta || !el) return () => {}
  let imeInput = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const settle = (): void => {
    clearTimeout(timer)
    // Registered after xterm's compositionend listener: its commit flushes first.
    timer = setTimeout(() => {
      pending.delete(term)
      if (!composing.has(term) && !term.options.screenReaderMode) ta.value = ''
    }, 0)
  }
  const start = (): void => {
    clearTimeout(timer)
    if (!pending.has(term) && !term.options.screenReaderMode) ta.value = ''
    composing.add(term)
  }
  const end = (): void => {
    composing.delete(term)
    pending.add(term)
    settle()
  }
  const keydown = (e: KeyboardEvent): void => {
    imeInput = e.key === 'Process' || e.keyCode === 229
  }
  const input = (e: Event): void => {
    const ev = e as InputEvent
    if (ev.inputType === 'insertText') {
      if (composing.has(term) || pending.has(term)) {
        // The deferred composition commit already owns this text.
        ev.stopImmediatePropagation()
      } else if (imeInput && ev.data) {
        term.input(ev.data, true)
        ev.stopImmediatePropagation()
      }
    } else if (imeInput && !composing.has(term) && ev.inputType === 'deleteContentBackward') {
      term.input('\x7f', true)
      ev.stopImmediatePropagation()
    }
    if (!composing.has(term) && !pending.has(term)) settle()
  }
  el.addEventListener('keydown', keydown, true)
  el.addEventListener('input', input, true)
  el.addEventListener('compositionstart', start, true)
  ta.addEventListener('compositionend', end)
  ta.addEventListener('keyup', settle)
  ta.addEventListener('blur', end)
  return () => {
    clearTimeout(timer)
    el.removeEventListener('keydown', keydown, true)
    el.removeEventListener('input', input, true)
    el.removeEventListener('compositionstart', start, true)
    ta.removeEventListener('compositionend', end)
    ta.removeEventListener('keyup', settle)
    ta.removeEventListener('blur', end)
    composing.delete(term)
    pending.delete(term)
  }
}

export function isComposing(term: Terminal): boolean {
  return composing.has(term) || pending.has(term)
}

/** 組字中就不搶 focus（使用者本來就在打這個終端，不搶也不影響） */
export function focusTerm(term: Terminal): void {
  if (!isComposing(term)) term.focus()
}
