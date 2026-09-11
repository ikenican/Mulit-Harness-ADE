# implement_dispatch.md — 手機 Dispatch App（綁定連線 + 遠端派工）

> 目標：做一支手機 App，**綁定**桌面 Agent Workbench 後，能從手機**遠端 dispatch**
> —— 選一個 CLI agent（Claude / Codex / Antigravity）+ 打一段 prompt，送到桌面在
> 對應工作區起 / 送入終端跑；並在手機看 session 狀態、收「等待審批 / 完成」通知。
>
> **核心定位**：手機 App 是**遙控器（remote control / relay）**，不是第二個 runtime。
> Agent 迴圈、CLI、審批全部仍在**桌面**跑（沿用現有 `pty.spawn` / `pty.write` / dashboard）。
> 手機只負責：**下指令、看狀態、收通知、必要時遠端核准**。桌面是唯一可信執行者。

本文件為**規劃**，尚未寫任何程式。分支：`feat/mobile-dispatch`。

---

## 0. 為什麼這樣切（設計前提）

| 前提 | 影響 |
| --- | --- |
| 桌面 = Electron，所有能力在 main（`pty`/`git`/`files`/`dashboard`/`conn`），renderer 只透過 `window.api.*`（見 `src/preload/index.ts`）| 手機要用的能力，桌面 main 端**已經有**，只差一個對外的網路橋 |
| 「dispatch」現況 = `sendToTerminal(text)` 貼字（不自動送出）＋ `openTerminalSession` ＋ `pty.spawn(launcherId)` 起 CLI（`agents/*.yaml`）| 遠端 dispatch = 讓手機能觸發同一條路徑，語意不變 |
| 無 API Key、憑證只在 OS 加密儲存、CLI 各自有審批迴圈 | 手機**不需要**拿 agent 金鑰；風險集中在「誰能叫桌面跑東西」→ 綁定與授權是重點 |
| 手機與桌面**不一定同網段** | 傳輸要分兩階段：先 LAN 直連（MVP），再加 relay（v2） |

---

## 1. MVP 範圍（v0.1，先能用）

**做：**
1. 桌面開一個本機 **Dispatch 服務**（WebSocket over TLS，綁 LAN，不對公網），可在設定開關。
2. **QR 綁定**：桌面設定顯示 QR（host:port + 一次性配對碼 + 憑證指紋）；手機掃碼完成配對，取得**可撤銷的裝置 token**。
3. 手機能做四件事：
   - `listAgents` / `listWorkspaces`：看可用 CLI 與工作區。
   - `dispatch(agent, prompt, workspace)`：桌面起 / 復用該 agent 終端，投入 prompt。
   - `listSessions`：看目前 session（沿用 `dashboard.data().sessions`）。
   - `subscribeStatus`：即時收 session 狀態變化（active / waiting_approval / done / error）。
4. **推播**：session 進入 `waiting_approval` 或 `completed` / `error` 時推到手機。

**先不做（v2+，見 §7）：** relay 離線連線、遠端核准審批動作、手機看 diff / 編輯檔案、多桌面切換、語音輸入。

---

## 2. 系統架構

```
┌─────────────── 手機 App (Expo / React Native) ───────────────┐
│  Pair 畫面(掃 QR) · Dispatch 畫面(選 agent+workspace+prompt)   │
│  Sessions 列表 · 狀態即時流 · 推播通知                          │
└───────────────▲───────────────────────────────┬──────────────┘
                │  WSS (TLS + device token)      │  Push (FCM/APNs via Expo)
                │  JSON 訊息協定 (§4)             ▼
┌───────────────┴───────────────────────────────────────────────┐
│  桌面 Electron main：新增 bridge 模組                           │
│   src/main/bridge/server.ts    WSS 伺服器 + 訊息路由            │
│   src/main/bridge/pairing.ts   QR / 配對碼 / 憑證 / 裝置管理     │
│   src/main/bridge/devices.ts   已配對裝置 store(OS 加密, 可撤銷) │
│   src/main/ipc/bridge.ts       renderer 用的 IPC(開關/QR/撤銷)   │
│        │ 直接呼叫既有能力（同進程，不繞 renderer）              │
│        ├─ pty.spawn / pty.write        → 起 CLI、投 prompt       │
│        ├─ dashboard 掃描                → session 列表 / 狀態      │
│        └─ settings / launchers          → agent、工作區清單       │
└────────────────────────────────────────────────────────────────┘
```

**要點**：bridge 在 **main 進程**內，直接呼叫 pty / dashboard 現有函式，**不透過 renderer**（renderer 可能沒開、或被最小化）。因此需把 `pty.ts`、`dashboard.ts` 目前綁在 ipcMain handler 裡的邏輯，抽出成**可被 bridge 與 ipc 共用的純函式**（見 §5 重構）。

---

## 3. 綁定與安全模型（最關鍵）

開一個會「叫機器跑 CLI」的網路埠，安全是第一位。原則：**預設關閉、LAN only、一裝置一 token、可撤銷、能力受限**。

1. **服務預設關**：使用者在設定手動開「Dispatch 服務」才啟動；顯示目前綁定的埠與裝置數。
2. **綁定 = TOFU 配對**：
   - 桌面產生自簽 TLS 憑證（首次），QR 內含 `host:port` + **一次性配對碼**（90 秒有效）+ 憑證指紋。
   - 手機掃碼 → 用配對碼做 challenge-response → 桌面發**長期裝置 token**（每裝置一組，存 OS 加密）→ 手機釘住憑證指紋（之後只信這張憑證）。
3. **每則訊息驗 token**；桌面可在設定列出裝置、隨時**撤銷**（token 失效即斷線）。
4. **綁 LAN、不綁 0.0.0.0 公網**；MVP 僅同網段可連。離線連線走 v2 relay（§7），且 relay 只轉密文、看不到內容。
5. **能力白名單**：手機只能呼叫 §4 定義的訊息（dispatch / listSessions / status…）。**不開放**：任意 shell、任意 `pty.write` 控制碼、讀寫工作區外檔案。
6. **dispatch 邊界**：dispatch 只把 prompt 投給 CLI，**CLI 自身的審批迴圈仍在桌面生效**（危險操作照樣要在桌面按核准）。v1 手機**不能**代按核准；v2 才做「遠端核准」且需二次確認。
7. **速率限制 + 稽核**：每裝置限流；所有 dispatch 記 log（誰、何時、哪個 agent、prompt 摘要）供事後查。

> 合規紅線：手機端**不存**任何 agent 金鑰或連線憑證；憑證只留在桌面 OS 加密儲存（沿用 `conn` 模組原則）。

---

## 4. 訊息協定（WSS，JSON，版本化）

單一 WS 連線，雙向 JSON；每則帶 `v`(協定版本)、`id`(對應 request/response)、`type`。

**手機 → 桌面（request）**
| type | payload | 說明 |
| --- | --- | --- |
| `hello` | `{ deviceToken }` | 連線後第一則，驗證 |
| `listAgents` | – | 回可用 CLI（`settings.cliEnabled` + `pty.launchers`）|
| `listWorkspaces` | – | 回近期 / 已開工作區 |
| `dispatch` | `{ agent, prompt, workspace, mode }` | `mode`: `newSession` 起新終端 / `activeSession` 投目前 |
| `listSessions` | – | 回 `AgentSessionInfo[]`（沿用 dashboard）|
| `subscribe` | `{ topics:['status'] }` | 訂閱狀態流 |

**桌面 → 手機（event / response）**
| type | payload |
| --- | --- |
| `ack` | `{ id, ok, error? }` |
| `agents` / `workspaces` / `sessions` | 對應資料 |
| `sessionUpdate` | `{ sessionId, status, agent, title, tokens }` |
| `dispatchResult` | `{ id, sessionId, ok, error? }` |
| `needsAttention` | `{ sessionId, reason:'waiting_approval'|'completed'|'error' }` → 同步觸發推播 |

版本不合 → 桌面回 `ack{ok:false,error:'version'}`，手機提示升級。

---

## 5. 桌面端要做的事（Electron main）

**A. 重構（讓 bridge 能重用既有能力，不繞 renderer）**
- 把 `src/main/ipc/pty.ts` 的 spawn / write 核心抽成 `src/main/pty/core.ts` 純函式；`ipc/pty.ts` 與 bridge 都呼叫它。
  - ⚠️ 不動 `hardKill()` 語意、`@lydell/node-pty`、`asarUnpack`（見專案 warnings）。
- 把 `src/main/ipc/dashboard.ts` 的掃描邏輯抽成可直接呼叫的函式，供 bridge 取 session。

**B. 新增 bridge 模組**
- `src/main/bridge/server.ts`：WSS 伺服器、訊息路由、token 驗證、限流、稽核 log。
- `src/main/bridge/pairing.ts`：自簽憑證產生 / 快取、一次性配對碼、QR 內容組裝。
- `src/main/bridge/devices.ts`：裝置 token store（OS 加密，沿用 conn 儲存方式）、列表 / 撤銷。

**C. 新 IPC + 契約（沿用「preload 唯一契約」規則）**
- `src/main/ipc/bridge.ts` + `src/preload/index.ts` 加 `window.api.bridge.*`：
  `start()` / `stop()` / `status()` / `pairingInfo()`(回 QR 內容) / `listDevices()` / `revokeDevice(id)`。
- 型別加到 `src/preload/index.d.ts` / preload 的 export interfaces。

**D. 設定 UI**
- `SettingsModal` 加「Dispatch 服務」分頁：開關、埠、QR、裝置列表 + 撤銷、稽核 log 入口。

**E. 依賴**
- WSS：Node 內建 `https` + `ws`（新增 `ws`）。QR：桌面端 `qrcode`（產 QR）；手機端掃碼用 Expo Camera。
- 憑證：Node 內建 `crypto` 自簽即可，不引重量級套件。

---

## 6. 手機 App（新專案，不放進本 repo 主樹）

- **技術選型（建議）**：**Expo (React Native) + TypeScript**。理由：與桌面同 React/TS 技術棧、單一碼庫雙平台、內建推播（Expo Notifications → FCM/APNs）、OTA。
  - 替代：PWA（更輕、但**背景推播與相機掃碼受限**，iOS 尤甚）→ 僅在「只想快速試」時考慮，MVP 不選。
- **畫面**：Pair（掃 QR）→ Dispatch（選 agent + workspace，多行 prompt，送出）→ Sessions（列表 + 狀態即時）→ 通知。
- **狀態 / 連線**：WSS 長連線 + 重連退避；token 存手機安全儲存（Expo SecureStore）。
- **擺放**：新開 repo（如 `Mulit-Harness-ADE-mobile`）或本 repo 的 `mobile/` 子目錄；**建議獨立 repo**，避免 Electron 與 RN 的 build 工具鏈互相污染。

---

## 7. 里程碑（分階段，每階段可獨立驗收）

| 階段 | 內容 | 驗收 |
| --- | --- | --- |
| **M0 協定凍結** | 定 §4 訊息 schema + §3 綁定流程，寫成 `bridge/protocol.ts` 型別 | 型別編譯過、雙方共用 |
| **M1 桌面 bridge** | WSS + 配對 + 裝置 store + `dispatch`/`listSessions`；用 `wscat`/測試腳本打通 | 指令列能配對並成功 dispatch 起一個 CLI session |
| **M2 pty/dashboard 重構** | 抽純函式，bridge 直呼；不繞 renderer | renderer 最小化時仍能 dispatch |
| **M3 桌面設定 UI** | Dispatch 分頁：開關 / QR / 裝置撤銷 | 能產 QR、能撤銷裝置即斷線 |
| **M4 手機 App MVP** | Expo：掃碼配對 + dispatch + sessions 即時 | 手機掃碼 → 送 prompt → 桌面跑起來 → 手機看到狀態 |
| **M5 推播** | `needsAttention` → Expo Notifications | 桌面 session 等待審批時手機收到推播 |
| **v2（另立計畫）** | relay 離線連線、遠端核准（二次確認）、手機看 diff | — |

---

## 8. 風險與未定事項

- **安全面最大**：對外開埠 + 能觸發 CLI。緩解＝預設關、LAN only、token 可撤銷、能力白名單、CLI 審批仍在桌面、稽核 log。上公網前務必再審。
- **離線連線**：不同網段 MVP 連不到；v2 需 relay（自架小 relay 或 Cloudflare Tunnel），且 relay 只轉密文。
- **自簽憑證體驗**：TOFU 指紋釘選，需清楚的手機端 UI 說明，避免使用者被中間人騙過。
- **背景存活**：手機背景時長連線會被系統殺 → 靠推播喚醒 + 重連，不靠常駐連線收即時狀態。
- **重構風險**：抽 pty 純函式時勿破壞 warnings 清單（`hardKill` / `@lydell/node-pty` / `asarUnpack` / App.tsx 終端結構）。

### 待你拍板（會影響 M0）
1. **手機是否要能「遠端核准」CLI 的危險操作**？（安全 vs 方便；建議 v2 且要二次確認）
2. **離線連線**要不要進 v1？要的話得先決定 relay 方案。
3. 手機 App **獨立 repo** 還是本 repo `mobile/` 子目錄？（建議獨立）
4. dispatch 後手機是否要**看終端輸出串流**（更耗流量/電）？還是只看狀態摘要 + 通知？

---

## 9. 這份計畫沒做的（YAGNI，需要再加）

- 不做多使用者 / 帳號系統（單人、多裝置即可）。
- 不做手機端完整編輯器（看 diff 都排到 v2）。
- 不自建推播後端（用 Expo 託管的 FCM/APNs）。
- 不在 MVP 支援多台桌面切換。
