# Changelog

All notable changes to the Agent Workbench project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
