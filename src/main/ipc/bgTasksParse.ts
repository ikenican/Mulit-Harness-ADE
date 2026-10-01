// 各 Agent 背景任務的純解析（不依賴 Electron，可用 node 直接跑 scripts/check-bgTasks.mts 驗證）
import type { BgTask } from '../../preload/index'

const desc = (s: unknown): string => String(s ?? '').split('\n')[0].slice(0, 120)

function* jsonLines(text: string, mustInclude: string[]): Generator<Record<string, any>> {
  for (const line of text.split('\n')) {
    if (!mustInclude.some((k) => line.includes(k))) continue
    try {
      yield JSON.parse(line)
    } catch {
      // 寫到一半的最後一行或非 JSON
    }
  }
}

// ---------- Claude ----------
// 只認開頭，且要對得上工具：指令輸出裡剛好印出這句話（例如 grep 逐字稿）不算
const claudeLaunched = (tool: string | undefined, text: string): boolean =>
  tool === 'Bash' ? /^\s*Command running in background with ID/.test(text) : /^\s*Async agent launched/.test(text)
const CLAUDE_NOTIFY =
  /<tool-use-id>(\w+)<\/tool-use-id>[\s\S]*?<status>(\w+)<\/status>(?:[\s\S]*?<summary>([\s\S]*?)<\/summary>)?/g

/** 工具結果可能是字串或 [{ type: 'text' | 'input_text', text }] */
function firstText(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? String(content.find((x) => typeof x?.text === 'string')?.text ?? '') : ''
}

/**
 * Claude Code：run_in_background 的 Bash、背景 subagent。
 * 啟動：tool_result 開頭是「running in background」；結束：<task-notification> 帶同一個 tool-use-id。
 */
export function claudeBgTasks(text: string): BgTask[] {
  const uses = new Map<string, { tool: string; desc: string; startedAt: string }>()
  const tasks = new Map<string, BgTask>()
  for (const o of jsonLines(text, ['tool_', 'task-notification'])) {
    const content = o.message?.content
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'tool_use') {
          const input = c.input || {}
          uses.set(c.id, { tool: c.name, desc: desc(input.description || input.command || c.name), startedAt: o.timestamp || '' })
        } else if (c?.type === 'tool_result' && claudeLaunched(uses.get(c.tool_use_id)?.tool, firstText(c.content))) {
          const u = uses.get(c.tool_use_id)
          tasks.set(c.tool_use_id, {
            agent: 'claude',
            id: c.tool_use_id,
            desc: u?.desc || c.tool_use_id,
            startedAt: u?.startedAt || o.timestamp || '',
            status: 'running'
          })
        }
      }
    }
    // 通知可能出現在 user 訊息字串或 queue-operation 欄位，直接掃整筆
    for (const m of JSON.stringify(o).matchAll(CLAUDE_NOTIFY)) {
      const t = tasks.get(m[1])
      if (t) Object.assign(t, { status: m[2], summary: m[3]?.replace(/\\"/g, '"'), endedAt: o.timestamp })
    }
  }
  return [...tasks.values()]
}

// ---------- Codex ----------
const CODEX_CMD = /exec_command\(\s*\{\s*cmd\s*:\s*("(?:[^"\\]|\\.)*")/g

/**
 * Codex：exec 工具呼叫已回傳、但裡面的 exec_command 行程還沒結束＝背景執行。
 * 呼叫：custom_tool_call（JS 原始碼，取 cmd 字串）；結束：item_completed 的 CommandExecution（command 最後一段就是 cmd）。
 * Codex 只在行程結束時記錄，所以必須拿呼叫與結束配對。
 */
export function codexBgTasks(text: string): BgTask[] {
  // 還沒回傳的呼叫：call_id → 尚未結束的 cmd
  const pending = new Map<string, { cmds: string[]; startedAt: string }>()
  const tasks: (BgTask & { cmd: string })[] = []
  for (const o of jsonLines(text, ['custom_tool_call', 'CommandExecution'])) {
    const p = o.payload || {}
    if (p.type === 'custom_tool_call' && p.name === 'exec') {
      const cmds: string[] = []
      for (const m of String(p.input || '').matchAll(CODEX_CMD)) {
        try {
          cmds.push(JSON.parse(m[1]))
        } catch {
          // JS 專屬跳脫（\' 等）解不開就略過這條
        }
      }
      if (cmds.length) pending.set(p.call_id, { cmds, startedAt: o.timestamp || '' })
    } else if (p.type === 'custom_tool_call_output') {
      const call = pending.get(p.call_id)
      pending.delete(p.call_id)
      // 腳本本身失敗／出錯＝指令沒真的跑起來
      if (/^Script (failed|error)/.test(firstText(p.output))) continue
      call?.cmds.forEach((cmd, i) =>
        tasks.push({ agent: 'codex', id: `${p.call_id}-${i}`, desc: desc(cmd), cmd, startedAt: call.startedAt, status: 'running' })
      )
    } else if (p.type === 'item_completed' && p.item?.type === 'CommandExecution') {
      const cmd = String((p.item.command || []).at(-1) ?? '')
      // 先當前景指令消掉；不是的話才去結束對應的背景任務
      const call = [...pending.values()].find((c) => c.cmds.includes(cmd))
      if (call) {
        call.cmds.splice(call.cmds.indexOf(cmd), 1)
        continue
      }
      const t = tasks.find((x) => x.status === 'running' && x.cmd === cmd)
      if (t) {
        t.status = p.item.status === 'completed' && !p.item.exit_code ? 'completed' : 'failed'
        t.summary = `exit code ${p.item.exit_code ?? '?'}`
        t.endedAt = o.timestamp
      }
    }
  }
  return tasks.map(({ cmd: _cmd, ...t }) => t)
}

// ---------- Antigravity ----------
const AG_LAUNCHED = /^Created At: [^\n]*\nTool is running as a background task with task id: (\S+)\nTask Description: ([^\n]*)/
const AG_DONE = /Task id "([^"]+)" (finished|was canceled) with result:\s*(?:The command exited with code (-?\d+))?/

/** Antigravity：啟動是 GENERIC 步驟的固定開頭；結束是 SYSTEM_MESSAGE「Task id "…" finished／was canceled with result」 */
export function antigravityBgTasks(text: string): BgTask[] {
  const tasks = new Map<string, BgTask>()
  for (const o of jsonLines(text, ['background task', 'with result'])) {
    const content = String(o.content || '')
    const start = o.type === 'GENERIC' && content.match(AG_LAUNCHED)
    // 「Timer: 2s, Prompt: …」是 Agent 自己的等待計時器，不是工作，也不會有結束訊息
    if (start && start[2].startsWith('Timer:')) continue
    if (start) {
      tasks.set(start[1], { agent: 'antigravity', id: start[1], desc: desc(start[2]), startedAt: o.created_at || '', status: 'running' })
      continue
    }
    const done = o.type === 'SYSTEM_MESSAGE' && content.match(AG_DONE)
    const t = done && tasks.get(done[1])
    if (t && done) {
      const code = done[3]
      t.status = done[2] !== 'finished' ? 'killed' : !code || code === '0' ? 'completed' : 'failed'
      if (code) t.summary = `exit code ${code}`
      t.endedAt = o.created_at
    }
  }
  return [...tasks.values()]
}
