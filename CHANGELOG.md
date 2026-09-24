# Changelog

All notable changes to the Agent Workbench project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.19] - 2026-09-24

### Fixed / 修復
- **可攜版更新後重開退回舊版**：`isInstalledApp()` 原本以 `isProtectedPath(exeDir)` 輔助判斷，但該函式對 exe 目錄本身恆為 true，導致可攜版被誤判為安裝版，自動更新會靜默安裝一份到 `%LOCALAPPDATA%\Programs\Agent Workbench`；使用者再從原可攜版捷徑開啟即回到舊版。現改為僅以 NSIS 解除安裝程式判定，可攜版改導向 GitHub Releases 下載頁。

---

## [0.1.18] - 2026-09-18

### Highlights & Summary / 更新亮點
Agent Workbench v0.1.18 重點重構並優化設定視窗中的「關於與更新（About & Updates）」UI 排版佈局：
1. **全面導入 Apple HIG Inset Grouped 設計體系，修復 0px 擠壓貼合問題**：
   - 解決「Check for Updates」按鈕與下方更新資訊卡片之間 0 間距、擠壓黏合的視覺問題。
   - 替換舊版自創無樣式 class，全面對齊 macOS 系統設定標準規範：外層 `.macos-section`、工具列 `.macos-section-header-bar` 與內容容器 `.macos-inset-group`。
   - 為按鈕與資訊卡片提供標準、舒適的 8px 垂直呼吸空間。
2. **About & Updates 專屬 Apple HIG 樣式建構**：
   - 建立 `.macos-about-hero` 品牌卡片，整合 App Logo、版本資訊與發行通道藥丸徽章（Installed / Dev / Portable）。
   - 建立 `.macos-update-card` 更新卡片，配置優雅的內距（`padding: 16px 18px; gap: 12px;`），使更新說明日誌滾動框與下載進度條/重啟按鈕排列清晰美觀。
   - 修復 `.macos-settings-body` 的 Flex 溢出行為（加入 `min-height: 0;`），避免彈窗內容在滾動時被底部 Footer 裁切。
3. **偏好設定與 GitHub Releases 頁面整合為標準 Inset 清單行**：
   - 將「啟動時自動檢查更新」開關與「前往 GitHub Releases 頁面」整合至同一組 Inset Group 之中，消除原本孤立懸浮在底部的外連按鈕。

---

## [0.1.17] - 2026-09-18

### Highlights & Summary / 更新亮點
Agent Workbench v0.1.17 深度優化設定視窗（Settings Modal）的擴充功能、儲存按鈕佈局與文檔工具驗證狀態記憶機制：
1. **Extensions & Skills 移除 Switch，改為點擊各 Agent 符號縮圖作為獨立開關**：
   - 取消右側單一的 Switch 按鈕，改為直接點擊各 Agent（Claude 太陽、Antigravity 行星、Codex 徽章）縮圖切換。
   - 每個 Agent 的開關完全獨立，切換 Claude 絕不影響 Antigravity 或 Codex；Claude 原生 `enabledPlugins` 與後端狀態完全隔離同步。
   - 擴展 Antigravity 技能掃描，支援外掛子目錄技能、全域原生技能與工作區專用技能獨立枚舉。
2. **開關符號縮圖固定寬度，整齊三欄垂直對齊**：
   - 嚴格鎖定每顆縮圖寬度為 `104px`、狀態徽章（`ON`/`OFF`）固定 `27px`，未安裝狀態補上等寬佔位符。
   - 徹底解決 `ON` 與 `OFF` 字寬差異及未安裝項目的寬度抖動問題，使所有項目整齊劃一垂直對齊成三直欄。
3. **Appearance 與 Extensions 底部儲存按鈕排版標準化**：
   - 修復彈窗內容主體 `height: 100%` 導致視窗內容溢出擠壓 Footer 的問題，改為 Flex 容器自適應滾動。
   - 鎖定 Footer 高度為 48px，規範 Save 與 Cancel 按鈕尺寸與行高，避免折行破壞佈局。
4. **Document Tools 測試通過狀態持久化記憶**：
   - 修復開啟視窗時因初始狀態未定義誤判為「Verification failed」的錯誤。
   - 在 `settings.json` 新增 `docToolTestResults` 記憶體，測試通過後永久記憶，下次開啟立即顯示 Verified。
5. **CLI & Agents 安裝狀態動態標籤**：
   - 當系統已自動探測到或已設定有效路徑時，按鈕自動切換為「Reinstall / 重新安裝」，消除安裝就緒時的混淆。

---

## [0.1.16] - 2026-09-18

### Highlights & Summary / 更新亮點
Agent Workbench v0.1.16 全面校準並升級各 AI Agent CLI 的官方原生 PowerShell 下載安裝指令與路徑自動探測機制：
1. **Claude Code 採用官方原生 PowerShell 一鍵安裝與自動更新規範**：
   - 全面替換原先易受全域環境與權限阻礙且已被官方 Deprecated 的 `npm` 安裝方式，對齊 Anthropic 官方推薦之原生指令：`irm https://claude.ai/install.ps1 | iex`。
   - 原生安裝檔自動下載獨立二進位檔並配置到 `%USERPROFILE%\.local\bin\claude.exe`。
   - 具備雙層安全容錯：若網路特殊阻擋，背景自動無縫 fallback 至 npm 備用安裝方案。
2. **OpenAI Codex CLI 採用非交談式官方 PowerShell 一鍵安裝**：
   - 對齊 OpenAI 官方規範：`powershell.exe -ExecutionPolicy Bypass -Command "$env:CODEX_NON_INTERACTIVE='1'; irm https://chatgpt.com/codex/install.ps1 | iex"`。
   - 注入 `$env:CODEX_NON_INTERACTIVE='1'`，徹底解決官方腳本在背景執行時因等待終端使用者互動確認（`Prompt-YesNo`）而卡死超時的問題。
   - 自動安裝至 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` 或 `.codex\packages\standalone\current\bin\codex.exe`。
3. **路徑探測與環境變數未重啟即時命中**：
   - 擴充 `findCli` 搜尋候選清單：納入 `.local\bin\claude.exe`、`claude.ps1`、`OpenAI\Codex\bin\codex.exe`、`codex.ps1` 等。
   - 即使使用者電腦在安裝完成後尚未重啟終端或重新登入，Agent Workbench 依然能即刻自動偵測並帶入正確二進位路徑，即時完成測試驗證。

### Changed / 變更
- **CLI 安裝指令及確認彈窗更新 (`src/main/ipc/ext.ts`)**:
  - `getAgentInstallInfo()` 與 `runInstallAgent()` 全面切換至 Anthropic 及 OpenAI 官方原生 PowerShell 安裝命令。
- **CLI 路徑搜尋器擴充 (`src/main/ext/paths.ts`)**:
  - 納入官方原生安裝目錄，提升 Windows 與 Unix 跨平台自動偵測精準度。
- **設定視窗描述更新 (`src/renderer/src/components/SettingsModal.tsx`)**:
  - 更新 Codex CLI 說明文字為官方執行器規範。

---

## [0.1.15] - 2026-09-18

### Highlights & Summary / 更新亮點
Agent Workbench v0.1.15 強化工作區啟動機制與安裝升級體驗，實現預設不主動載入目錄（僅依使用者手動載入記錄復原），並新增更新與安裝完成後自動啟動應用程式：
1. **預設不主動載入目錄，僅復原使用者主動開啟之專案**：
   - **移除強制 cwd / Documents 兜底**：全面改寫 `determineInitialWorkspace()`，移除原先無先前記錄時盲目載入目前執行目錄或 Documents 之行為。首次啟動或無使用者主動開啟之專案時，直接進入乾淨的空白首頁。
   - **排除已自 Dashboard 移除之專案**：在啟動與還原工作區時，主動比對 `deletedWorkspaces`，確保已手動移除的專案不會在下次啟動時被強制載入。
   - **優化空工作區首頁與面板體驗**：
     - 空工作區狀態下視窗標題保持精簡 `Agent Workbench`，側邊欄預設停留在 `Dashboard` 儀表板，提供專案與會話總覽入口。
     - 檔案樹（`FileTreePanel`）在尚未開啟工作區時呈現 Apple 質感的 Empty State（資料夾圖示、說明引導與「開啟資料夾」按鈕）。
     - 底層保護：`files:list` 在目錄為空時安全回傳空陣列 `[]`，終端 PTY 在無工作區時安全回退至使用者家目錄，防止行程崩潰或越界警告。
2. **安裝與更新完成後自動啟動 Agent Workbench**：
   - **NSIS 安裝設定升級 (`electron-builder.yml`)**：加入 `runAfterFinish: true`，確保無論是手動執行安裝程式或背景自動更新升級完成，皆會自動啟動應用程式。
   - **快速安裝腳本升級 (`install.ps1`)**：在安裝完成後自動探測 `Agent Workbench.exe` 路徑並立即調用 `Start-Process` 啟動應用程式，免去手動尋找開始功能表之繁瑣操作。
   - **應用程式內部無縫升級重啟 (`updater.ts`)**：配合 NSIS 自動完成新版本重啟。

### Added / 新增功能
- **檔案樹無工作區空狀態介面 (`FileTreePanel.tsx`)**:
  - 新增無開啟資料夾時的引導畫面與「開啟資料夾」按鈕。
- **安裝完成自動執行設定 (`electron-builder.yml` & `install.ps1`)**:
  - NSIS 安裝精靈預設勾選「執行 Agent Workbench」，安裝或升級完畢後自動啟動。
  - `install.ps1` 靜默/一般安裝成功後自動啟動應用程式。

### Changed & Fixed / 變更與修復
- **工作區初始化邏輯重構 (`index.ts`)**:
  - 移除預設強制以 cwd 或 Documents 作為工作區之行為，回歸由使用者主動決定。
  - 啟動時自動過濾已被標記移除的專案。
- **空工作區保護機制 (`files.ts` & `pty.ts`)**:
  - `files:list` 支援安全空目錄回傳。
  - 終端 PTY 初始化時防禦空路徑，回退至使用者家目錄。

---

## [0.1.14] - 2026-09-18

### Highlights & Summary / 更新亮點
Agent Workbench v0.1.14 帶來 Antigravity CLI 外部會話深度追蹤、重塑 Apple HIG 確認彈窗、修復「從 Dashboard 移除」後重載復原機制，並支援 Git Clone 遠端儲存庫直接載入：
1. **外部 Antigravity CLI 會話即時活躍偵測與狀態同步**：
   - 解決外部終端或 IDE 外執行的 Antigravity CLI 運作時未顯示 Active 的問題。新增即時探測 SQLite WAL（`conversations/*.db-wal`）、背景子任務日誌（`tasks/*.log`）、即時訊息目錄與 `transcript_full.jsonl`，不再因 `transcript.jsonl` 延遲更新而落入 idle。
   - 統一度量衡：Active 判定時間窗口調整為 5 分鐘，Idle 調整為 30 分鐘。
   - 雙向去重與資料合併：以 session ID 合併 CLI 即時活躍時間與 UI 豐富 Token 統計，自動放行非工作區根目錄之外部 CLI 會話。
2. **重塑「從 Dashboard 移除」確認彈窗（Apple HIG 規範）**：
   - **徹底更換誤導性垃圾桶圖示**：改採 Apple `folder.badge.minus` 規範的 `IconFolderMinus` 專案資料夾減號圖示，並防呆設定非破壞性彈窗預設不顯垃圾桶。
   - **Apple HIG Accessory View 結構重構**：彈窗擴充為 420px，消除右側按鈕兩行折行問題；新增專案預覽卡（Target Card）與安全免責呼籲盒（Safe Callout），以綠色護盾圖示明確說明「本機硬碟檔案完全不受影響，重新開啟隨時恢復」。
3. **修復隱藏專案後重新載入無法重新出現之問題**：
   - 移除 Vite 打包後失效之動態 `require('./dashboard')`，改以解耦事件回呼。
   - 強化 `unmarkDeletedOrArchivedWorkspace`：在重新開啟、切換或克隆專案時，同步將專案路徑與旗下所有會話從 `deletedWorkspaces` 及 `deletedIds` 抹除釋放，專案與會話卡片即時重現。
4. **Git Clone 遠端儲存庫與開啟專案**：
   - 支援直接透過彈窗貼入 Git URL，克隆至本機並自動在新視窗或當前工作區載入。
5. **工作區安全與目錄過濾**：
   - 修正切換工作區時目錄探測越界拋出 `files:list Access denied` 警告。

### Added / 新增功能
- **Antigravity CLI 全面即時探測 (`dashboard.ts`)**:
  - 新增 `getAntigravitySessionMaxMtime()`，跨 `.db-wal`、`messages`、`tasks` 多點獲取即時活躍時間。
- **全新 Apple HIG 風格確認彈窗 (`AppleAlertDialog.tsx` & `appleAlertDialog.css`)**:
  - 新增 `IconFolderMinus` 與 `IconShieldCheck`。
  - 新增專案目標預覽卡（`.apple-alert-target-card`）與安全護盾呼籲盒（`.apple-alert-safe-callout`）。
  - 對話框加寬至 420px，按鈕設定 `white-space: nowrap; min-height: 36px`。
- **Git Clone IPC 處理器 (`git.ts`)**:
  - 新增 `git:clone` IPC 呼叫，支援背景克隆儲存庫。

### Fixed / 修復問題
- **移除專案後重新開啟無法重現修復 (`dashboard.ts` & `settings.ts`)**:
  - 清理 `deletedIds` 避免關聯會話持續遭到過濾。
  - 修正 Vite 打包環境動態 require 失敗問題。
- **檔案樹工作區切換路徑過濾 (`FileTreePanel.tsx`)**:
  - 過濾不屬於當前 targetRoot 之舊展開目錄路徑，消除越界日誌報錯。
- **JumpList 排除已被封存或移除之工作區 (`jumplist.ts`)**:
  - 任務列 JumpList 即時過濾已封存與已刪除的專案。

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
