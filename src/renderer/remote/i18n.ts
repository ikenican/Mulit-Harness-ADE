// 手機端字串：依系統語言自動選繁中或英文（跟著 iPhone 設定走，不另設切換）。
// 按鈕用動詞開頭、說清楚按下去會發生什麼；同一個動作在整個流程用同一個詞。

const zh = {
  // 配對
  pairTitle: '連接電腦',
  pairDesc: '在電腦的 Agent Workbench 開啟「設定 → 遠端控制」，按「產生配對碼」，再輸入下方。',
  pairCode: '配對碼',
  deviceName: '這支手機的名稱',
  pair: '配對',
  pairing: '配對中…',
  pairInvalid: '配對碼不正確或已過期。請在電腦上重新產生一組。',
  pairFailed: '連不到電腦（{e}）。確認手機和電腦在同一個 Wi-Fi。',
  addToHomeTitle: '先加入主畫面',
  addToHome: '點 Safari 的分享按鈕 → 加入主畫面，從主畫面打開後再配對，才能收到通知。',
  // 連線
  connected: '已連線',
  connecting: '連線中…',
  offline: '連不到電腦，重試中',
  unauthorized: '這支手機已被取消配對，請重新配對。',
  // 首頁
  waitingCount: '{n} 個等你回覆',
  allQuiet: '沒有需要回覆的事',
  needsYou: '等你回覆',
  reply: '回覆',
  newTerminal: '新增終端',
  noSessions: '還沒有終端',
  noWindows: '電腦上沒有開啟專案視窗。請在電腦上開啟一個專案資料夾。',
  waiting: '等你回覆',
  running: '執行中',
  idle: '閒置',
  startedAgo: '{t}前開始',
  handoff: '交接筆記',
  git: 'Git 狀態',
  bypassTitle: 'Bypass 模式開啟中',
  bypass: 'Agent 會直接執行指令，不會先問你。',
  // 新增終端
  agents: 'Agent',
  shells: '終端機',
  cancel: '取消',
  // 終端
  read: '閱讀',
  terminal: '終端',
  more: '更多',
  fitWidth: '依手機寬度排版',
  fitWidthNote: '電腦上的畫面也會跟著變窄',
  endSession: '結束終端',
  endConfirmTitle: '結束「{title}」？',
  endConfirmBody: '程式會被停止，電腦上的分頁也會關閉。',
  exited: '已結束（代碼 {code}）',
  composer: '傳訊息或輸入指令',
  send: '送出',
  back: '返回',
  wants: '{title} 需要你決定',
  otherKeys: '其他按鍵',
  // 細節頁
  noHandoff: '這個專案還沒有交接筆記（.project-memory/handoff.md）。',
  clean: '沒有未提交的變更',
  changes: '{n} 個檔案有變更',
  loading: '載入中…',
  // 設定
  settings: '設定',
  done: '完成',
  computer: '電腦',
  thisPhone: '這支手機',
  notifications: '通知',
  notifFooter: 'Agent 等你回覆或任務結束時通知你。App 開著時不另外通知。',
  notifNeedsHome: '要收到通知，請先加入主畫面並從主畫面開啟。',
  notifDenied: '通知已被關閉。請到 iPhone 設定 → 通知 → Workbench 開啟。',
  unpair: '取消配對',
  unpairTitle: '取消這支手機的配對？',
  unpairBody: '之後要在電腦上產生新的配對碼才能再連線。',
  justNow: '剛剛',
  minutes: '{n} 分鐘',
  hours: '{n} 小時',
  language: '語言',
  langAuto: '跟隨系統',
  langFooter: '「跟隨系統」會依 iPhone 的語言設定自動選擇。',
  appearance: '外觀',
  themeLight: '淺色',
  themeDark: '深色',
  themeFooter: '「跟隨系統」會隨 iPhone 的淺色／深色模式自動切換。',
  bypassMode: 'Bypass 模式',
  bypassFooter: '開啟後，之後啟動的 Claude Code、Codex、Antigravity 會直接執行指令，不再詢問。已經在跑的 agent 不受影響。這個設定和電腦上的「CLI 工具與 Agent → Bypass」是同一個。',
  bypassConfirmTitle: '開啟 Bypass 模式？',
  bypassConfirmBody: 'Agent 將不經你同意就修改檔案、執行指令。電腦上會跳出通知。',
  bypassEnable: '開啟 Bypass 模式'
}

const en: typeof zh = {
  pairTitle: 'Connect to Your Computer',
  pairDesc: 'In Agent Workbench on your computer, open Settings → Remote Control, choose Generate Pairing Code, and enter it below.',
  pairCode: 'Pairing Code',
  deviceName: 'Name for This Phone',
  pair: 'Pair',
  pairing: 'Pairing…',
  pairInvalid: 'That code is wrong or expired. Generate a new one on your computer.',
  pairFailed: 'Can’t reach your computer ({e}). Make sure both are on the same Wi-Fi.',
  addToHomeTitle: 'Add to Home Screen first',
  addToHome: 'Tap Share in Safari → Add to Home Screen, then pair from the Home Screen app to get notifications.',
  connected: 'Connected',
  connecting: 'Connecting…',
  offline: 'Can’t reach your computer. Retrying',
  unauthorized: 'This phone was unpaired. Pair it again.',
  waitingCount: '{n} waiting for you',
  allQuiet: 'Nothing needs your reply',
  needsYou: 'Waiting for You',
  reply: 'Reply',
  newTerminal: 'New Terminal',
  noSessions: 'No terminals yet',
  noWindows: 'No project windows are open. Open a project folder on your computer.',
  waiting: 'Waiting',
  running: 'Running',
  idle: 'Idle',
  startedAgo: 'Started {t} ago',
  handoff: 'Handoff Notes',
  git: 'Git Status',
  bypassTitle: 'Bypass Mode is on',
  bypass: 'Agents run commands without asking first.',
  agents: 'Agents',
  shells: 'Shells',
  cancel: 'Cancel',
  read: 'Read',
  terminal: 'Terminal',
  more: 'More',
  fitWidth: 'Fit to Phone Width',
  fitWidthNote: 'The desktop view gets narrower too',
  endSession: 'End Terminal',
  endConfirmTitle: 'End “{title}”?',
  endConfirmBody: 'The program stops and its desktop tab closes.',
  exited: 'Ended (code {code})',
  composer: 'Message or command',
  send: 'Send',
  back: 'Back',
  wants: '{title} needs a decision',
  otherKeys: 'Other keys',
  noHandoff: 'This project has no handoff notes yet (.project-memory/handoff.md).',
  clean: 'No uncommitted changes',
  changes: '{n} changed files',
  loading: 'Loading…',
  settings: 'Settings',
  done: 'Done',
  computer: 'Computer',
  thisPhone: 'This Phone',
  notifications: 'Notifications',
  notifFooter: 'Get notified when an agent is waiting for you or a task finishes. Not sent while the app is open.',
  notifNeedsHome: 'To get notifications, add this app to your Home Screen and open it from there.',
  notifDenied: 'Notifications are off. Turn them on in iPhone Settings → Notifications → Workbench.',
  unpair: 'Unpair This Phone',
  unpairTitle: 'Unpair this phone?',
  unpairBody: 'You’ll need a new pairing code from your computer to connect again.',
  justNow: 'just now',
  minutes: '{n} min',
  hours: '{n} hr',
  language: 'Language',
  langAuto: 'System',
  langFooter: 'System follows your iPhone’s language setting.',
  appearance: 'Appearance',
  themeLight: 'Light',
  themeDark: 'Dark',
  themeFooter: 'System switches with your iPhone’s Light/Dark mode.',
  bypassMode: 'Bypass Mode',
  bypassFooter: 'When on, Claude Code, Codex and Antigravity started from now on run commands without asking. Agents already running aren’t affected. This is the same setting as CLI & Agents → Bypass on your computer.',
  bypassConfirmTitle: 'Turn on Bypass Mode?',
  bypassConfirmBody: 'Agents will edit files and run commands without your approval. Your computer will show a notification.',
  bypassEnable: 'Turn On Bypass Mode'
}

// 語言：跟隨系統（預設）、繁中或英文，存在這支手機的 localStorage
export type LangPref = 'auto' | 'zh-TW' | 'en'
const LANG_KEY = 'aw.remote.lang'

function readPref(): LangPref {
  try {
    const v = localStorage.getItem(LANG_KEY)
    return v === 'zh-TW' || v === 'en' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

let pref: LangPref = readPref()
let dict = resolve(pref)
const listeners = new Set<() => void>()

function resolve(p: LangPref): typeof zh {
  const zhOn = p === 'zh-TW' || (p === 'auto' && /^zh/i.test(navigator.language))
  document.documentElement.lang = zhOn ? 'zh-Hant' : 'en'
  return zhOn ? zh : en
}

export function getLangPref(): LangPref {
  return pref
}

export function setLangPref(p: LangPref): void {
  pref = p
  dict = resolve(p)
  try {
    if (p === 'auto') localStorage.removeItem(LANG_KEY)
    else localStorage.setItem(LANG_KEY, p)
  } catch {
    // 寫不進去就只在這次生效
  }
  for (const cb of listeners) cb()
}

/** 語言切換時讓整個畫面重畫 */
export function onLangChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export type Key = keyof typeof zh

export function t(key: Key, params?: Record<string, string | number>): string {
  let s = dict[key]
  if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v))
  return s
}

export function ago(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60000)
  if (m < 1) return t('justNow')
  if (m < 60) return t('minutes', { n: m })
  return t('hours', { n: Math.floor(m / 60) })
}
