// Adapted from AgentsDock (Apache-2.0), electron/src/renderer/src/lib/terminal-port-detection.ts
// https://github.com/ZhengyiLuo/AgentsDock

const LOCAL_URL_PATTERN =
  /http:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::(\d{1,5}))(?=[/?#\s)'"\]}>,.]|$)[^\s)'"\]}>,]*/gi
const ANSI_SEQUENCE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g

/** 只要 port：手機預覽用（桌面的 Remote Bridge 反向代理到 127.0.0.1:port） */
export function detectDevPort(output: string): number | null {
  const url = detectDevUrl(output)
  if (!url) return null
  const port = Number(/:(\d+)/.exec(url.replace('http://', ''))?.[1])
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null
}

/** 從終端輸出找出本機開發伺服器網址（必須帶 port、>=1024）；回傳最後一個。 */
export function detectDevUrl(output: string): string | null {
  const plain = output.replace(ANSI_SEQUENCE_PATTERN, '')
  let found: string | null = null
  for (const m of plain.matchAll(LOCAL_URL_PATTERN)) {
    const port = Number(m[1])
    if (!Number.isInteger(port) || port < 1024 || port > 65535) continue
    found = m[0].replace(/[.,;:!?]+$/, '').replace('0.0.0.0', 'localhost')
  }
  return found
}
