// 偵測 CLI 終端輸出是否停在「等待使用者審批」的提示上。
//
// ponytail: 純文字啟發式（各家 CLI 的提示字串），天花板是換皮就失準。
// 升級路徑：哪天某家 CLI 走結構化輸出（如 Claude Code 的 stream-json），
// 就替該家改用事件流判斷，不必動這裡的其他家。

const ANSI = /\[[0-9;?]*[A-Za-z]|\][^]*/g

/** 去掉 ANSI 控制碼，留下人看得到的字 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

// 常見審批提示：Claude Code / Codex / Antigravity 及一般 y/n 詢問
const APPROVAL_PATTERNS: RegExp[] = [
  /\bdo you want to\b/i,
  /\bwould you like to\b/i,
  /\ballow\b.*\?/i,
  /\bapprove\b/i,
  /\bproceed\?/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\[y\/N\]/,
  /\by\/n\b/i,
  /❯\s*1\.\s*(yes|allow)/i,
  /\b1\.\s*yes\b/i,
  /press\s+enter\s+to\s+confirm/i,
  /等待.*確認/,
  /是否(繼續|允許|執行)/
]

/**
 * 只看輸出的尾段（提示通常在最後幾行），避免整段歷史誤判。
 * 回 true 代表這個終端目前很可能卡在等你回答。
 */
export function looksLikeApprovalPrompt(chunk: string): boolean {
  const text = stripAnsi(chunk)
  const tail = text.slice(-600)
  return APPROVAL_PATTERNS.some((re) => re.test(tail))
}
