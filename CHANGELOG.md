# Changelog

All notable changes to the Agent Workbench project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.6] - 2026-09-15

### Highlights & Summary / 更新亮點
Agent Workbench v0.1.6 帶來 Dashboard 會話卡片原生拖曳排序與跨資料夾歸類（Issue #7，方案 A），以及精準的活躍會話偵測與專案路徑反解（Issue #8）：
1. **Dashboard 會話卡片原生拖曳重排與跨資料夾移動 (Issue #7)**：卡片支援在群組內依游標中線上下插入重排，亦可直接拖曳至各資料夾容器進行跨專案歸類。排序與分類變更支援 `localStorage` 本地持久化，放回原生目錄時自動清理覆寫。右側終端面版拖曳 Handoff 與點選繼續執行完整保留。
2. **活躍 Agent 會話偵測與專案目錄路徑反解 (Issue #8)**：
   - 擴充 Antigravity 系統提示緩衝區至 512KB + 尾部 64KB，比對當前工作區路徑，徹底解決路徑被巨大 prompt 裁切而歸類至 "Antigravity Workspace" 的問題。
   - 修復 Claude 專案路徑盲目將連字號替換為空格的 Bug，保留如 `IDE-remade-3` 等真實目錄結構，並結合子檔案 mtime 穿透 Windows 目錄快取限制。
   - 補齊 Claude 與 Codex 掃描器的 `< 2m` 活躍狀態計算。
   - 新增 SQLite 二進位反解，自動提取 Antigravity CLI 會話之真實專案路徑與工作區名稱。
3. **終端已開啟會話防重複啟動**：點擊已在右側終端運行的會話卡片時直接切換並聚焦既有終端 Tab，不再反覆生成重複進程。

### Added / 新增功能
- **Dashboard 原生拖曳排序與放置 (`DashboardPanel.tsx` & `dashboard.css`)**:
  - HTML5 原生拖曳資料傳輸 (`application/x-dashboard-session-id`)。
  - 卡片上下邊界發光指示條（`.drag-over-top` / `.drag-over-bottom`）。
  - 資料夾群組容器放置高亮（`.dash-folder-group.drag-over-folder`）。
  - `localStorage` 持久化儲存（`dashboard-order` 與 `dashboard-folder-overrides`）。
- **Antigravity CLI 資料庫專案反解 (`dashboard.ts`)**:
  - `extractWorkspaceFromBlob()` 精準解析 `~/.gemini/antigravity-cli/conversations/` 下 SQLite blob 之工作區目錄與路徑。

### Fixed / 修復問題
- **會話目錄歸屬與狀態識別修復 (`dashboard.ts`)**:
  - 修正 Antigravity 巨大系統提示截斷導致路徑遺失問題。
  - 修正 Claude 專案目錄連字號破壞與 Windows 目錄 mtime 滯後問題。
  - 補齊 Claude / Codex 活躍（active）狀態判斷邏輯。
  - PTY 優先度 3 同工作區匹配加入 30 分鐘時間窗口，避免好幾天前歷史會話誤標活躍。
- **終端會話聚焦重複開啟修復 (`TerminalPanel.tsx`)**:
  - 比對 `associatedSessionId`，點選既有會話卡片時直接 focus 既有終端 tab。

---

## [0.1.5] - 2026-09-14

### Highlights & Summary / 更新亮點
Agent Workbench v0.1.5 針對安裝與發布體驗進行關鍵優化：
1. **即時下載進度條與狀態反饋 (`install.ps1`)**：替換原先靜默無感的下載機制，優先採用 `curl.exe` 動態即時進度條與百分比顯示；並於靜默安裝 (`-Silent`) 期間提供動態 Spinner 與秒數計時，徹底消除安裝卡頓與凍結假象。
2. **安裝指令簡便模式**：支援 `$env:INSTALL_SILENT=1` 與 `$env:INSTALL_DOWNLOAD_ONLY=1`，提供更簡潔的單行 PowerShell 安裝方式。
3. **發布權限與安全標註 (`README.md` & `release.ps1`)**：明確標註 `npm run release` 為專案維護者專用（Maintainers only），強化開源協作之安全界線說明。

### Added / 新增功能
- **PowerShell 安裝腳本即時進度條 (`install.ps1`)**:
  - `Download-FileWithProgress` 優先調用 Windows 內建 `curl.exe -fL --progress-bar`，提供動態即時進度條與百分比。
  - 自動容錯降級為 `.NET HttpWebRequest` 串流下載與 `Write-Progress` 頂部進度條。
  - 在 `-Silent` 靜默安裝模式下加入即時動態 Spinner 與已耗時秒數顯示。
  - 支援 `$env:INSTALL_SILENT=1` 與 `$env:INSTALL_DOWNLOAD_ONLY=1` 單行環境變數快捷開關。

### Changed / 變更與調整
- **README 與 Release 腳本標註維護者權限 (`README.md` & `scripts/release.ps1`)**:
  - 中英文文檔清楚標示 `npm run release` 僅限專案維護者（需要本機 `gh` 倉庫寫入權限），並說明外部貢獻者無法擅自發布或更改專案資產。

---

## [0.1.4] - 2026-09-14

### Highlights & Summary / 更新亮點
Agent Workbench v0.1.4 帶來完整的自動化發布工作流、線上自動更新支援、真實 Codex/Antigravity 會話恢復與極窄防跑版佈局：
1. **真實 Codex & Antigravity 會話恢復 (Real Session Resume - PR #4)**：修正點擊儀表板會話卡片時未能真實帶入 session resume 參數的問題，串接 Antigravity CLI 原生會話儲存庫與 Token 啟發式估算，並為 PTY 增加 WebContents 銷毀保護避免崩潰。
2. **零停機線上自動更新與容錯 (Auto-Updater & Error Sanitization)**：支援桌面安裝版在線檢查更新與背景下載，消除 404 報錯；免安裝綠色版亦可一鍵獲取最新發布。
3. **極窄邊欄響應式防重疊佈局 (Responsive Dashboard Sidebar)**：採用 CSS Container Query，側邊欄極度縮小或拖曳時按鈕自動動態轉為圖示，消除文字折行與多層卡片擠壓。
4. **內建 Web 測試瀏覽器離線智慧引導 (Browser Dev Server Offline Guidance)**：本地 Web 開發伺服器未啟動時提供清楚引導卡片與常用 Port 快捷切換。
5. **一鍵式自動發布與安裝 (Automated Release Publisher & Quick Installer)**：引入 `npm run release` 一鍵自動編譯、壓縮免安裝綠色包並直推 GitHub Releases；提供 PowerShell 單行快速安裝腳本。

### Added / 新增功能
- **一鍵式 Release 發布腳本 (`scripts/release.ps1` & `npm run release`)**:
  - 自動讀取 `package.json` 版本號，執行 TypeScript 檢查與 electron-builder 打包。
  - 自動壓縮綠色免安裝目錄 `release/win-unpacked` 為 `Agent-Workbench-<version>-portable.zip`。
  - 自動調用 GitHub CLI (`gh`) 上傳安裝檔、免安裝包、`latest.yml` 與區塊校驗檔。
- **PowerShell 一鍵安裝腳本 (`install.ps1`)**:
  - 支援 TLS 1.2/1.3，自動抓取最新 Release 安裝檔並於使用者端一鍵下載安裝。
- **內建 Web 測試瀏覽器未啟動引導 (`TestBrowserPanel.tsx`)**:
  - 監聽 `did-fail-load`，伺服器離線時展示友善引導與常用 Port（:5173, :3000, :8080, :8000）按鈕。
- **Auto-Updater 404 報錯過濾與備援檢查 (`updater.ts`)**:
  - 消除無效的 404 錯誤堆疊傾印，在線版本即時確認無誤後提供打勾確認狀態。

### Fixed / 修復問題
- **真實 Codex & Antigravity 會話恢復 (PR #4 by Jerrywu-TT)**:
  - 補齊 `TerminalPanel.tsx` 中 Codex resume 指令參數（`args = ['resume', req.id]`）。
  - 對接 `scanAntigravityCliConversations` 至 CLI 原生資料庫目錄，避免 `--conversation` 參數被剔除。
  - 加入 `estimateTokensFromBlob` 提供 Antigravity 會話 Token 統計。
  - PTY 進程加入 `isDestroyed()` 守護，防止視窗關閉時觸發 WebContents 崩潰。
- **儀表板側邊欄縮小重疊跑版 (`DashboardPanel.tsx` & `dashboard.css`)**:
  - 資料夾標題重構為雙層結構，徹底解決切換按鈕文字折疊與標籤重疊。
  - 導入 CSS 容器查詢（`@container dash-panel`），窄版自動將按鈕收縮為圖示。

---

## [0.1.3] - 2026-09-14

### Highlights & Summary / 更新亮點
Agent Workbench v0.1.3 為需要高度自動化工作流的開發者引入 AI Agent 啟動權限略過模式（Bypass Mode）：
1. **一鍵全自動無人值守 (Bypass Permissions Mode)**：在設定面板提供全域開關，啟動 Claude Code、OpenAI Codex 或 Google Antigravity 時自動注入官方免審批與跳過權限參數。
2. **終端與卡片即時狀態可視化**：終端面板與 Launchpad 卡片即時呈現醒目的橘色 Bypass 懸浮徽章，並針對排版進行強化修復，確保無截斷、不跑版。
3. **安全預設與防重複注入**：預設維持關閉以保障安全性，且 PTY spawn / launchers 實作嚴謹的參數重複檢測，相容多種作業系統環境與啟動封裝。

### Added / 新增功能
- **CLI 啟動權限與略過模式 (CLI Launch Permissions & Bypass Mode)**:
  - 在「設定 ➔ CLI 與 AI 代理」新增專屬控制區塊，配備 Apple HIG 盾牌圖示、開關切換器與警示橫幅。
  - 支援全域設定持久化（`.workbench/settings.json`，欄位 `cliBypassPermissions`，預設為 `false` 確保安全）。
  - 啟用時自動向各 AI Agent 注入官方略過審批參數（具備防重複注入機制）：
    - **Claude Code**: `claude --permission-mode bypassPermissions`
    - **OpenAI Codex**: `codex --dangerously-bypass-approvals-and-sandbox`
    - **Google Antigravity**: `agy --dangerously-skip-permissions`
  - 終端啟動板（Launchpad cards）與「`+`」選單即時呈現橘色 `Bypass` 標籤，採用卡片右上角懸浮標籤佈局，徹底解決文字截斷跑位問題。

---

## [0.1.2] - 2026-09-14

### Highlights & Summary / 更新亮點
Agent Workbench v0.1.2 專注於極速開機體驗與精準的儀表板互動連動：
1. **42 倍極速冷啟動效能優化 (42x Fast Startup Optimization)**：實作檔案 mtime 磁碟持久化快取與單面板按需掛載（Mount-on-Demand），全盤掃描時間由 281ms 驟降至 6.6ms。
2. **Dashboard 與 Settings CLI 動態連動 (CLI Enable/Disable Linkage)**：設定中啟用或停用特定 Agent CLI（Claude, Antigravity, Codex）時，Dashboard 遙測卡片、會話清單與資料夾群組即時同步過濾；若全域停用則提供友善導引與一鍵直達設定按鈕。
3. **主行程資源保護與雙重掛載消除 (Resource Guard & Mount Cleanup)**：後端自動跳過已停用 Agent 的磁碟 I/O，消除多重請求衝突；移除開發環境雙重掛載，系統冷開機不再額外啟動不必要的 Git 背景進程與渲染負擔。

### Added / 新增功能
- **Dashboard CLI 啟用/停用動態連動 (Dashboard CLI Linkage)**:
  - 儀表板遙測卡片網格（`dash-agents-grid`）僅動態渲染目前已啟用的 Agent。
  - 頂部統計指標（總 Tokens、活躍進程、總會話數）動態計算已啟用 Agent 之數據。
  - 會話資料夾群組（`folderGroups`）與會話卡片全面過濾已停用 Agent 之歷史紀錄。
  - 新增全停用空狀態導引橫幅（`.dash-no-agents-banner`），附帶直達「設定 ➔ CLI 設定」快捷按鈕。
  - 後端 `src/main/ipc/dashboard.ts` 智能跳過已停用 Agent 之日誌掃描與 PTY 進程關聯，省下磁碟 I/O 與 CPU 負擔。
- **檔案 mtime 磁碟持久化快取 (mtime Disk Cache)**:
  - 引入 `.workbench/dashboard-cache.json` 本機快取機制，利用檔案最後修改時間比對未變更會話（單檔快取命中耗時 < 0.05ms）。
  - 引入 `activeScanPromise` 互斥鎖，避免定時輪詢與多重請求重複觸發檔案讀取。
  - 工作區切換時自動宣告記憶體快取失效並安全重整。

### Fixed & Improved / 修復與改進
- **面板按需掛載與狀態保持 (Mount-on-Demand with Keep-Alive)**:
  - 側邊欄（Files, Git）與中央區（Preview, Memory）改採 `visitedTabs` 按需掛載，冷啟動時不再生成多個 Git 子行程，亦不預載重量級 Mermaid 庫；訪問過後持續保留於 DOM，確保切換分頁狀態不丟失。
- **消除開發模式雙重掛載 (React StrictMode Cleanup)**:
  - 移除 `<React.StrictMode>`，消除開發時兩次重複觸發全盤掃描與 effect 負擔。
- **快取檔案納入版控忽略 (.gitignore)**:
  - 將 `.workbench/dashboard-cache.json` 加入 `.gitignore`，確保各機器本機暫存檔不污染版控。

---

## [0.1.1] - 2026-09-14

### Highlights & Summary / 更新亮點
Agent Workbench v0.1.1 帶來了重大功能升級與穩定性強化，主要包含：完整整合 Codex 擴充套件與真實會話 Token 遙測掃描（外部 PR #2 整合）、全新 Session 資料夾分組與工作區一鍵快速切換、全介面中英文雙語系支援（Strict English & Traditional Chinese）、會話活躍狀態與時間戳精準判定，以及終端啟動板滾動顯示修復。

### Added / 新增功能
- **Codex 擴充掃描與真實會話遙測 (Integration with PR #2)**:
  - 支援自動掃描 `~/.codex/config.toml`，提取 Codex MCP 伺服器與外掛設定。
  - 支援自動掃描 `~/.codex/skills/` 讀取自訂 Skill 定義與 metadata。
  - 遞迴解析 `~/.codex/sessions/**/rollout-*.jsonl` 與 `~/.codex/session_index.jsonl`，計算真實累計 Token 數、會話標題與工作目錄。
  - 智慧 PTY 行程匹配（三段優先級：cwd 匹配、啟動時間鄰近度判斷），精準標記 Codex 活躍終端會話。
  - 標準化 Token 三重分類法：`Context & System Prompt`、`Cached Input Context`、`Thinking & Generation`。
- **Session 資料夾分組與互動式工作區切換 (Session Folder Grouping & Workspace Switching)**:
  - Dashboard 會話列表支援以工作目錄（Folder）手風琴樣式分類展示，支援一鍵全部展開／摺疊。
  - Session 卡片新增資料夾標籤按鈕，點擊立即切換後端工作區根目錄 (`files:setWorkspaceRoot`)，自動切換至 Files 檔案側邊欄並即時重新整理檔案樹。
  - 當側邊欄處於收合狀態時，點擊切換工作區將自動展開側邊欄。
  - 檔案樹系統引進 `fs.watch` 即時監聽與視窗事件廣播，本機檔案異動零延遲同步。
- **全域中英文雙語系國際化 (Bilingual i18n Support)**:
  - 支援嚴謹的英文（Strict English）與繁體中文（Traditional Chinese）全介面切換。
  - 覆蓋全部核心面板：Dashboard、Editor、Git、Terminal、Preview、Settings、Customized 及快顯提示。
  - 設定選單支援即時切換語系並持久化儲存。

### Fixed & Improved / 修復與改進
- **遙測準確性與幽靈會話消除 (Telemetry Precision & Ghost Session Cleanup)**:
  - 修正 Active 與 Completed 狀態判定錯誤，精確綁定實體 PTY 行程存續狀態。
  - 修復 Antigravity 會話時間戳為空白導致的排序與過濾異常（改以檔案最後修改時間 `mtime` 作為可靠判定基準）。
  - 過濾無效、零 Token 與空白之幽靈會話（Ghost Sessions）。
- **終端啟動板滾動修復 (Terminal Launchpad Scroll Fix)**:
  - 修復終端開啟過多會話時，頂部選項卡被截斷且無法向上滾動的 Flexbox CSS 缺陷 (`min-height: 0` 容器捲動修正)。
- **Apple HIG 微互動 (Apple HIG Micro-interactions)**:
  - 為工作區跳轉按鈕與分類標頭導入 Apple HIG 風格的按壓縮放 (0.96 scale) 與懸浮微動畫。

---

## [0.1.0] - 2026-09-10

### Initial Release / 初始版本
- **Monaco Editor Core**: VS Code 同款 Monaco 編輯器核心，支援程式碼編輯、多分頁開啟與即時未存檔保護。
- **Multi-CLI Terminals**: 透過 `@lydell/node-pty` 與 `xterm.js` 實現的原生終端殼層，支援 Claude Code、Antigravity CLI 及各類 Shell 同時執行。
- **Git Hub & Visualizer**: 整合 Git 狀態檢視、暫存 (Stage)、提交 (Commit)、分支切換、GitGraphView 提交歷史拓撲圖與 Monaco DiffEditor 歷史比對。
- **Shared Project Memory**: 整合 `.project-memory/` 標準規範，跨 AI 代理人記憶讀取與交接機制。
- **Document & Markdown Preview**: 內建 Markdown/HTML 即時預覽，以及 Office (Word, Excel, PowerPoint) / PDF 文件檢視器。
- **Native Packaging**: 支援 Electron-Builder 跨平台打包 (Windows NSIS 安裝包)。
