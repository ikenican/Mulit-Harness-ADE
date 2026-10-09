import type { Terminal } from '@xterm/xterm'

// xterm 5.5 的 CompositionHelper 不讀 compositionend.data，而是從隱藏 textarea 用位置去切字串。
// 微軟注音組字緩衝區滿了會「先送出前段、後段繼續組字」，xterm 這時切到的範圍包含還在組字的後段，
// 後段之後又再送一次 → 重複。所以組字事件整組不讓 xterm 收到，改由這裡只送 compositionend.data。
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
  const view = el.querySelector<HTMLElement>('.composition-view')
  let imeInput = false
  let timer: ReturnType<typeof setTimeout> | undefined

  // 組字預覽：xterm 原本的 composition-view，位置自己算（xterm 的版本只在它自己組字時才動）
  const show = (text: string): void => {
    if (!view) return
    const screen = el.querySelector<HTMLElement>('.xterm-screen')
    const w = screen && term.cols ? screen.offsetWidth / term.cols : 0
    const h = screen && term.rows ? screen.offsetHeight / term.rows : 0
    const buf = term.buffer.active
    view.textContent = text
    view.style.left = `${Math.min(buf.cursorX, term.cols - 1) * w}px`
    view.style.top = `${buf.cursorY * h}px`
    view.style.height = view.style.lineHeight = `${h}px`
    view.style.fontFamily = term.options.fontFamily ?? ''
    view.style.fontSize = `${term.options.fontSize}px`
    view.classList.toggle('active', !!text)
  }
  const clearField = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      pending.delete(term)
      if (!composing.has(term) && !term.options.screenReaderMode) ta.value = ''
    }, 0)
  }

  const start = (e: Event): void => {
    e.stopPropagation()
    clearTimeout(timer)
    composing.add(term)
  }
  const update = (e: Event): void => {
    e.stopPropagation()
    show((e as CompositionEvent).data)
  }
  const end = (e: Event): void => {
    e.stopPropagation()
    composing.delete(term)
    pending.add(term)
    show('')
    const data = (e as CompositionEvent).data
    if (data) term.input(data, true)
    clearField()
  }
  const blur = (): void => {
    // 沒收到 compositionend 就失焦時，別讓 isImeKey 永遠擋住按鍵
    composing.delete(term)
    show('')
  }
  const keydown = (e: KeyboardEvent): void => {
    imeInput = e.key === 'Process' || e.keyCode === 229
  }
  const input = (e: Event): void => {
    const ev = e as InputEvent
    if (ev.inputType === 'insertText') {
      if (composing.has(term) || pending.has(term)) {
        // compositionend 已經送過這段字
        ev.stopImmediatePropagation()
      } else if (imeInput && ev.data) {
        // 注音直接上屏的標點等：只送這次的字，不讓 xterm 去 diff 整個 textarea
        term.input(ev.data, true)
        ev.stopImmediatePropagation()
      }
    } else if (imeInput && !composing.has(term) && ev.inputType === 'deleteContentBackward') {
      term.input('\x7f', true)
      ev.stopImmediatePropagation()
    }
    if (!composing.has(term) && !pending.has(term)) clearField()
  }

  // capture 階段掛在外層：stopPropagation 之後 xterm 掛在 textarea 上的組字 handler 不會執行
  el.addEventListener('compositionstart', start, true)
  el.addEventListener('compositionupdate', update, true)
  el.addEventListener('compositionend', end, true)
  el.addEventListener('keydown', keydown, true)
  el.addEventListener('input', input, true)
  ta.addEventListener('blur', blur)
  return () => {
    clearTimeout(timer)
    el.removeEventListener('compositionstart', start, true)
    el.removeEventListener('compositionupdate', update, true)
    el.removeEventListener('compositionend', end, true)
    el.removeEventListener('keydown', keydown, true)
    el.removeEventListener('input', input, true)
    ta.removeEventListener('blur', blur)
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
