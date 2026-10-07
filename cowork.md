# Cowork.md — 多 Agent 協作模式設計草案

- 日期：2026-10-07（Asia/Taipei）
- 狀態：**設計草案，未實作**。徵求 Codex / Antigravity 覆核
- 作者：Claude Opus 5（與使用者對談收斂）
- 對應程式基準：`master` @ `b6c7841`（v0.1.38）

> **給覆核者**：本文件刻意把「被否決的方案」與「理由」一起寫出來，方便你反駁。
> 若你認為某個決策錯了，請直接針對第 9 節的開放問題，或任何標 🔶 的決策。

## 驗證狀態標記

| 標記 | 意思 |
|---|---|
| ✅ 已驗證 | 實際跑過指令或逐行讀過原始碼確認 |
| ⚠️ 未驗證 | 推論合理但未實測 |
| 🔶 設計決策 | 判斷題，歡迎反對 |

---

## 0. 需求

終端區新增一個 **Cowork** 選項。打開後使用者發一則 prompt，由 Settings 中 enable 的 agent 共同處理：
它們先討論並決定誰負責什麼任務，然後各自執行。

使用者原始構想包含：
- 由 Settings 指定一個 agent 當**主席**，主席開啟第一輪談話
- 介面像**聊天室**
- 用 **git（worktree）做資料追蹤**

本文件對這三點的處置：主席**採用**；聊天室**採用但重新定位**；git worktree **部分採用，見第 2 節**。

---

## 1. ⚠️ 與現有定位的衝突（**請先裁決這一條**）

`implement.md` 第 0 節的立項原則寫著：

> **核心定位（重要）**：本工作台**不是 agent runtime、也不是協調者**。
> Agent 迴圈由各家官方 CLI 原生負責；跨 CLI 的分工與共享脈絡由 ShareProjectMem 負責。
> 工作台只做四件事：代碼編輯 + Git 視覺化 + 起 N 個 CLI 終端殼 + 渲染共享記憶。

**Cowork 直接牴觸這一條** —— 它讓工作台成為協調者。

三個選項：

| 選項 | 說明 |
|---|---|
| A | 修訂 `implement.md`，把定位擴張為「工作台也做跨 CLI 協調」 |
| B | 把 Cowork 做成可停用的獨立模式，核心四件事不變，Cowork 是加值層 |
| C | 放棄 Cowork，改用 ShareProjectMem 的 `handoff.md` 手動分工 |

**本文件假設走 B。** 若覆核者認為應走 A 或 C，後面的設計要重寫。

---

## 2. 🔶 資料追蹤：三層拆開，不要用 git 做協調

使用者原提議用 git worktree 做追蹤。經拆解，這裡混了兩件事：

| 關注點 | 需要什麼 | git worktree 適合？ |
|---|---|---|
| **隔離** — 多 agent 同時改檔不打架 | 各自獨立工作目錄 | ✅ 正是其用途 |
| **追蹤** — 誰負責什麼、做到哪、誰等誰 | 可查詢的狀態 | ❌ 不適合 |

用 git 做協調追蹤的具體問題：
1. 任務狀態不是檔案內容 → 要寫 status 檔再 commit，污染歷史
2. **status 檔本身會 merge conflict**
3. branch 表達不了「t3 等 t1 完成」
4. 無法便宜地查詢

**決策：拆三層，各用對的工具。**

| 層 | 用什麼 | 存哪 |
|---|---|---|
| 協調狀態 | run manifest（JSON，單一寫入者） | `.workbench/cowork/<runId>/run.json` |
| 工作隔離 | 預設檔案範圍切分；worktree 選配 | — |
| 成果記錄 | **git** — 一個任務一個 commit，掛 `cowork/<runId>` 分支 | repo |

git 記的是**結果**不是協調。這是 git 擅長的事：稽核與回滾。

### 2.1 🔶 為什麼 worktree 不當預設

- 本 repo 一個 worktree 要一份 `node_modules`（安裝很重），3 agent = 3 份
- dev server 只有一個能佔 5173
- 平行改完的 merge 是多 agent 系統最常死的地方

預設用**檔案範圍切分**：規劃階段本來就要產出「誰負責什麼」，而那自然等於「誰負責哪些檔案」。

### 2.2 ⚠️ 但 worktree 有一個真正的理由：commit 歸屬

scoped 模式下多 agent 同時改同一棵樹，`git add -A` 會掃進別人做到一半的檔案。只能**按 scope 路徑 commit**。
但 agent 很常順手改範圍外的檔案（修個相鄰型別錯誤），這些會漏掉。

處置（不要耍小聰明做部分 commit）：
1. 按 scope commit
2. 收斂時做一筆 **sweep commit** 收掉殘留，歸給整個 run 而非某任務
3. 越界檔案記進 manifest，UI 標警告

**所以 `isolation` 的判準不是「任務大小」而是「要不要精確的 per-task 回滾」**：
- `'scoped'`（預設）— 接受歸屬有損
- `'worktree'` — 歸屬精確，代價是環境成本

---

## 3. ✅ 關鍵實作前提：三家 CLI 都能非互動跑並吐結構化輸出

實際執行 `--help` 驗證（2026-10-07，本機）：

| CLI | 非互動 | 結構化輸出 | 其他相關 |
|---|---|---|---|
| `agy`（Antigravity） | `-p` / `--print` | `--output-format json`、**`--json-schema`（可強制 schema）** | `--mode plan`、`--effort low\|medium\|high\|max` |
| `codex` | `codex exec` | `--output-format`（⚠️ 細節未逐一驗證） | `codex review`（非互動 code review）、`codex queue` |
| `claude` | `-p` / `--print` | `--output-format json` | ⚠️ 本機 PATH 上沒有，未實測；依官方文件 |

**這決定了整個架構的切法：**

> **規劃階段跑 headless（一次性、JSON、可解析）；執行階段跑互動 PTY（看得到、插得了手）。**

規劃要可靠與結構 → headless 給真正的 JSON，**完全不需要刮終端畫面**。
執行要可視與介入 → 互動終端，這正是本工作台存在的理由。

### 3.1 🔶 被否決的方案：通用 agent mesh

初版設計曾考慮做一套通用的 agent 間訊息匯流排（mailbox / broker / 投遞時機 / presence 偵測）。**否決**。

理由：cowork 的拓樸是**星狀 + 狀態機**，不是網狀。agent 不需要自由互相喊話，只需要「拿到任務 / 回報結果 / 舉手」。
通用 mesh 是為了一個不存在的需求而建的。

### 3.2 🔶 被否決的方案：移植 herdr 的狀態偵測引擎

參考過 `herdr`（Apache-2.0）的做法：它用 22 份 TOML 規則對終端畫面做 `working/idle/blocked` 分類。

**否決。** 那套複雜度是 herdr「只擁有終端、刻意不碰 agent 設定」的代價。本工作台相反 ——
`src/main/ext/adapters.ts` 已經在幫三家產生原生設定檔，可以讓 agent 自己回報，不必猜。
而且走 headless JSON 之後，規劃階段根本不需要狀態偵測。

---

## 4. 會議協議（取代「自由討論」）

### 4.1 🔶 為什麼不做自由對話

使用者原構想是「主席開場後互相討論」。主席開場**採用**（見 4.2 理由），自由討論**不建議**：

1. **成本平方成長** — 每輪每人都要讀其他人說過的全部。3 agent × 3 輪 ≈ 10 次呼叫且 context 累積
2. **LLM 在對話中會附和** — 尤其附和主席框架與最後發言者。付三輪的錢，很可能拿回主席原案加裝飾。**有審議的外觀，沒有審議的內容**
3. **沒有終止條件** — 主席說了算 = 橡皮圖章；要共識 = 會繞圈

修法不是取消討論，是**讓討論只發生在真的有分歧的地方**。

### 4.2 ✅ 主席先開場比「平行盲提案」好

初版設計是所有 agent 平行盲提案。缺點：**三個 agent 各自從零讀一遍 codebase 去猜任務是什麼** ——
探索成本三倍，且得到三種範圍認知，很難對齊。

主席先產出**共用框架**，其他人在同一框架上回應。更便宜也更容易收斂。使用者這一版勝出。

### 4.3 四輪協議

**R1 主席開場**（1 次呼叫）
產出：框架、草案任務、範圍邊界、**明確列出自己不確定的問題**（給其他人打的靶）。

**R2 獨立回應**（N−1 次，平行，**彼此看不到對方的回應**）

```jsonc
{
  "agree":      ["t1", "t3"],
  "objections": [{ "target": "t2", "reason": "...", "alternative": "..." }],
  "missing":    [{ "title": "...", "why": "..." }],
  "claims":     ["t1"],
  "answers":    { "q1": "..." }
}
```

看不到彼此 = 獨立訊號而非回音。成本固定、線性。

> 設計依據：人類群體決策中「先各自獨立判斷、再攤開分歧」之所以常勝過自由會議，
> 正是因為自由會議會錨定在第一個／最大聲的發言者上。LLM 的附和傾向只會更強。

**R3 仲裁 —— 條件觸發**（0 或 1 次）
orchestrator 自動比對 R2，以下才算真衝突：
- 兩人對同一任務有不同反對意見
- 兩人搶同一任務
- 有人指出的缺漏其他人沒看到

只把**爭點**（非全文）交主席裁決。無衝突則直接跳過。

**R4 主席定案**（1 次，可與 R3 合併）
最終任務板。claims 不衝突就照它分。

**散會條件是機械的：沒有未解衝突就散會。** 不靠誰宣布。

### 4.4 成本對照（3 agent）

| 做法 | 呼叫次數 | context 成長 |
|---|---|---|
| 平行盲提案（初版） | 4 | 平，但要讀三遍 codebase |
| **主席開場 + 獨立回應 + 條件仲裁** | **4–5** | 平 |
| 自由對話三輪 | ~10 | 每輪累積 |

> ⚠️ 使用者為 compute 受限的個人使用者（見全域 CLAUDE.md §4.3），成本是**硬約束**不是偏好。

---

## 5. 散會之後：orchestrator 從主持人變排程器

### 5.1 排程

**每個 agent 一個 session，agent 內循序、agent 間平行。**

不是一任務一 session —— 同一 agent 做 t1 時已讀過 codebase，t3 在同 session 便宜很多；
且 3 agent = 3 分頁而非 7 分頁。

任務依賴全部 `done` 才 runnable。agent 的下個任務未 ready 就拉佇列中已 ready 的，都沒有就閒著。

### 5.2 注入終端的任務文字

```
[任務 t3] <title>
範圍：src/main/cowork/broker.ts, src/main/cowork/store.ts   ← 不要動範圍外的檔案
已完成的前置：
  t1（codex）：<t1 的 summary>  commit abc123
完成後呼叫 cowork.done(summary)；卡住呼叫 cowork.blocked(reason)
```

**依賴產出是從 manifest 流過去的，不是 agent 之間對話。** t3 讀的是 t1 回報的 summary 與 commit。
這是設計中少數真的需要跨 agent 傳遞資訊的地方，走共享狀態而非訊息。

### 5.3 回報介面（唯一需要 agent 配合的部分）

極小的 MCP 面，四個動作：

```
cowork.task()                  我的任務是什麼
cowork.done(summary)           做完了
cowork.blocked(reason)         卡住
cowork.ask(taskId, question)   問相鄰任務負責人（經 orchestrator 轉）
```

注入的任務文字明確寫「完成後呼叫 `cowork.done`」—— 這是**指令遵循**，比期待 agent 主動輪詢可靠得多。
保險層：逾時 + 閒置偵測 + git 有變更 → 問使用者「看起來完成了？」

`src/main/ext/adapters.ts` 已會幫三家寫 MCP 設定，註冊是現成的。

### 5.4 復會 —— 條件觸發

執行才會發現計畫錯了，這是常態。`cowork.blocked` 分兩種：

- **局部卡住**（缺資訊、要決策）→ 標 blocked，升級給使用者，依賴它的任務一起等
- **計畫失效**（發現缺任務、依賴假設破了、範圍要重切）→ **觸發復會**

復會 = R3 仲裁再跑一次，與會者縮到**主席 + 卡住的 agent**，議題只有該爭點。
產出是任務板的 patch（加任務／改範圍／改依賴），走同一道人工確認後繼續。

**機制完全重用。** 這也是把會議協議設計成「衝突驅動」的回報 —— 執行期意外剛好是另一種衝突。

### 5.5 收斂

1. **sweep commit** 收掉殘留（見 2.2）
2. **review（選配）** — 一個 agent 拿整段 diff 對照最初 prompt 檢查。`codex review` 現成
3. **run report** — 原始需求 → 會議決議 → 誰做了什麼 → 合併 diff → review 發現
4. **分支處置交給使用者** — `cowork/<runId>` 放著，UI 給 diff 與 merge / squash / 丟掉。**絕不自動 merge**
5. 問使用者要不要把 report 併進 `handoff.md`（⚠️ 本 repo 目前無 `.project-memory/`，見第 9 節）

完整弧線：

```
會議 → 任務板 → 人工確認 → 排程執行 ⇄ 復會(條件) → sweep → review → report → 使用者決定 merge
```

---

## 6. 介面：逐字稿 + 控制面，不是聊天室

使用者問「可以像聊天室嗎」。可以，會議協議本來就是一條有作者有順序的串。**但定位要分清楚。**

🔶 差別在輸入框：聊天室隱含「任何人隨時可說任何話」，但執行期自由打字**沒有定義的行為** ——
要廣播？給主席？那就是 4.1 反對的無界討論從 UI 爬回來。

### 6.1 版面

**對話串為主欄 + 任務板常駐**（側欄或頂部，可收合）。

串講故事，板講狀態。任務板不能只是串裡捲走的某則訊息 —— 7 任務 3 agent 加依賴是表格不是捲軸。

Cowork run 就是**終端欄裡的一個分頁**，參與的 agent session 是兄弟分頁。點任務 → 切到該 agent 分頁。
零新版面，塞進現有 tab bar。

### 6.2 串的內容

| 型別 | 渲染 |
|---|---|
| R1 主席開場 | 框架 + 草案任務 + 待答問題（可展開） |
| R2 各自回應 | **結構化卡片**：同意 / 反對(含替代方案) / 補充 / 認領 |
| R3 仲裁 | 只顯示爭點與裁決 |
| R4 定案 | → 任務板 |
| 執行事件 | `t2 開始` / `t2 完成 · abc123` / `t3 卡住` |
| 卡住提問 | **行內可回覆** |
| 復會 | 縮排子串 |
| 收斂報告 | diff 摘要 + merge / squash / 丟掉 |

**R2 一定要渲染成卡片，不是把 JSON 或散文塞進對話泡泡。** 強制結構化輸出的全部價值就在這裡 ——
「codex 反對 t2：理由…（替代方案…）」一眼掃完。倒成 prose 等於把付錢換來的結構丟掉。

Agent 頭像用現成的 `AgentMark`（`src/renderer/src/components/AgentMark.tsx`）。

### 6.3 輸入框：依階段變形 + `@` 路由

- **會議進行中** → 只能「插話補充」，併進主席下一輪
- **等待確認** → 改板、或打字給回饋讓主席修（這才是真正有意義的對話輸入）
- **執行中** → `@codex 這裡注意 X` 路由進該 session；純文字 = 給整個 run 的註記
- **收斂** → merge 決策

`@agent` pattern 已存在（`TerminalPanel.tsx` 的 `@ Prompt` modal 與 agent chips），延用。

### 6.4 不做的事

**不鏡像終端輸出到串裡。** 會變成有損副本，使用者不知道該信哪邊。串只放事件，點了跳終端。

唯一例外：卡住的任務摺疊顯示最後 10 行，讓使用者不切分頁就能判斷。有界且有用。

### 6.5 讓協議本身看得見

聊天室外觀會讓人期待 agent 一直聊下去。串裡要明確標出結構：

```
—— 第二輪 · 獨立回應（2/2 已回） ——
—— 無未解衝突，略過仲裁 ——
—— 散會 · 任務板已產出 ——
```

使用者看到的是「協議跑完了」，不是「怎麼突然沒人講話」。比任何說明文字有效。

---

## 7. 資料模型

```jsonc
// .workbench/cowork/<runId>/run.json   單一寫入者 = main 的 orchestrator
{
  "id": "r7f3a",
  "prompt": "使用者原本那一句",
  "createdAt": 1791400000000,
  "chair": "claude",
  "participants": ["claude", "codex", "antigravity"],
  "isolation": "scoped",              // 或 "worktree"
  "branch": "cowork/r7f3a",
  "phase": "meeting|awaiting-approval|executing|converging|done",
  "tasks": [{
    "id": "t1",
    "title": "...",
    "detail": "...",
    "scope": ["src/..."],             // 檔案範圍 = 隔離單位
    "dependsOn": [],
    "assignee": "codex",
    "status": "pending|running|blocked|done|failed",
    "sessionId": "pty#...",
    "commit": "abc123",
    "summary": "...",
    "outOfScopeFiles": []             // 越界偵測結果
  }],
  "log": [ /* append-only 事件，給時間軸用 */ ]
}
```

```
.workbench/cowork/<runId>/meeting/
  r1-chair.json
  r2-codex.json   r2-antigravity.json
  r3-arbitration.json
  r4-board.json
```

🔶 **不要資料庫。** 一次 run 幾十個任務、單一寫入者，一個 JSON 檔就是正確答案。
`meeting/` 留原始輸出備查 —— 計畫出錯時需要看得到是哪一步歪的，這是能不能調校的關鍵。

⚠️ `.workbench/cowork/` 需加進 `.gitignore`（現有 `.gitignore` 已逐項列 `.workbench/` 下的 runtime 檔）。

---

## 8. Settings

沿用現有 `settings.cliEnabled` 形狀（`src/main/ipc/settings.ts`）：

```ts
cowork: {
  chair: AgentId | 'auto',        // 'auto' = 取最強的 enabled
  participants: AgentId[] | 'all-enabled',
  allowArbitration: boolean,      // R3，預設 true
  requireApproval: boolean,       // 執行前人工確認，預設 true
  chairExecutes: boolean          // 見下
}
```

主席做最貴的推理（開場框架 + 仲裁），UI 應提示「選強的」，`auto` 挑最強而非第一個。

🔶 **`chairExecutes`**：主席同時執行有兩個問題 —— 有動機把有趣任務分給自己，且執行會弄髒 context 使後續仲裁品質下降。
但參與者只有 2 個時主席不下場 = 零平行度。
預設 `true`，participants ≥ 3 時建議關掉。一個 boolean，不值得做自動判斷。

### 8.1 成本控制（硬約束）

- 規劃階段用低 effort、限制輸出長度（`agy` 有 `--effort`）
- 預設參與者 **2 個**，不是全部 enabled
- 任務板顯示 token 花費（Dashboard 已有 per-session token）
- 執行前 approval gate **預設開啟**

---

## 9. 開放問題（請覆核者優先回應這幾條）

| # | 問題 | 現狀 |
|---|---|---|
| 1 | **第 1 節的定位衝突該走 A/B/C 哪條？** | 本文假設 B |
| 2 | `codex exec` 與 `claude -p` 的結構化輸出細節未逐一驗證（只有 `agy` 確認有 `--json-schema`）。沒有 schema 強制時，容錯解析要做到什麼程度？ | 擬抓第一個合法 JSON 區塊 |
| 3 | R2 的「彼此看不到」是否太保守？是否該讓第二輪看得到別人的 **objections**（但看不到完整回應）？ | 目前全不給 |
| 4 | scoped 模式的 commit 歸屬有損（2.2）。是否該直接預設 worktree，吃掉環境成本？ | 預設 scoped |
| 5 | 本 repo 無 `.project-memory/`（CLAUDE.md 有提到但未 scaffold）。run report 要落到哪？ | 待定 |
| 6 | agent 不呼叫 `cowork.done` 的機率有多高？若實測很高，是否要改成「orchestrator 主動問」而非等回報？ | 未實測 |

---

## 10. 落地順序

| 階段 | 內容 | 單獨有用嗎 |
|---|---|---|
| **P1** | headless runner（`execFile` 包三家 `-p`/`exec`，回 JSON）＋ run manifest ＋ 四輪會議協議 ＋ 串/板 UI。**執行階段先手動**（人按「派給這個 agent」走現有 dispatch） | ✅ 單這樣就是「多 agent 幫你拆任務」的工具 |
| **P2** | 自動執行：開 PTY、注入任務、`cowork` MCP 四動作、完成即 commit | 完整閉環 |
| **P3** | 依賴排程、`cowork.ask`、復會、sweep、converge review、越界偵測 | |
| **P4** | worktree 隔離選項、run 重播、失敗重指派 | |

**P1 把最難的（結構化規劃 + 會議協議）先驗證掉，而且完全不碰 PTY，風險最低。**

---

## 11. 已知會出事的地方

| # | 風險 | 處置 |
|---|---|---|
| 1 | 併計畫併出糊話，scope 互相重疊 | approval gate 擋；R4 的 prompt 明確要求 scope 互斥 |
| 2 | agent 不呼叫 `cowork.done` | 逾時 + 閒置 + git 變更三訊號兜起來問人 |
| 3 | 越界改檔 | 偵測並標示，**不硬擋**（硬擋會讓 agent 卡死在它無法理解的錯誤裡） |
| 4 | 一個 agent 中途掛掉 | 任務退回 pending，由人決定重派或自己接 |
| 5 | 只有 `agy` 有 schema 強制 | 容錯解析，不假設輸出乾淨 |
| 6 | 成本失控 | 參與者上限、approval gate、板上顯示 token |
| 7 | **聊天室隱喻引導使用者期待自由對話** | 6.5 的協議標記 |

---

## 附錄 A：參考過但未採用的外部設計

**herdr**（<https://github.com/herdrdev/herdr>，Apache-2.0，Rust）—— 專為 coding agent 設計的終端多工器。

讀過的部分：`skills/herdr/SKILL.md`、`src/detect/manifests/*.toml`、`src/api/`。

值得知道的三件事：

1. **它的 agent 狀態偵測是宣告式 TOML 規則引擎**（22 家 CLI），對終端畫面的純文字快照分類 `working/idle/blocked/done/unknown`。規則有 region（`bottom_non_empty_lines(12)`、`prompt_box_body`、`osc_title`）、priority、`not`/`any`/`all`。
2. **它的 `agent prompt` 語義充滿踩坑紀錄**：目標在核准對話框就拒送、送出後 5 秒沒觀察到活動回 `stalled`、timeout 不代表沒送到所以不准盲目重送。
3. **它刻意不碰 agent 設定**（README 原話：*doesn't wrap or replace them; it owns their terminals*）。

**為什麼本設計不照抄**：第 2、3 點的複雜度是第 3 點那個自我限制的代價。
本工作台已經在幫三家產生原生設定檔，且 headless 路徑可以完全繞開畫面解析 —— 照抄等於主動丟掉自己的優勢。

⚠️ 若未來真的需要狀態偵測，herdr 的 manifest 是 Apache-2.0，本專案是 MIT。
直接複製 `.toml` 需保留 Apache 標頭與出處並加 `NOTICE`（相容，但不能默默拿走）。
