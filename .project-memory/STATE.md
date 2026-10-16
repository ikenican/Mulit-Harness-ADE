# Project State

- Milestone: Windows v0.1.41 released 2026-10-16, tag 1c7cf17, public Latest: phone Cowork desktop parity (PR #44), opt-in custom harness/native Skills/MCP/Plugins/Hooks editing (PR #45), version/docs PR #46. Installer, portable ZIP, blockmap and latest.yml published and verified. Linux remains linux-v0.1.0 prerelease.
- Previous: v0.1.40 released 2026-10-09 (851b185): phone Cowork #42 and independent Linux source/CI #41; Linux linux-v0.1.0 published 2026-10-09. v0.1.39 introduced Cowork discussions, recorder, chair decisions and approved execution.
- Status: PR #44 merged 2bbdd37; #45 merged 9f256da after memory-only conflict resolution; #46 merged 1c7cf17. No open PRs at release verification. Main fast-forwarded, release tag pushed; feature/release/local test branches retained.
- Validation: 0.1.41 typecheck/dist, custom-agent/approval/remote checks and both feature UI regressions passed. Packaged ASAR renderer/preload/custom-launcher/native-PTY smoke passed. ZIP executable/ASAR/native module hashes, uploaded SHA256 digests and updater SHA512/size/version verified. Earlier combined-source Cowork suite passed; no application code changed afterward. No physical iPhone, real third-party harness or full NSIS install tested.
- Linux (DEC-011 / Issue #40): independent apps/linux v0.1.0, linux-v0.1.0 prerelease published 2026-10-09; separate dependencies/settings/identity/update flow. No Linux changes in Windows 0.1.41. Other distributions and ARM64 remain unverified; Linux updater checks newest 100 releases.
- Last updated: 2026-10-16


## Macro Progress
- [x] Phase 0 專案骨架：Electron + Vite + React + Monaco 三欄殼
- [x] Phase 1 Git 中樞 + ShareProjectMem 檢視器
- [x] Phase 2 多 CLI 終端殼（xterm + node-pty，Claude / Antigravity + 一般 shell）
- [x] Phase 3 硬體 MCP：**刻意未做** —— 曾建置一組通用工具，經檢討多為冗餘
      （agent 本來就能跑 shell 與讀檔），已整包移除；骨架保留，有真實腳本再掛
- [x] Phase 4 面板整合：待審批紅點、handoff 路徑跳轉、OS 通知
- [x] Customized 面板：跨 agent 的 Skill / MCP / Plugin 一覽與同步、Connections
- [x] 版面可拖曳、終端可停靠右／下、終端分割顯示
- [x] 編輯器多檔分頁（切分頁不丟未存檔編輯）
- [x] 打包發佈（electron-builder，NSIS；已實測 `npm run pack` 產物可啟動）
- [x] Git Commit Graph 視覺化（GitGraphView 拓撲與提交歷史檢視）
- [x] Dashboard 面板：Agent 會話歷史、Token 統計與 Apple HIG 原生警告彈窗
- [x] Settings 與 Browser 面板：全域設定持久化與內建瀏覽器
- [x] Git Commit 點選即時開啟 Diff 比對（Monaco DiffEditor，支援歷史 Commit 比對與檔案切換）
- [x] Preview 預覽面板全域分頁同步（修正關閉殘留）與 Git 歷史版本 Markdown 預覽
- [x] Antigravity CLI 會話防禦降級（解決 conversation not found）
- [x] 中央工作區分段順序優化（Editor / Preview / Memory / Browser）
- [x] Office & PDF 整合：Editor 內建 DocumentViewer（Word/Excel/PowerPoint/PDF）與 Settings 自訂外部工具路徑及自動偵測
- [x] 雙語系 i18n 支援：支援 Strict English 與繁體中文切換，全域面板與 Settings 全面對接
- [x] 檔案樹即時自動監聽與工作區切換連動：後端 fs.watch 廣播、點擊 Session 卡片資料夾無縫切換根目錄
- [x] Dashboard 會話摺疊分組與遙測精準校準：消除幽靈會話、精準校準 Active/Completed 狀態與真實 Token 計算
- [x] 終端 Launchpad 頂部滾動卡住修復與 Mobile Dispatch 完整架構規劃完稿
- [x] v0.1.1 正式發布：整合外部 PR #2 (Codex 擴充掃描與真實會話 Token 統計)、雙語系 i18n 完整實作、資料夾分組與一鍵工作區切換連動、遙測精準校準與終端滾動修正
- [x] v0.1.2 正式發布：開機效能優化（mtime 磁碟持久化快取、面板按需掛載 Mount-on-Demand、冷開機 42 倍加速）、Dashboard 與 Settings CLI 啟用/停用動態連動（即時過濾遙測卡片、會話與資料夾群組，全停用導引橫幅）
- [x] v0.1.3 正式發布：新增 CLI 啟動權限 Bypass Mode（Claude, Codex, Antigravity 官方免審批與跳過權限參數注入、全域設定持久化、終端即時懸浮徽章與排版優化）
- [x] v0.1.4 正式發布：Settings 設定持久化修復、外部文件工具自訂偵測與整合優化
- [x] v0.1.5 正式發布：一鍵安裝腳本體驗升級（curl 即時下載進度條、NSIS 靜默安裝計時 spinner、環境變數單次自清、檔案鎖定與串流釋放防護）、維護者發布權限安全說明與自動偵測 Program Files 之 gh.exe 路徑支援
- [x] README 安裝指令加固：全數標準化為簡潔單行指令，徹底消除 ampersand 語法解析錯誤風險
- [x] v0.1.6 正式發布：Dashboard 視窗內卡片原生拖曳排序與跨資料夾歸類（方案 A，發光中線指示、localStorage 持久化）、活躍 Session 識別與專案路徑反解（Antigravity 緩衝區擴增至 512KB + 尾部 64KB、Claude 破壞性 replace 修正與 Windows 目錄 mtime 穿透、SQLite 二進位工作區反解、PTY 30 分鐘時間窗口）、終端會話聚焦重複啟動防護（PR #9）
- [x] v0.1.8 正式發布：終端／Dashboard 交界五修——TermInstance remount 重複 spawn 導致
      輸入每字重複兩次（旗標改放 session 物件）、終端開的 CLI 改事件驅動即時出現在
      Dashboard、移除只比對 agent 種類的跳轉後備（終於能開第二支同型 CLI）、以
      `closedAgentSessions` 修正關閉後卡 active（保留 main 的 mtime 判斷以支援 App 外
      自跑的 CLI，見 DEC-003）、修好從未執行過的開機自動檢查更新
- [x] v0.1.12 正式發布：Settings 一鍵下載與安裝三家 Agent CLI（Claude, Codex, Antigravity）、Apple HIG 風格確認對話框、健全路徑驗證與結果持久化
- [x] v0.1.13 正式發布：純自動檢查更新開關（即時持久化、預設不自動下載）、Compress-Archive OneDrive 瞬態檔案鎖重試迴圈
- [x] v0.1.14 正式發布：Antigravity CLI 即時追蹤強化、Apple HIG 移除對話框重設計、資料夾還原
- [x] v0.1.15 正式發布：預設空工作區、使用者選取資料夾還原、安裝後自動啟動
- [x] v0.1.16 正式發布：Claude Code 與 Codex CLI 官方 PowerShell 安裝指令
- [x] v0.1.17 正式發布：Settings 版面優化、各 agent 縮圖獨立開關、doctool 設定持久化
- [x] v0.1.18 正式發布：About & Updates 分頁改為 Apple HIG Inset Grouped 版面
- [x] v0.1.19 正式發布：`isInstalledApp()` 只認 NSIS 解除安裝程式——原本 `isProtectedPath(exeDir)` 恆 true，
      可攜版被當安裝版而靜默另裝到 `%LOCALAPPDATA%\Programs`，重開舊捷徑即退回舊版
- [x] v0.1.20 正式發布（PR #13）：Vibe Coding 模式第一階段——圖示列懸停淡入／點擊固定的
      Sessions/Status/Handoff/Files/Git 面板、終端上方 token 狀態列、dev server 網址自動開啟
      （改寫自 AgentsDock, Apache-2.0）、Handoff 摘要；token 用量改為全歷史每日桶
      （Claude 依 message.id 去重、Antigravity 僅 transcript 估算），修正終端最底行被裁、
      dev/安裝版共用 userData；README 同步更新
- [x] v0.1.21 正式發布（PR #14）：Dashboard session 清單自動更新（移除永遠卡住首次結果的
      activeScanPromise 去重）、多視窗「當前工作區」改由各 renderer 判斷、main 端不再以聚焦視窗
      `workspace.root` 歸屬 session、`dashboard-cache.json` 移到 userData（版本 3）；README 同步更新
- [x] v0.1.22 正式發布（PR #15）：Windows CLI 安裝改為官方單行 PowerShell 指令，顯示指令與實際執行一致
- [x] v0.1.23 正式發布（PR #16）：iPhone Remote Control PWA、HTTPS/WSS、本機 CA、配對/撤銷裝置與 Web Push
- [x] v0.1.24 正式發布（PR #17）：手機預覽 dev server、工作區選擇、多電腦切換、終端手機寬度與安全修正
- [x] v0.1.25 正式發布（PR #18）：Remote Control 設定頁可選連線 IP；安裝憑證 URL、App URL 與配對 QR 同步使用所選網卡位址
- [x] v0.1.26 formally released (PR #19): Windows Claude Code MCP servers launched with npx now run through cmd.exe /c.
- [x] v0.1.27 formally released (PR #20): mobile remote terminal width fitting, home page session overflow, and Chinese IME Ctrl+V fix.
- [x] v0.1.29 released (PR #22): Vibe Status pane shows Claude / Codex / Antigravity background tasks; Status rows no longer collapse.
- [x] v0.1.30 released (PR #23): vibe mode uses the dev-mode theme accent (no separate purple palette).
- [x] v0.1.31 released (PR #24): mobile native terminal scrolling, single-row shortcut keys, Vibe Status and read-only Markdown/PDF/HTML File previews.
- [x] v0.1.32 released (PR #25, PR #26): mobile workspace folding with persistence and mobile terminal native dual-axis scrolling without desktop resize.
- [x] v0.1.33 released (PR #27): mobile terminal responsive auto-fit without horizontal scroll or desktop resize.
- [x] v0.1.34 released (PR #28): mobile terminal canvas scale-to-fit (Plan A) preserving 1:1 desktop ANSI coordinates (120/160 cols), eliminating horizontal scroll, fixing cursor-addressed redraws/divider wrapping, with smooth native vertical history swipe.
- [x] v0.1.35 released (PR #29): desktop-size ANSI parsing followed by readable wrapped mobile text (DEC-006), vertical-only native scrolling, and stable session/tab/resize restores; installer, portable ZIP and updater assets published.
- [x] 終端跨 Agent 歷史回溯強化（DEC-007）：Codex CLI 自動注入 `--no-alt-screen` 保留縱向 scrollback 串流；手機端 Claude Code 透過 `ClaudeHistoryStream` 攔截轉換清螢幕代碼為換行與回合分隔線，完整保留多回合歷史縱向查閱能力且不干擾手機端 prompt 送出與審批。
- [~] 原 v0.1.14 規劃項：Dashboard 的 Clone Repo 與 Archived 分頁已在 UI 上確認存在（2026-09-24 截圖）；
      JumpList 連動仍未驗證
- [x] v0.1.7 正式發布：Issue #10 完全收尾——Dashboard 的 active 狀態改由 renderer 提供事實
      （終端分頁活著即 active，見 DEC-002），不再靠 main 端 PTY meta ＋ jsonl mtime 推斷；
      併修 `pty:spawn` 自訂 launcher 分支覆蓋 `opts.args` 導致 `--resume` 失效的 bug
- [x] Issue #10 解決（PR #11）：修復終端運行中 Session 無法被辨識為 Active 的根因（檔案系統目錄遞迴精準還原 Claude 複合專案路徑、PTY 啟動保留 cwd 與啟動參數解析、PTY 刪除集合過早過濾修正、同工作區最新會話關聯優化）

## Long-term Tasks
- P1: Vibe 模式第二階段——Claude 改用 `--output-format stream-json` 的結構化聊天（僅 Vibe），
      順帶以結構化事件取代 `approvalDetect.ts` 的字串偵測（大按鈕審批卡）；排隊送出（queued turns）；
      點 Session 整組切換（對話＋成品＋Handoff）；Git「存檔點／回到上一步」
- P2: Codex 新版若改存 sqlite（`~/.codex/*.sqlite`）而非 rollout jsonl，需補 usage 讀取來源
- P1: 真的需要硬體分析時再包 MCP。判準：**只包 LLM 做不到或容易做錯的事**
      （二進位格式解析、確定性的位元運算）；能用 shell 或讀檔解決的不要包。
- P0: 用三家 CLI 的真實輸出校準 `approvalDetect.ts` 的審批提示字串
- P1: Antigravity 的 `mcp_config.json` 外層結構是推定的（該檔初始為 0 bytes），
  第一次 Sync 時要看 diff 並確認 Antigravity 讀得到
- P2: 應用程式圖示（目前用 Electron 預設圖示）

## Blocked / Needs Human Input
- `claude` CLI 需重新登入，否則無法做任何端到端驗證
- ~~Codex 未安裝~~：2026-09-24 已確認本機有 Codex CLI v0.156.1 且 token 用量可讀；Customized 面板的 Codex 佔位待重新檢查
