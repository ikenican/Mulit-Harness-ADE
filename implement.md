# Implement.md — 輕量 Agent-Native Workbench (Monaco + 多 CLI 殼) 實作規劃

> 目標：打造一個專注於軟硬體協同開發、BIOS 與硬體驗證的輕量級 **Agent-Native Workbench**。
> 捨棄龐大且難以維護的完整 VS Code 源碼 Fork，改採 **Electron + Monaco Editor** 核心。
>
> **核心定位（重要）**：本工作台**不是 agent runtime、也不是協調者**。
> Agent 迴圈由各家**官方 CLI**（Claude Code / Codex / Antigravity）原生負責；
> 跨 CLI 的分工與共享脈絡由 **ShareProjectMem**（`handoff.md` + git）負責。
> 工作台只做四件事：**代碼編輯 + Git 視覺化 + 起 N 個 CLI 終端殼 + 渲染共享記憶**。

---

## 0. 專案定位與設計哲學

| 項目 | 內容 |
|---|---|
| **架構基礎** | **Electron + React/Vite + Monaco Editor**（VS Code 同款編輯器核心，避免百萬行 OSS Fork 泥沼） |
| **中心原則** | **無 API Key，全 CLI 驅動**：不內建 API 調用，以子行程 (`node-pty`) 起各家官方 CLI，吃訂閱額度，免金鑰儲存 |
| **Agent 迴圈** | 交給官方 CLI 原生負責（Claude Code / Codex / Antigravity 各自有 loop、工具、審批）；工作台**不重寫** |
| **多 CLI 呈現** | **Terminal-embed**：每家 CLI 一個 `xterm.js` 終端分頁，原生跑，**不解析各家私有協定**，三家一視同仁 |
| **分工與共享記憶** | **ShareProjectMem**（外部 repo）：`.project-memory/handoff.md` 為唯一真相，git hook 同步；工作台**渲染**它，不重建它 |
| **安全邊界** | 放在**檔案系統層**：每家 CLI 限制在 workspace `cwd` 內跑；**git 即 undo / audit**；審批由 CLI 自身終端提示處理 |
| **必備編輯能力** | 1. 代碼編輯與 Diff (Monaco)<br>2. Git Tree / 狀態視覺化 (`simple-git`)<br>3. Markdown (Mermaid/GFM) 與 HTML 沙箱即時預覽 |
| **硬體工具介接** | Python 硬體腳本包成 **MCP server**，註冊給各家 CLI（由 CLI 呼叫，非工作台自建 Tool Substrate） |
| **目標場景** | 個人 / 硬體研發團隊、C/C++/Python 軟硬體協同開發、BIOS 偵錯、封包分析 |

---

## 1. 系統架構總圖

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Desktop Workbench UI (Electron + React)              │
│ ┌──────────────┬───────────────────────────────┬─────────────────────┐ │
│ │ 側邊欄 (Left) │        中央主要工作區 (Center)  │  Agent 面板 (Right) │ │
│ │  - File Tree │  - Monaco Code Editor         │  - CLI 終端分頁     │ │
│ │  - Git Status│  - Monaco Diff (git 事後審查) │    (xterm.js)       │ │
│ │  - Git Log   │  - Markdown 渲染 (Mermaid/GFM)│  - Claude / Codex /  │ │
│ │  - Memory 檢視│  - HTML 沙箱即時預覽 (iframe) │    Antigravity 各一頁│ │
│ └──────┬───────┴───────────────┬───────────────┴──────────┬──────────┘ │
└────────┼───────────────────────┼──────────────────────────┼────────────┘
         │ 檔案/Git 操作          │ 開啟 git 變更檔          │ 使用者鍵入 / 讀畫面
         │ (simple-git)          ▼                          │ (node-pty stdio)
┌────────┴────────────────────────────┐      ┌──────────────┴────────────────┐
│   協調層 = ShareProjectMem (repo)    │      │      CLI 終端殼 (node-pty)     │
│   工作台「渲染」，不「重建」          │◄────►│  spawn 官方 CLI 子行程          │
│  - .project-memory/handoff.md 真相   │ 檔案 │  - claude / codex / antigravity │
│  - STATE / DECISIONS / PROTOCOL      │ +git │  - 各自原生 agent loop 與審批   │
│  - git hook 同步、跨機交棒           │ 交棒 │  - cwd 鎖在 workspace 內        │
└──────────────────────────────────────┘      └──────────────┬────────────────┘
                                                             │ 各 CLI 自行呼叫
                                                             ▼
                              ┌───────────────────────────────────────────────┐
                              │  MCP Servers（註冊給各家 CLI，非工作台調度）  │
                              │  - Python 硬體工具：USB 封包 / BIOS Log /      │
                              │    暫存器 (PyUSB, pyserial, scapy)             │
                              └───────────────────────────────────────────────┘
```

> **關鍵**：CLI 之間**不透過工作台互相溝通**——它們各自讀寫 `handoff.md` + git 來交棒。
> 工作台不在中間解析誰呼叫了什麼工具；它只是「殼 + 檢視器」。

---

## 2. 核心模組詳細規格

### A. 編輯與預覽中樞 (Workbench Core)
1. **代碼編輯與 Diff 審查 (`@monaco-editor/react`)**：
   - 具備完整 VS Code 手感：快捷鍵、語法高亮、代碼折疊、MiniMap。
   - **Git 驅動的事後 Diff review**：CLI 在終端裡寫完檔 → 左側 Git Status 冒出變更 → 點開以 Monaco Diff 左右比對 → 不滿意用 `git checkout` / `git restore` 還原。
   - 定位是「事後可逆」而非「寫入前攔截」——三家 CLI 通用、零協定解析（terminal-embed 攔不到寫入前，也不需要，git 就是 undo）。
2. **Git Tree 與版本控制整合 (`simple-git`)**：
   - **Git Status Panel**：列出 Working Tree 的變更檔案（Modified, Untracked, Staged）。
   - 快速操作：Stage、Unstage、Commit、切換分支。
   - **Git Log 列表**：commit 歷史（含 ShareProjectMem 的 handoff commit）。
   - Commit Graph 視覺化：**非 v1 必要**，agent 工作流需要的是 diff review 不是 GitKraken，延後或不做。
3. **Markdown 渲染器**：
   - `react-markdown` + `remark-gfm` + `rehype-highlight` + `mermaid`。
   - 兼作 **ShareProjectMem 檢視器**：直接渲染 `handoff.md` / `STATE.md` / `DECISIONS.md`，讓使用者一眼看到三家 agent 目前的共享狀態與交棒進度。
4. **HTML 沙箱即時預覽**：
   - `<iframe sandbox>` + CSP 載入本機 HTML（**不用 Electron `<webview>`**，官方已不建議）。
   - 支援即時重整，適合預覽視覺化儀表板或硬體測試產出的 HTML 報表。

---

### B. 多 CLI 終端殼與協調 (Terminal-embed + ShareProjectMem)

#### 1. CLI 終端殼（右側面板核心）
- 以 `node-pty` spawn 官方 CLI 子行程，`xterm.js` 呈現，每家一個分頁：
  - `claude`（Claude Code）、`codex`（Codex CLI）、`antigravity`（Antigravity CLI）。
- **不解析各家私有輸出協定**：CLI 的思考、tool call、審批提示原封不動出現在終端，使用者直接在終端互動。
- 每個子行程的 `cwd` 鎖在目前 workspace，環境變數注入 workspace 路徑。
- **可切換 / 可多開**：同一家 CLI 可開多個 session 分頁（對應 ShareProjectMem 的多 agent 分工）。

#### 2. 宣告式 CLI 啟動設定（YAML，輕量）
YAML 只用來**定義「怎麼起這個終端」**，不定義 agent loop（loop 是 CLI 的事）：
```yaml
# agents/usb_analyzer.yaml
launcher:
  id: "usb_analyst"
  name: "USB Protocol & Packet Analyst"
  cli: "claude"                 # 支援: claude, codex, antigravity
  cwd_scope: "workspace"        # 子行程 cwd 鎖定範圍
  args: []   # 需要時才在此註冊 MCP（如 --mcp-config .mcp/xxx.json）
  env:
    PROJECT_MEMORY: ".project-memory/handoff.md"
```

#### 3. 安全邊界（放檔案系統層，不重建 per-tool 審批）
CLI 自身已有 permission 系統，工作台**不再疊一層**（會打架、且 terminal-embed 看不到 tool call）。實際守門縮成三件：
1. **Cwd 隔離**：子行程 cwd 鎖 workspace，避免跨目錄意外篡改。
2. **Execution Timeout**：可對「長時間無輸出」的終端提示 / 提供中止鈕，防掛死。
3. **Git 即 Audit / Undo**：每次變更走 git，出事直接 revert；ShareProjectMem 的 pre-commit hook 另擋不完整交棒與 secrets。
> 審批 UX：使用者在對應終端裡直接回應 CLI 原生的 approve/reject 提示。工作台只需在該終端有待審批時，於分頁上打一個紅點提醒。

#### 4. 硬體工具 = MCP Server（給 CLI 用，非工作台調度）
- Python 硬體腳本（PyUSB / pyserial / scapy 等）包成標準 **MCP server**（stdio）。
- 透過各家 CLI 的 MCP 設定註冊（如 `--mcp-config`），由 **CLI 自己呼叫**，結果自然回到該 CLI 的對話與 `handoff.md`。
- 工作台只提供共用的 MCP 設定檔供各 launcher 引用；**不自建 Tool Substrate 去代呼叫**。
- （若日後想要「不經 agent 直接跑某支硬體腳本」的按鈕，再另加即可，v1 YAGNI。）

#### 5. 本機 Session Log（非共享大腦）
- SQLite (`better-sqlite3`) 只存**單一終端分頁的本機互動紀錄**（重開能回看），方便查歷史。
- **不當跨 CLI 共享脈絡**——共享脈絡是 ShareProjectMem 的 `handoff.md`，工作台渲染它即可。

---

## 3. 分階段實作路線圖

### Phase 0 — 專案骨架與基本 Workbench (1-2 週)
- [x] 建立 Electron + React + Vite + TypeScript 專案架構。
- [x] 實作三欄式佈局（側邊欄、中央編輯區、右側面板）。
- [x] 整合 `@monaco-editor/react`，實現本機檔案開啟、編輯、保存與分頁切換。
- [x] 實作 Markdown 渲染器與 HTML 沙箱（`<iframe sandbox>`）預覽分頁。

### Phase 1 — Git 中樞與 Memory 檢視 (1 週)
- [x] 整合 `simple-git`，左側 Git Status 變更清單（Modified, Untracked, Staged）。
- [x] 點擊變更檔以 `MonacoDiffEditor` 左右比對；提供 git restore/checkout 還原。
- [x] 基本操作：Stage、Unstage、Commit、切分支；Git Log 列表。
- [x] **ShareProjectMem 檢視器**：渲染 `handoff.md` / `STATE.md` / `DECISIONS.md`，顯示共享狀態。

### Phase 2 — 多 CLI 終端殼 (1 週)
- [x] 以 `node-pty` + `xterm.js` 實作終端分頁，能 spawn 並互動官方 CLI。
- [x] 設計 YAML launcher 解析器（只管「怎麼起終端」）。
- [x] 同時起 Claude Code / Codex / Antigravity 各一分頁，cwd 鎖 workspace。
- [x] 分頁待審批紅點提醒 + 中止鈕（timeout / 手動）。

### Phase 3 — 硬體 MCP 與跨機記憶 (1-2 週)
- [ ] 將現有 Python USB 封包 / BIOS Log 腳本包成 MCP server（stdio）。
      （曾試作一組通用工具，經檢討多為冗餘後整包移除；待有真實腳本再做）
- [ ] 建立共用 MCP 設定並於 launcher 註冊給 CLI。
- [x] 安裝 / 對接 ShareProjectMem 的 git hook 同步（`MEM_AUTOSYNC` 等），驗證跨 CLI 交棒。

### Phase 4 — 面板深度整合與體驗 (2 週)
- [x] 編輯器 ↔ 終端 ↔ Git ↔ Memory 全景聯動（點 handoff 提到的檔案直接開，git 變更即時反映）。
- [x] 多 CLI session 管理：多開、命名、切換、關閉。
- [x] 系統原生通知（OS Notification）：長任務完成或某終端待審批時提醒。
- [x] （選）針對支援結構化輸出的單一 CLI（如 Claude Code `stream-json`）加「tool timeline / 一鍵 diff」升級——**單家升級，不強求三家統一**。

---

### 已交付、但不在原規劃內的項目
在實作過程中依實際需求追加，皆已實測：

- [x] **Customized 面板**：跨 agent（Claude / Antigravity）的 Skill / MCP / Plugin 一覽與
      同步，寫入前以 Monaco Diff 預覽；Codex 掛 Pending 佔位。
- [x] **Connections**：憑證以 OS 金鑰加密存放，不寫進任何 agent 設定檔，
      僅在 spawn CLI 時注入環境變數。
- [x] **終端雙向橋接**：終端選取內容可送到另一個 session；Markdown 的 shell code block
      可送到終端。一律 bracketed paste 貼上、不自動執行。
- [x] **一般 shell**：PowerShell / CMD（非 Windows 為 bash / pwsh）。
- [x] **版面可自由調整**：三欄與終端高度皆可拖曳，終端可停靠右側或底部，
      終端支援單一／左右／上下／四宮格分割。
- [x] **編輯器多檔分頁**：切換分頁不會弄丟未存檔的編輯。
- [x] **Apple 設計語言 + 亮暗雙主題**；介面全英文。
- [x] **打包發佈**：electron-builder（NSIS），產物已實測可啟動。

> 目前進度與待辦以 `.project-memory/STATE.md` 為準（本檔是規劃，不是狀態）。

---

## 4. 技術堆疊總結表

| 模組 | 推薦技術 | 選擇原因 |
|---|---|---|
| **桌面應用外殼** | Electron / Vite | 成熟的 Node.js 系統底層存取能力與豐富桌面 API |
| **UI 框架與樣式** | React + Tailwind CSS / Vanilla CSS | 快速構建現代化、深色主題的專業 IDE UI |
| **代碼編輯器** | `@monaco-editor/react` | VS Code 同款核心，自帶語法高亮、折疊、Diff |
| **版本控制** | `simple-git` | 輕量且功能完整的 Node.js Git 封裝，兼作 undo/audit |
| **文件預覽 / Memory 檢視** | `react-markdown` + `mermaid` + `<iframe sandbox>` | 技術文件、硬體報告、handoff.md 檢視一套搞定 |
| **CLI 終端殼** | `node-pty` + `xterm.js` | 起官方 CLI 子行程並原生互動，不解析私有協定，三家通吃 |
| **分工 / 共享記憶** | **ShareProjectMem** (外部 repo) | `handoff.md` + git 為唯一真相，跨 CLI / 跨機交棒，工作台只渲染 |
| **硬體工具** | Python 3 + **MCP (stdio)** | 包成 MCP server 註冊給 CLI，保留 PyUSB/pyserial/scapy 生態 |
| **本機 Session Log** | SQLite (`better-sqlite3`) | 單分頁互動紀錄；非跨 CLI 共享大腦 |

---

## 5. 下一步行動清單

1. **初始化專案基礎骨架**：建立 `electron-vite-react` 骨架與目錄結構。
2. **驗證 Monaco + Git + Markdown/HTML 三件套**：核心開發者檢視工作台。
3. **接 ShareProjectMem**：`bash install.sh` 掛進 workspace，工作台能渲染 `handoff.md`。
4. **起第一個 CLI 終端殼**：`node-pty` 跑 `claude`，能互動、cwd 鎖 workspace。
5. **掛第一支 Python 硬體 MCP**：驗證 CLI 自行呼叫硬體腳本，結果寫回 handoff 並在工作台可見。
