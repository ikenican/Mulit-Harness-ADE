// 把 CLI 停在「等你回答」的畫面解析成問題與選項，讓手機顯示成有文字的按鈕，
// 而不是讓人對著「1 / 2 / 3」猜意思。純文字啟發式：解析不出來就回 null，畫面退回通用按鍵。

export interface PromptOption {
  /** 按下去要送給 pty 的按鍵 */
  key: string
  label: string
  /** CLI 目前游標所在（按 Enter 會選到的）選項 */
  selected: boolean
}

export interface ParsedPrompt {
  question: string
  /** 問題上方的說明（例如要執行的指令），最多幾行 */
  details: string[]
  options: PromptOption[]
}

// 框線字元：Claude Code / Codex 的 TUI 會把提示包在框裡
const BOX = /[│┃║╭╮╰╯┌┐└┘├┤─━═┏┓┗┛]/g

function clean(line: string): string {
  return line.replace(BOX, ' ').replace(/\s+$/, '').replace(/^\s+/, '')
}

const OPTION = /^([❯›>▶→]\s*)?(\d)[.)]\s+(.+)$/

export function parsePrompt(screen: string): ParsedPrompt | null {
  const lines = screen.split('\n').map(clean)

  // y/n 形式：最後幾行有 (y/n) / [Y/n]
  const tail = lines.filter(Boolean).slice(-4)
  const yn = tail.find((l) => /[([]\s*y\s*\/\s*n\s*[)\]]/i.test(l))
  if (yn) {
    return {
      question: yn.replace(/[([]\s*y\s*\/\s*n\s*[)\]]/i, '').trim(),
      details: [],
      options: [
        { key: 'y', label: 'Yes', selected: /\[Y\/n\]/.test(yn) },
        { key: 'n', label: 'No', selected: /\[y\/N\]/.test(yn) }
      ]
    }
  }

  // 由下往上找最後一組連號選項（1. 2. 3.）
  let end = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION.test(lines[i])) {
      end = i
      break
    }
  }
  if (end === -1) return null
  let start = end
  // 往上吃掉連號選項；選項折行的那一行夾在兩個選項之間，上面一兩行內還有選項才算
  const optionAbove = (i: number): boolean => OPTION.test(lines[i - 1] || '') || OPTION.test(lines[i - 2] || '')
  while (
    start > 0 &&
    (OPTION.test(lines[start - 1]) ||
      (lines[start - 1] && !/[?？:：]$/.test(lines[start - 1]) && optionAbove(start - 1)))
  ) {
    start--
  }

  // 最後一個選項也可能折行：往下吃到空行為止（框線已被清成空字串）
  while (end + 1 < lines.length && lines[end + 1] && !OPTION.test(lines[end + 1])) end++

  const options: PromptOption[] = []
  for (let i = start; i <= end; i++) {
    const m = OPTION.exec(lines[i])
    if (m) options.push({ key: m[2], label: m[3].trim(), selected: !!m[1] })
    // 選項文字太長被折行
    else if (options.length && lines[i]) options[options.length - 1].label += ` ${lines[i]}`
  }
  // Codex 之類在選項尾巴標快捷鍵：「Yes, proceed (y)」、「No (esc)」——折行接好之後再解析
  for (const o of options) {
    const hint = /\s*\((esc|[a-z])\)$/i.exec(o.label)
    if (hint) {
      o.label = o.label.slice(0, hint.index).trim()
      // 字母快捷鍵直接送；(esc) 只是說明，照樣送選項編號
      if (hint[1].toLowerCase() !== 'esc') o.key = hint[1].toLowerCase()
    }
  }
  if (options.length < 2) return null

  // 選項上方八行內最近的問句當 question；問句與選項之間（例如 Codex 的指令）和問句上方一段當 details
  let q = -1
  for (let i = start - 1; i >= Math.max(0, start - 8); i--) {
    if (/[?？]$/.test(lines[i])) {
      q = i
      break
    }
  }
  if (q === -1) {
    q = start - 1
    while (q >= 0 && !lines[q]) q--
  }
  if (q < 0) return { question: '', details: [], options }
  const question = lines[q]
  const above: string[] = []
  for (let i = q - 1; i >= 0 && above.length < 4; i--) {
    if (!lines[i]) {
      if (above.length) break
      continue
    }
    above.unshift(lines[i])
  }
  const between = lines.slice(q + 1, start).filter(Boolean)
  const details = [...above, ...between].slice(-4)
  return { question, details, options }
}

/** 從 server 送來的（去掉 ANSI 的）尾段找一行問句，給首頁卡片當預覽 */
export function questionPreview(tail: string): string | null {
  const lines = tail
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean)
    .slice(-12)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/[?？]$/.test(lines[i]) && lines[i].length < 140) return lines[i]
  }
  return null
}
