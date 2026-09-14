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
- **Dashboard & Telemetry** — local session/token statistics scanned from local CLI records (Claude Code, Codex, Antigravity) with 42x fast mtime caching, CLI enable/disable dynamic filtering, folder grouping, and one-click workspace switching.
- **Fast Startup & Mount-on-Demand** — 42x accelerated cold startup powered by disk-persisted session caches and lazy-loaded sidebar/central panels.
- **Bilingual i18n** — full interface localization supporting seamless toggling between Strict English and Traditional Chinese.

## Requirements

- Node.js 18+ (LTS recommended)
- On Windows the terminal uses a prebuilt native binary (`@lydell/node-pty`); no
  compiler toolchain is required.

## Getting started

```bash
git clone https://github.com/zkylek1212-k/Mulit-Harness-ADE.git
cd Mulit-Harness-ADE
npm install
npm run dev        # launch in development
```

## Build

```bash
npm run typecheck  # TypeScript check, no emit
npm run build      # compile main / preload / renderer
npm run dist       # build an installer with electron-builder
```

Installer output goes to `release/`. Build config is in `electron-builder.yml`.

## Project layout

```
src/main       Electron main process (IPC, git, pty, files, extensions)
src/preload    the single IPC contract surface
src/renderer   React UI (editor / git / terminal / preview / dashboard panels)
.project-memory  shared cross-agent memory (handoff, protocol, decisions)
```

## Configuration notes

- `src/preload/index.ts` is the **single IPC contract** between main and renderer.
- `src/renderer/src/store.ts` holds cross-panel state.
- Theme colors come from CSS variables in `src/renderer/src/styles.css` — do not
  hard-code colors inside panels.
- Per-machine runtime state (`.workbench/settings.json`,
  `.workbench/dashboard-state.json`) is git-ignored; `.workbench/extensions.yaml`
  is the checked-in template. CLI and document-tool paths are auto-detected at
  runtime and default to unspecified until configured in the app.

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

All bundled runtime dependencies are permissively licensed (MIT), including
`monaco-editor`, `@monaco-editor/react`, `@xterm/xterm`, `react`, `react-dom`,
`react-markdown`, `rehype-highlight`, `remark-gfm`, `mermaid`, `simple-git`,
`js-yaml`, and `@lydell/node-pty`. Their license terms continue to apply to those
components.

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
- **儀表板與遙測**——從本機 CLI 紀錄（Claude Code、Codex、Antigravity）極速掃描 session／token 統計，具備 mtime 快速快取、CLI 啟用動態連動、資料夾群組分類與一鍵工作區切換。
- **極速啟動與按需掛載**——檔案 mtime 持久化快取與面板按需載入（Mount-on-Demand），開機掃描效能大幅提升 42 倍。
- **雙語系支援**——全系統支援嚴謹英文與繁體中文介面即時無縫切換。

## 需求

- Node.js 18+（建議 LTS）
- Windows 上終端使用預編譯原生二進位（`@lydell/node-pty`），無需編譯工具鏈。

## 快速開始

```bash
git clone https://github.com/zkylek1212-k/Mulit-Harness-ADE.git
cd Mulit-Harness-ADE
npm install
npm run dev        # 開發模式啟動
```

## 建置

```bash
npm run typecheck  # TypeScript 型別檢查，不輸出
npm run build      # 編譯 main / preload / renderer
npm run dist       # 用 electron-builder 產生安裝檔
```

安裝檔輸出於 `release/`；建置設定見 `electron-builder.yml`。

## 專案結構

```
src/main       Electron 主行程（IPC、git、pty、files、extensions）
src/preload    唯一的 IPC 契約介面
src/renderer   React UI（editor / git / terminal / preview / dashboard 面板）
.project-memory  跨 agent 共享記憶（handoff、protocol、decisions）
```

## 設定備註

- `src/preload/index.ts` 是主行程與 renderer 之間的**唯一 IPC 契約**。
- `src/renderer/src/store.ts` 保存跨面板狀態。
- 主題顏色來自 `src/renderer/src/styles.css` 的 CSS 變數——請勿在面板內寫死顏色。
- 每台機器各自的 runtime state（`.workbench/settings.json`、`.workbench/dashboard-state.json`）
  已被 git 忽略；`.workbench/extensions.yaml` 為納入版控的範本。CLI 與文件工具路徑於執行時
  自動偵測，在 app 內設定前預設為未指定（unspecified）。

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
`mermaid`、`simple-git`、`js-yaml`、`@lydell/node-pty`。這些元件仍受其各自授權條款約束。
