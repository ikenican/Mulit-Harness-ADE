import { useWorkbench, setLanguage as setStoreLanguage, type Language } from '@/store'

export type { Language }

export const translations = {
  en: {
    common: {
      ok: 'OK',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      delete: 'Delete',
      deleting: 'Deleting…',
      close: 'Close',
      retry: 'Retry',
      loading: 'Loading…',
      refresh: 'Refresh',
      edit: 'Edit',
      expand: 'Expand',
      collapse: 'Collapse',
      expandAll: 'Expand All',
      collapseAll: 'Collapse All',
      active: 'active',
      sessions: 'sessions',
      session: 'session',
      tokens: 'tokens',
      reset: 'Reset',
      testing: 'Testing…',
      unknown: 'Unknown'
    },
    header: {
      brand: 'Agent Workbench',
      collapseSidebar: 'Collapse sidebar',
      expandSidebar: 'Expand sidebar',
      sidebar: 'Sidebar',
      editor: 'Editor',
      preview: 'Preview',
      memory: 'Memory',
      browser: 'Browser',
      focusWorkspace: 'Focus / Maximize Workspace',
      exitFocus: 'Exit Focus Mode',
      dockRight: 'Dock terminals to the right',
      dockBottom: 'Dock terminals to the bottom',
      settingsTooltip: 'Settings, Appearance & Extensions'
    },
    sidebarTabs: {
      dashboard: 'Dashboard',
      files: 'Files',
      git: 'Git'
    },
    settings: {
      title: 'Settings',
      appearance: 'Appearance',
      cliAgents: 'CLI & Agents',
      documentTools: 'Document Tools',
      extensions: 'Extensions',
      appearanceTitle: 'Appearance',
      appearanceDesc: 'Select the interface appearance style and language for the workbench.',
      languageSection: 'Interface Language',
      languageDesc: 'Select your preferred display language for the entire workbench interface.',
      langEnglish: 'English',
      langEnglishSub: 'All UI text strictly in English',
      langZhTW: '繁體中文',
      langZhTWSub: 'Traditional Chinese (Taiwan)',
      themeSection: 'Interface Theme',
      lightMode: 'Light Mode',
      darkMode: 'Dark Mode',
      lightMorandi: 'Light Morandi',
      darkMorandi: 'Dark Morandi',
      integrationSection: 'Editor & Agent Integration',
      autoOpenFiles: 'Auto-Open Files Modified by Agent',
      autoOpenFilesDesc: 'When Claude, Antigravity, or Codex edits files in the terminal, automatically open them as editor tabs',
      liveLink: 'Live Link',
      cliTitle: 'CLI Tools & Agents',
      cliDesc: 'Decide which tools are active in the workbench and configure custom executable paths.',
      docToolsTitle: 'Document Tools',
      docToolsDesc: 'Configure external desktop viewers and editors for Office and PDF documents.',
      supportedTools: 'Supported Tools',
      resetToAuto: 'Reset to Auto',
      autoDetectAll: 'Auto-detect All',
      testPath: 'Test Path',
      detect: 'Detect',
      clear: 'Clear',
      browse: 'Browse…',
      test: 'Test',
      detected: 'Detected',
      notFound: 'Not detected',
      saveChanges: 'Save Settings',
      cancel: 'Cancel',
      closeEsc: 'Close (Esc)',
      docDefaultApp: 'System Default Application',
      validExecutable: 'Valid executable',
      selectExecutable: 'Select Executable',
      cliPermissionsSection: 'CLI Launch Permissions & Bypass Mode',
      cliPermissionsDesc: 'Configure whether AI agents should launch in bypass mode to skip interactive prompts.',
      cliBypassTitle: 'Bypass Permissions Mode',
      cliBypassSub: 'Automatically skip interactive approval prompts for commands and tools when launching AI agents',
      cliBypassWarning: 'Caution: In bypass mode, AI agents execute terminal bash commands, file modifications, and MCP tools directly without waiting for manual confirmation. Use only in trusted workspaces.',
      cliBypassActiveFlags: 'Active Bypass Launch Flags',
      cliBypassDisabledNotice: 'Standard Mode active — agents will prompt for confirmation before executing actions.',
      cliBypassModePill: 'Bypass Mode',
      footerCliHint: 'Toggled tools update immediately in Agent Terminal.',
      footerDocToolsHint: 'External tool paths are saved in user profile (~/AppData) and workspace.',
      footerGeneralHint: 'Settings are stored in user profile (~/AppData) and synced with workspace.'
    },
    dashboard: {
      telemetryTitle: 'Agent Telemetry & Usage',
      analyzingSessions: 'Analyzing workspace sessions...',
      updatedAt: 'Updated {time}',
      refreshTooltip: 'Refresh telemetry',
      workspaceTokens: 'Workspace Tokens',
      activeProcesses: 'Active Processes',
      totalSessions: 'Total Sessions',
      sessionsTab: 'Sessions ({count})',
      archivedTab: 'Archived ({count})',
      filterClear: 'Filtered: {name} ✕',
      expandAll: 'Expand All',
      collapseAll: 'Collapse All',
      currentWorkspace: 'Current Workspace',
      sessionSingular: 'session',
      sessionPlural: 'sessions',
      activeCount: '{count} active',
      tokenCount: '{count} tokens',
      totalTokensUnit: 'total tokens',
      noSessions: 'No active session records',
      noSessionsDesc: 'Launch Claude, Antigravity, or Codex from the Agent Terminals. Live token consumption will stream here.',
      noAgentsEnabled: 'All AI Agents are currently disabled in Settings',
      noAgentsEnabledDesc: 'To view telemetry and sessions, please enable Claude, Antigravity, or Codex in Settings > CLI Configurations.',
      noArchived: 'No archived sessions',
      noArchivedDesc: 'Sessions you archive will appear here.',
      switchCli: 'Switch CLI ➔',
      resumeCli: 'Resume CLI ➔',
      archive: 'Archive',
      restore: 'Restore',
      delete: 'Delete',
      deleteDialogTitle: 'Delete Session Record?',
      deleteDialogDesc: "This will permanently delete this session's telemetry and token metrics from the dashboard. This action cannot be undone.",
      deleteConfirm: 'Delete Record',
      analysisBadge: 'ANALYSIS',
      contextPrompt: 'Context & Prompts',
      toolExecution: 'Tool Execution',
      outputGeneration: 'Output Generation',
      categoryContext: 'Context & System Prompt',
      categoryTools: 'Tool Execution & Files',
      categoryThinking: 'Thinking & Generation',
      statusActive: 'Active',
      statusCompleted: 'Completed',
      statusIdle: 'Idle',
      statusWaitingApproval: 'Needs Approval',
      switchFolder: 'Switch to folder'
    },
    fileTree: {
      openFolder: 'Open Folder',
      refreshTree: 'Refresh file tree (Auto-updates enabled)',
      emptyWorkspace: 'This workspace is empty',
      loading: 'Loading…',
      retry: 'Retry',
      cannotReadDir: 'Cannot read directory'
    },
    editor: {
      noFileOpen: 'No file open',
      noFileOpenDesc: 'Click a file in the Files panel to start editing, or pick a changed file in the Git panel to view its diff.',
      editMode: 'Edit',
      diffMode: 'Diff',
      closeTab: 'Close tab',
      loading: 'Loading…',
      retry: 'Retry'
    },
    git: {
      stagedChanges: 'Staged Changes',
      changes: 'Changes',
      untrackedFiles: 'Untracked Files',
      recentCommits: 'Recent Commits',
      commitMsgPlaceholder: 'Commit message...',
      commit: 'Commit',
      committing: 'Committing…',
      stageAll: 'Stage All',
      unstageAll: 'Unstage All',
      discardChanges: 'Discard Changes',
      stage: 'Stage',
      unstage: 'Unstage',
      changesView: 'Changes',
      graphView: 'Graph',
      noChanges: 'No changes detected',
      branches: 'Branches',
      loading: 'Loading…'
    },
    terminal: {
      title: 'Terminals',
      newSession: 'New Terminal Session',
      newSessionDesc: 'Launch an interactive Claude, Antigravity, or Codex agent session, or a native PowerShell / CMD terminal.',
      launchSession: 'Launch Session →',
      launchShell: 'Launch Shell →',
      promptButton: '@ Prompt',
      promptTooltip: 'Open Agent Prompt Dispatcher (@)',
      splitSingle: 'Single',
      splitCols2: 'Split V',
      splitRows2: 'Split H',
      splitGrid4: 'Grid',
      awaitingApproval: '{count} Awaiting Approval'
    }
  },
  'zh-TW': {
    common: {
      ok: '確定',
      cancel: '取消',
      save: '儲存',
      saving: '儲存中…',
      saved: '已儲存',
      delete: '刪除',
      deleting: '刪除中…',
      close: '關閉',
      retry: '重試',
      loading: '載入中…',
      refresh: '重新整理',
      edit: '編輯',
      expand: '展開',
      collapse: '收合',
      expandAll: '展開全部',
      collapseAll: '摺疊全部',
      active: '活躍中',
      sessions: '個會話',
      session: '個會話',
      tokens: 'Tokens',
      reset: '重設',
      testing: '測試中…',
      unknown: '未知'
    },
    header: {
      brand: 'Agent Workbench',
      collapseSidebar: '收合側邊欄',
      expandSidebar: '展開側邊欄',
      sidebar: '側邊欄',
      editor: '編輯器',
      preview: '預覽',
      memory: '記憶庫',
      browser: '瀏覽器',
      focusWorkspace: '聚焦 / 最大化工作區',
      exitFocus: '結束聚焦模式',
      dockRight: '終端停靠至右側',
      dockBottom: '終端停靠至底部',
      settingsTooltip: '偏好設定、外觀與擴充'
    },
    sidebarTabs: {
      dashboard: '儀表板',
      files: '檔案',
      git: '版本控制'
    },
    settings: {
      title: '偏好設定',
      appearance: '外觀與顯示',
      cliAgents: 'CLI 工具與 Agent',
      documentTools: '文件應用工具',
      extensions: '擴充項目',
      appearanceTitle: '外觀與顯示',
      appearanceDesc: '設定工作台的使用者介面外觀風格與語言偏好。',
      languageSection: '介面語言',
      languageDesc: '選擇工作台所有選單、面板與遙測資訊的顯示語言。',
      langEnglish: 'English',
      langEnglishSub: '純英文模式 (Strict English)',
      langZhTW: '繁體中文',
      langZhTWSub: '標準繁體中文（台灣）',
      themeSection: '主題外觀',
      lightMode: '明亮淺色',
      darkMode: '經典深色',
      lightMorandi: '淺色莫蘭迪 (晨霧)',
      darkMorandi: '深色莫蘭迪 (暮靄)',
      integrationSection: '編輯器與 Agent 協同',
      autoOpenFiles: '自動開啟 Agent 修改的檔案',
      autoOpenFilesDesc: '當 Claude、Antigravity 或 Codex 在終端中編輯或新建檔案時，自動於編輯器開啟分頁',
      liveLink: '即時聯動',
      cliTitle: 'CLI 工具與 Agent',
      cliDesc: '設定工作台中啟用的 CLI 工具與 Agent，並自訂執行檔路徑。',
      docToolsTitle: '文件應用工具',
      docToolsDesc: '設定用於開啟 Office 與 PDF 文件的外部應用程式路徑。',
      supportedTools: '支援的工具與環境',
      resetToAuto: '重設為自動偵測',
      autoDetectAll: '全部自動偵測',
      testPath: '測試路徑',
      detect: '自動偵測',
      clear: '清除',
      browse: '瀏覽…',
      test: '測試',
      detected: '已偵測到',
      notFound: '未偵測到',
      saveChanges: '儲存設定',
      cancel: '取消',
      closeEsc: '關閉 (Esc)',
      docDefaultApp: '系統預設應用程式',
      validExecutable: '執行檔有效',
      selectExecutable: '選擇執行檔',
      cliPermissionsSection: 'CLI 啟動權限與略過模式',
      cliPermissionsDesc: '設定 AI Agent CLI 啟動時是否開啟略過模式以跳過終端互動式審批。',
      cliBypassTitle: '略過審批權限模式 (Bypass Mode)',
      cliBypassSub: '啟動 AI Agent CLI 時自動帶入 bypass 參數，略過終端互動式審批確認',
      cliBypassWarning: '注意事項：啟用略過模式後，AI 代理在執行終端指令、檔案修改與工具呼叫時將直接執行，無需於終端手動確認。請務必在可信工作區中使用。',
      cliBypassActiveFlags: '略過模式啟用時附帶之參數',
      cliBypassDisabledNotice: '目前為標準模式：AI 代理執行動作前會在終端提示確認 (y/n)。',
      cliBypassModePill: 'Bypass 模式',
      footerCliHint: '開關切換會立即於終端啟動板生效。',
      footerDocToolsHint: '外部工具路徑將儲存於使用者全域設定 (~/AppData) 與工作區。',
      footerGeneralHint: '設定將儲存於使用者全域設定 (~/AppData) 並同步至工作區。'
    },
    dashboard: {
      telemetryTitle: 'Agent 遙測與 Token 統計',
      analyzingSessions: '正在分析工作區會話紀錄...',
      updatedAt: '更新於 {time}',
      refreshTooltip: '重新整理遙測數據',
      workspaceTokens: '工作區累積 Tokens',
      activeProcesses: '活躍會話數',
      totalSessions: '總會話數',
      sessionsTab: '會話清單 ({count})',
      archivedTab: '已封存 ({count})',
      filterClear: '篩選：{name} ✕',
      expandAll: '展開全部',
      collapseAll: '摺疊全部',
      currentWorkspace: '當前工作區',
      sessionSingular: '個會話',
      sessionPlural: '個會話',
      activeCount: '{count} 個活躍中',
      tokenCount: '{count} Tokens',
      totalTokensUnit: '總 Tokens',
      noSessions: '尚無活躍的會話紀錄',
      noSessionsDesc: '在右側或底部開啟 Claude、Antigravity 或 Codex 終端，即時 Token 消耗與遙測數據將同步在此呈現。',
      noAgentsEnabled: '所有 AI Agent 目前已在設定中停用',
      noAgentsEnabledDesc: '若欲檢視 Agent 遙測與會話紀錄，請至「設定 ➔ CLI 設定」中開啟 Claude、Antigravity 或 Codex。',
      noArchived: '尚無已封存的會話',
      noArchivedDesc: '封存的會話記錄將會顯示於此處。',
      switchCli: '切換終端 ➔',
      resumeCli: '恢復會話 ➔',
      archive: '封存',
      restore: '還原',
      delete: '刪除',
      deleteDialogTitle: '確定刪除會話紀錄？',
      deleteDialogDesc: '這將從儀表板中永久移除此會話的遙測紀錄與 Token 統計數據。此動作無法復原。',
      deleteConfirm: '確認刪除',
      analysisBadge: '分析統計',
      contextPrompt: '系統與上下文提示詞',
      toolExecution: '工具執行與檔案讀寫',
      outputGeneration: '思考推論與回覆生成',
      categoryContext: '系統與上下文提示詞',
      categoryTools: '工具執行與檔案讀寫',
      categoryThinking: '思考推論與回覆生成',
      statusActive: '活躍中',
      statusCompleted: '已完成',
      statusIdle: '閒置',
      statusWaitingApproval: '等待授權',
      switchFolder: '切換資料夾'
    },
    fileTree: {
      openFolder: '開啟資料夾',
      refreshTree: '重新整理檔案樹 (已啟用自動更新)',
      emptyWorkspace: '此工作區目前為空',
      loading: '載入中…',
      retry: '重試',
      cannotReadDir: '無法讀取目錄'
    },
    editor: {
      noFileOpen: '未開啟任何檔案',
      noFileOpenDesc: '從檔案面板點擊檔案開始編輯，或由 Git 面板檢視版本差異。',
      editMode: '編輯',
      diffMode: '差異比對',
      closeTab: '關閉分頁',
      loading: '載入中…',
      retry: '重試'
    },
    git: {
      stagedChanges: '暫存變更 (Staged)',
      changes: '工作目錄變更',
      untrackedFiles: '未追蹤檔案',
      recentCommits: '最近提交紀錄',
      commitMsgPlaceholder: '輸入提交訊息...',
      commit: '提交變更',
      committing: '提交中…',
      stageAll: '暫存全部',
      unstageAll: '取消暫存全部',
      discardChanges: '捨棄變更',
      stage: '暫存',
      unstage: '取消暫存',
      changesView: '變更列表',
      graphView: '分支圖譜',
      noChanges: '目前無任何檔案變更',
      branches: '分支',
      loading: '載入中…'
    },
    terminal: {
      title: '終端機',
      newSession: '新終端會話',
      newSessionDesc: '啟動互動式 Claude、Antigravity 或 Codex 代理會話，或原生 PowerShell / CMD 終端機。',
      launchSession: '啟動會話 →',
      launchShell: '啟動終端 →',
      promptButton: '@ 提示詞',
      promptTooltip: '開啟代理提示詞分派器 (@)',
      splitSingle: '單一視窗',
      splitCols2: '垂直分割',
      splitRows2: '水平分割',
      splitGrid4: '四格分割',
      awaitingApproval: '{count} 個等待授權'
    }
  }
} as const

type NestedKeyOf<ObjectType extends object> = {
  [Key in keyof ObjectType & (string | number)]: ObjectType[Key] extends object
    ? `${Key}.${NestedKeyOf<ObjectType[Key]>}`
    : `${Key}`
}[keyof ObjectType & (string | number)]

export type TranslationKey = NestedKeyOf<typeof translations.en>

/**
 * 取得深層路徑的翻譯文字並支援參數置換，如 `Updated {time}`
 */
export function getTranslation(
  lang: Language,
  key: string,
  params?: Record<string, string | number>
): string {
  const dict = translations[lang] || translations.en
  const parts = key.split('.')
  let current: any = dict
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part]
    } else {
      // fallback to English
      let fallback: any = translations.en
      for (const fpart of parts) {
        if (fallback && typeof fallback === 'object' && fpart in fallback) {
          fallback = fallback[fpart]
        } else {
          return key
        }
      }
      current = fallback
      break
    }
  }

  if (typeof current !== 'string') {
    return key
  }

  if (params) {
    let result = current
    for (const [pKey, pVal] of Object.entries(params)) {
      result = result.replace(new RegExp(`\\{${pKey}\\}`, 'g'), String(pVal))
    }
    return result
  }

  return current
}

/**
 * React Hook：取得目前語言、切換語言函式以及翻譯函式 `t(key, params)`
 */
export function useTranslation(): {
  t: (key: TranslationKey | string, params?: Record<string, string | number>) => string
  language: Language
  setLanguage: (lang: Language) => void
} {
  const { language } = useWorkbench()

  const t = (key: TranslationKey | string, params?: Record<string, string | number>): string => {
    return getTranslation(language, key, params)
  }

  return {
    t,
    language,
    setLanguage: setStoreLanguage
  }
}
