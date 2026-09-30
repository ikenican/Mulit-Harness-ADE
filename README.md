# Mulit-Harness-ADE — Agent Workbench

A lightweight, **agent-native** developer workbench: a Monaco code editor, a Git
visualizer, and N embedded CLI terminals — nothing more. Built with Electron +
React + Vite.

*English is the primary language of this README; a 繁體中文 version follows below.*

> **Design principle — not an agent runtime.** This workbench does not implement
> an agent loop, hold API keys, or parse any vendor's private protocol. The agent
> loop is run by each vendor's **official CLI** in a real terminal; cross-CLI
> hand-off is done through a shared `.project-memory/` (handoff notes + Git). The
> workbench only does four things: **edit code, visualize Git, spawn CLI terminal
> shells, and render shared memory.**

## Features

- **Monaco editor** — the same editor core as VS Code (via the MIT-licensed
  `monaco-editor`), with edit and diff views, including commit-level diffs from
  the Git panel.
- **Git panel** — status, staging, commit, branch switch, a commit graph, and
  recent-commit / file diffs.
- **Multi-CLI terminals** — each CLI gets its own `xterm.js` terminal tab, run
  natively as a child process via `node-pty`. No keys stored; the CLIs use their
  own subscriptions/auth.
- **Preview & Documents** — live Markdown / HTML preview that auto-syncs on edit and save, plus built-in document viewing for Word, Excel, PowerPoint, and PDF.
- **Vibe Coding Mode** — an alternative, task-first layout (Settings → Appearance → Work Mode): an icon rail (Sessions / Status / Handoff / Files / Git / Settings) whose panels fade in on hover and pin on click, the agent terminal in the middle, and the live result on the right. Dev-server URLs printed in the terminal (`http://localhost:PORT`) open automatically, and the Handoff panel summarises `.project-memory/handoff.md`. Developer Mode keeps the classic code-first layout.
- **Dashboard & Telemetry** — session list plus token usage scanned from local CLI records (Claude Code, Codex, Antigravity), switchable between **All / 30d / 7d / Today** and split into input / cache read / output. Claude and Codex figures come from the CLIs' own usage records; Antigravity logs carry no token counts, so its figures are character-based estimates and are labelled as such. Includes CLI enable/disable filtering, folder grouping, and one-click workspace switching.
- **Fast Startup & Mount-on-Demand** — 42x accelerated cold startup powered by disk-persisted session caches and lazy-loaded sidebar/central panels.
- **Bilingual i18n** — full interface localization supporting seamless toggling between Strict English and Traditional Chinese.
- **CLI Permissions & Bypass Mode** — toggleable bypass mode skipping interactive approval prompts for Claude Code (`--permission-mode bypassPermissions`), Codex (`--dangerously-bypass-approvals-and-sandbox`), and Antigravity (`--dangerously-skip-permissions`).
- **iPhone Remote Control (LAN)** — watch and answer your CLI agents from an iPhone on the same Wi-Fi: a Home Screen web app lists every terminal, mirrors its output, shows an approval card with one-tap answers, lets you type or start new agents, and sends a notification when an agent needs you. See [iPhone remote control](#iphone-remote-control).

## Installation

### Method 1: One-Line Quick Install (Windows PowerShell)

Run this command in **PowerShell** (no Git or Node.js required):

```powershell
irm https://raw.githubusercontent.com/zkylek1212-k/Mulit-Harness-ADE/master/install.ps1 | iex
```

> **What this does:** Automatically fetches the latest release from GitHub, downloads the Windows setup installer (`.exe`), and starts the installation.
>
> *Options:*
> - **Silent install** (no wizard prompt):
>   ```powershell
>   $env:INSTALL_SILENT=1; irm https://raw.githubusercontent.com/zkylek1212-k/Mulit-Harness-ADE/master/install.ps1 | iex
>   ```
> - **Download installer only** (saves to current folder without running):
>   ```powershell
>   $env:INSTALL_DOWNLOAD_ONLY=1; irm https://raw.githubusercontent.com/zkylek1212-k/Mulit-Harness-ADE/master/install.ps1 | iex
>   ```

### Method 2: Direct Download from GitHub Releases

Prefer manual download? Grab the setup package directly from GitHub:

- 🚀 **[Download Latest Release](https://github.com/zkylek1212-k/Mulit-Harness-ADE/releases/latest)**
- Download `Agent Workbench-<version>-setup.exe` and double-click to install.
- *(Portable version: download portable archive and run `Agent Workbench.exe` directly without installation.)*

---

## Development & Build from Source

For developers who want to contribute or build from source:

### Requirements

- Node.js 18+ (LTS recommended)
- On Windows the terminal uses a prebuilt native binary (`@lydell/node-pty`); no compiler toolchain is required.

### Getting started

```bash
git clone https://github.com/zkylek1212-k/Mulit-Harness-ADE.git
cd Mulit-Harness-ADE
npm install
npm run dev        # launch in development
```

## Build & Publish

```bash
npm run typecheck  # TypeScript check, no emit
npm run build      # compile main / preload / renderer
npm run dist       # build an installer with electron-builder
npm run release    # (Maintainers only) one-click build and publish to GitHub Releases
```

> **Note on `npm run release`**: This script is strictly for **project maintainers** with repository write permissions. It uses your local GitHub CLI (`gh`) authentication to upload assets. External contributors cannot publish releases or modify repository assets.

Installer output goes to `release/`. Build config is in `electron-builder.yml`.

## Project layout

```
src/main       Electron main process (IPC, git, pty, files, extensions)
src/preload    the single IPC contract surface
src/renderer   React UI (editor / git / terminal / preview / dashboard panels)
.project-memory  shared cross-agent memory (handoff, protocol, decisions)
```

## iPhone remote control

Settings → **Remote Control** turns on a small HTTPS server inside the app that only
accepts connections from private LAN addresses (10/8, 172.16/12, 192.168/16).
On Windows, allow **Private networks** when the firewall asks the first time.

1. **Trust this computer (once).** Scan the first QR code with the iPhone Camera and open
   it in Safari. Download the profile, install it (Settings → General → VPN & Device
   Management), then enable it under Settings → General → About → Certificate Trust
   Settings. iOS only allows Home Screen web apps, service workers and push
   notifications over a trusted HTTPS connection, which is why this step exists.
2. **Install the app.** Open the app URL in Safari → Share → **Add to Home Screen**.
3. **Pair.** Open it from the Home Screen, press *Generate pairing code* on the computer,
   and type the code (or scan the pairing QR code). Home Screen apps don't share storage
   with Safari, so pair from the Home Screen app.
4. Optional: in the app's settings, turn on notifications to get an alert when an agent
   is waiting for approval or a task finishes.

Security model:

- The local CA carries critical X.509 Name Constraints: it can only sign certificates for
  private IPv4 addresses and `*.local`, so even if its key leaked it could not impersonate
  public websites on your phone. Its private key is encrypted with the OS keychain
  (Electron `safeStorage`). *Reset certificate and devices* creates a new CA.
- Pairing codes are single-use, expire after 5 minutes, and are invalidated after 10 wrong
  attempts. Devices get a random token; only its SHA-256 is stored. Revoking a device
  disconnects it immediately.
- A paired phone has full terminal control, including starting new agents (which honour
  Bypass Mode) and turning Bypass Mode on or off. Turning it on from the phone asks for
  confirmation and shows a notification on the computer. The title bar shows a phone badge whenever a device is connected, and
  pair / connect / spawn / kill events are written to `remote/audit.log` in the app's
  user-data folder (keystrokes are never logged).
- Push notifications are end-to-end encrypted to the phone (RFC 8291) and relayed by
  Apple's push service, so the computer needs internet access for them; everything else
  stays on the LAN.

In development, the phone client is served from the build output: run `npm run build`
once before testing it with `npm run dev`.

## Configuration notes

- `src/preload/index.ts` is the **single IPC contract** between main and renderer.
- `src/renderer/src/store.ts` holds cross-panel state.
- Theme colors come from CSS variables in `src/renderer/src/styles.css` — do not
  hard-code colors inside panels.
- Per-machine runtime state (`.workbench/settings.json`,
  `.workbench/dashboard-state.json`) is git-ignored; `.workbench/extensions.yaml`
  is the checked-in template. CLI and document-tool paths are auto-detected at
  runtime and default to unspecified until configured in the app.
- Dashboard caches (`dashboard-cache.json`, `usage-cache.json`) live in the app's
  user-data folder, shared by all windows. Each window decides its own
  "Current Workspace"; the main process never uses the focused window to
  attribute sessions.
- `npm run dev` uses its own user-data folder (`agent-workbench-dev`), so a dev
  build can run alongside an installed copy without sharing settings or caches.

## Release Notes & Changelog

See [CHANGELOG.md](CHANGELOG.md) for full version history and release details.

## License

[MIT](LICENSE) © 2026 zkylek1212-k.

## Trademark & affiliation notice

This project is an independent tool and is **not affiliated with, endorsed by, or
sponsored by** Anthropic, OpenAI, Google, or Microsoft. "Claude Code", "Codex",
"Antigravity", "VS Code", and other product names are trademarks of their
respective owners and are used here only nominatively to describe interoperability.
Agent Workbench bundles none of those products; it launches whichever CLIs the
user has installed.

## Third-party software

All bundled runtime dependencies are permissively licensed, including (MIT)
`monaco-editor`, `@monaco-editor/react`, `@xterm/xterm`, `react`, `react-dom`,
`react-markdown`, `rehype-highlight`, `remark-gfm`, `mermaid`, `simple-git`,
`js-yaml`, `@lydell/node-pty`, `ws`, and `qrcode`, plus `node-forge` (BSD-3-Clause,
used to create the remote-control certificates). Their license terms continue to
apply to those components.

The terminal dev-server URL detection (`src/renderer/src/panels/terminal/portDetect.ts`)
is adapted from [AgentsDock](https://github.com/ZhengyiLuo/AgentsDock), licensed under
the Apache License 2.0.

---

# 繁體中文說明

一個輕量、**agent-native** 的開發工作台：Monaco 程式碼編輯器、Git 視覺化面板，以及
N 個內嵌 CLI 終端——僅此而已。以 Electron + React + Vite 打造。

> **設計原則——本工具不是 agent runtime。** 本工作台不實作 agent 迴圈、不保存 API
> 金鑰、也不解析任何廠商的私有協定。Agent 迴圈交由各廠商的**官方 CLI**在真實終端中執行；
> 跨 CLI 的交接透過共享的 `.project-memory/`（handoff 筆記 + Git）完成。工作台只做四件事：
> **編輯程式碼、視覺化 Git、啟動 CLI 終端殼、渲染共享記憶。**

## 功能

- **Monaco 編輯器**——與 VS Code 同款編輯器核心（採 MIT 授權的 `monaco-editor`），
  提供編輯與 diff 檢視，並支援從 Git 面板開啟 commit 層級的 diff。
- **Git 面板**——狀態、暫存、commit、切換分支、commit graph，以及最近 commit／檔案 diff。
- **多 CLI 終端**——每個 CLI 各有一個 `xterm.js` 終端分頁，透過 `node-pty` 以子行程原生執行。
  不儲存金鑰；CLI 使用其自身的訂閱／驗證。
- **預覽與文件**——Markdown／HTML 即時預覽（編輯與存檔自動同步），並內建 Word、Excel、PowerPoint 與 PDF 檢視器。
- **Vibe Coding 模式**——任務優先的另一種版面（設定 → 外觀 → 工作模式）：最左側圖示列（Sessions／Status／Handoff／Files／Git／Settings）游標移過去就淡入彈出、點擊可固定；中間是 Agent 終端，右側是即時成品。終端輸出的 dev server 網址（`http://localhost:PORT`）會自動開啟，Handoff 面板會整理 `.project-memory/handoff.md`。開發者模式維持原本程式碼優先的版面。
- **儀表板與遙測**——從本機 CLI 紀錄（Claude Code、Codex、Antigravity）掃描 session 清單與 token 用量，可切換**總用量／30 天／7 天／今天**，並拆分輸入／快取讀取／輸出。Claude 與 Codex 取自 CLI 自己的用量紀錄；Antigravity 紀錄沒有 token 欄位，數字為字數估算並明確標示。支援 CLI 啟用連動、資料夾群組分類與一鍵工作區切換。
- **極速啟動與按需掛載**——檔案 mtime 持久化快取與面板按需載入（Mount-on-Demand），開機掃描效能大幅提升 42 倍。
- **雙語系支援**——全系統支援嚴謹英文與繁體中文介面即時無縫切換。
- **CLI 啟動權限與略過模式**——全域開關支援切換 AI 代理（Claude Code、Codex、Antigravity）略過互動式審批確認模式，提升自動化執行流暢度。
- **iPhone 遠端控制（區網）**——在同一個 Wi-Fi 下用 iPhone 查看並回覆 CLI agent：加入主畫面的 App 會列出所有終端、同步顯示輸出、用審批卡片一鍵回覆、可以輸入或開新的 agent，agent 等你回覆時會推播通知。詳見下方〈iPhone 遠端控制〉。

## 安裝指南

### 方法一：PowerShell 一鍵快速安裝（Windows 推薦）

在 **PowerShell** 貼上並執行以下單行指令（無需 Git 或 Node.js）：

```powershell
irm https://raw.githubusercontent.com/zkylek1212-k/Mulit-Harness-ADE/master/install.ps1 | iex
```

> **說明：** 自動向 GitHub 取得最新版本安裝包（`.exe`），下載並自動啟動安裝精靈。
>
> *進階選項：*
> - **靜默自動安裝**（不彈出安裝引導畫面）：
>   ```powershell
>   $env:INSTALL_SILENT=1; irm https://raw.githubusercontent.com/zkylek1212-k/Mulit-Harness-ADE/master/install.ps1 | iex
>   ```
> - **僅下載安裝檔到本地**（儲存至當前目錄，不立即執行）：
>   ```powershell
>   $env:INSTALL_DOWNLOAD_ONLY=1; irm https://raw.githubusercontent.com/zkylek1212-k/Mulit-Harness-ADE/master/install.ps1 | iex
>   ```

### 方法二：直接自 GitHub Releases 下載

- 🚀 **[前往最新發行頁面（GitHub Releases）](https://github.com/zkylek1212-k/Mulit-Harness-ADE/releases/latest)**
- 下載 `Agent Workbench-<版本>-setup.exe` 雙擊即可安裝。
- *(免安裝綠色版：解壓後直接雙擊 `Agent Workbench.exe` 即可使用)*

---

## 開發與自原始碼建置

若您欲參與開發或進行除錯：

### 需求

- Node.js 18+（建議 LTS）
- Windows 上終端使用預編譯原生二進位（`@lydell/node-pty`），無需編譯工具鏈。

### 快速開始

```bash
git clone https://github.com/zkylek1212-k/Mulit-Harness-ADE.git
cd Mulit-Harness-ADE
npm install
npm run dev        # 開發模式啟動
```

## 建置與發佈 (Build & Publish)

```bash
npm run typecheck  # TypeScript型別檢查，不輸出
npm run build      # 編譯 main / preload / renderer
npm run dist       # 用 electron-builder 產生安裝檔
npm run release    # （僅限專案維護者）一鍵自動編譯、打包並發布至 GitHub Releases
```

> **關於 `npm run release` 的權限說明**：此指令為**專案維護者專用**，執行時會校驗本機 GitHub CLI (`gh`) 身分憑證。未獲授權的外部貢獻者（無倉庫寫入權限者）無法發布 Release，亦無法更動任何 GitHub 上的專案發行檔案。

安裝檔輸出於 `release/`；建置設定見 `electron-builder.yml`。

## 專案結構

```
src/main       Electron 主行程（IPC、git、pty、files、extensions）
src/preload    唯一的 IPC 契約介面
src/renderer   React UI（editor / git / terminal / preview / dashboard 面板）
.project-memory  跨 agent 共享記憶（handoff、protocol、decisions）
```

## iPhone 遠端控制

設定 → **遠端控制** 會在 app 內啟動一個小型 HTTPS 伺服器，只接受私有區網位址（10/8、172.16/12、192.168/16）連線。Windows 第一次開啟時防火牆會詢問，請允許「私人網路」。

1. **信任這台電腦（只需一次）**：用 iPhone 相機掃第一個 QR code，在 Safari 開啟。下載描述檔並安裝（設定 → 一般 → VPN 與裝置管理），再到 設定 → 一般 → 關於本機 → 憑證信任設定 打開完全信任。iOS 只允許在「可信任的 HTTPS」下使用主畫面 App、Service Worker 與推播，所以需要這一步。
2. **安裝 App**：用 Safari 開啟 App 網址 → 分享 → **加入主畫面**。
3. **配對**：從主畫面開啟，在電腦上按「產生配對碼」後輸入（或掃配對 QR code）。主畫面 App 與 Safari 不共用儲存空間，請在主畫面 App 內配對。
4. 選用：在 App 的設定開啟通知，agent 等待審批或任務結束時會收到提醒。

安全設計：

- 本機 CA 帶 critical 的 X.509 Name Constraints，只能簽私有 IPv4 與 `*.local`；即使私鑰外洩也簽不出能在手機上冒充公開網站的憑證。私鑰以 OS 金鑰（Electron `safeStorage`）加密。「重設憑證與所有裝置」會產生新的 CA。
- 配對碼一次性、5 分鐘失效、錯 10 次作廢。裝置取得隨機 token，本機只存 SHA-256；撤銷裝置會立即斷線。
- 已配對的手機擁有完整終端控制權，包括開新的 agent（會套用 Bypass 模式）與開關 Bypass 模式；從手機開啟 Bypass 需先確認，電腦上會跳出通知。有裝置連線時標題列會顯示手機標示；配對、連線、開關終端等事件記錄在 app 使用者資料夾的 `remote/audit.log`（不記錄任何輸入內容）。
- 推播內容以 RFC 8291 端對端加密給手機，經 Apple 推播服務轉送，因此推播需要電腦能連網；其餘流量都只在區網內。

開發模式下，手機端頁面取自 build 產物：用 `npm run dev` 測試前請先執行一次 `npm run build`。

## 設定備註

- `src/preload/index.ts` 是主行程與 renderer 之間的**唯一 IPC 契約**。
- `src/renderer/src/store.ts` 保存跨面板狀態。
- 主題顏色來自 `src/renderer/src/styles.css` 的 CSS 變數——請勿在面板內寫死顏色。
- 每台機器各自的 runtime state（`.workbench/settings.json`、`.workbench/dashboard-state.json`）
  已被 git 忽略；`.workbench/extensions.yaml` 為納入版控的範本。CLI 與文件工具路徑於執行時
  自動偵測，在 app 內設定前預設為未指定（unspecified）。
- 儀表板快取（`dashboard-cache.json`、`usage-cache.json`）放在 app 的使用者資料夾，所有視窗共用。
  「當前工作區」由各視窗自行判斷；主行程不會以「目前聚焦的視窗」來歸屬 session。
- `npm run dev` 使用獨立的使用者資料夾（`agent-workbench-dev`），可與已安裝版本同時執行，互不共用設定與快取。

## 版本紀錄與變更日誌

請參閱 [CHANGELOG.md](CHANGELOG.md) 了解詳細的版本歷程與更新內容。

## 授權

[MIT](LICENSE) © 2026 zkylek1212-k。

## 商標與關聯聲明

本專案為獨立工具，**與 Anthropic、OpenAI、Google、Microsoft 無任何關聯、亦未獲其背書或贊助**。
"Claude Code"、"Codex"、"Antigravity"、"VS Code" 等產品名稱為各自所有者之商標，於此僅作說明
互通性之用（nominative use）。本工作台不捆綁上述任何產品，只啟動使用者自行安裝的 CLI。

## 第三方軟體

所有捆綁的 runtime 依賴皆為寬鬆授權（MIT），包含 `monaco-editor`、`@monaco-editor/react`、
`@xterm/xterm`、`react`、`react-dom`、`react-markdown`、`rehype-highlight`、`remark-gfm`、
`mermaid`、`simple-git`、`js-yaml`、`@lydell/node-pty`、`ws`、`qrcode`，以及 `node-forge`（BSD-3-Clause，
用於產生遠端控制憑證）。這些元件仍受其各自授權條款約束。

終端 dev server 網址偵測（`src/renderer/src/panels/terminal/portDetect.ts`）改寫自
[AgentsDock](https://github.com/ZhengyiLuo/AgentsDock)，採 Apache License 2.0 授權。
