import type { Terminal } from '@xterm/xterm'

// 中文輸入法（注音／拼音）打字時，不可以用程式去搶終端的 focus 或改它的尺寸。
//
// 為什麼：組字進行中時，還沒送出的字是放在 xterm 那個隱藏的 <textarea> 裡的。
// 程式呼叫 focus()（或 resize 造成重繪）會讓 Chromium 中止這次組字，
// 而被中止的內容會留在 textarea 裡沒被清掉。xterm 判斷「這次輸入法送了什麼」
// 用的是 textarea 內容的前後差異（CompositionHelper 的 _handleAnyTextareaChanges），
// 所以下一個組字鍵進來時，殘留的那段會被當成新輸入一起再送一次 ——
// 畫面上就是「打到一半的字又被貼上一次」。
//
// 真人點擊造成的 focus 不受影響：那是使用者自己要離開，瀏覽器會正常結束組字。

const composing = new WeakSet<Terminal>()

/** 在 term.open() 之後呼叫；回傳解除監聽的函式 */
export function trackComposition(term: Terminal): () => void {
  const ta = term.textarea
  if (!ta) return () => {}
  const start = (): void => {
    composing.add(term)
  }
  const end = (): void => {
    composing.delete(term)
  }
  ta.addEventListener('compositionstart', start)
  ta.addEventListener('compositionend', end)
  // 失焦時組字一定已經結束，殘留的旗標要清掉，否則之後都不會自動 focus 了
  ta.addEventListener('blur', end)
  return () => {
    ta.removeEventListener('compositionstart', start)
    ta.removeEventListener('compositionend', end)
    ta.removeEventListener('blur', end)
    composing.delete(term)
  }
}

export function isComposing(term: Terminal): boolean {
  return composing.has(term)
}

/** 組字中就不搶 focus（使用者本來就在打這個終端，不搶也不影響） */
export function focusTerm(term: Terminal): void {
  if (!composing.has(term)) term.focus()
}
