import { sendToTerminal } from '@/store'
import './runnable-code.css'

// 可執行語言：agent 產生的指令多半標成這幾種
const SHELL_LANGS = new Set([
  'bash',
  'sh',
  'shell',
  'zsh',
  'console',
  'powershell',
  'ps',
  'ps1',
  'pwsh',
  'cmd',
  'bat',
  'batch'
])

export function isShellLang(className?: string): boolean {
  const m = /language-(\w+)/.exec(className || '')
  return !!m && SHELL_LANGS.has(m[1].toLowerCase())
}

/**
 * 包住 markdown 的 shell code block，右上角給一顆「送到終端」。
 * 刻意只貼上不執行 —— 要不要跑由使用者在終端按 Enter 決定。
 */
export default function RunnableCode({
  code,
  children
}: {
  code: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="runnable">
      <button
        className="runnable-btn"
        title="Paste into terminal (does not run — press Enter yourself)"
        onClick={() => sendToTerminal(code.replace(/\n$/, ''), 'shell')}
      >
        ▷ Send to terminal
      </button>
      {children}
    </div>
  )
}
