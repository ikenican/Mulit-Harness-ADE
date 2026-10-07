# Cowork.md — 多 Agent 協作模式設計計畫

- 日期：2026-10-07（Asia/Taipei）
- 狀態：**修訂設計，未實作**。本次覆核修正隔離、權限、完成語義與落地順序
- 原作者：Claude Opus 5；修訂：Codex
- 原稿基準：`master` @ `b6c7841`（v0.1.38）
- 本次覆核基準：`docs/cowork-design` @ `98d4e23`；讀取原始碼、CLI help 與 Claude 官方文件，**未執行模型任務或實作 Cowork**

| 標記 | 意思 |
|---|---|
| ✅ 原始碼／help 確認 | 確認現有介面或選項存在，不代表端到端實測通過 |
| 📖 文件確認 | 官方文件有此能力，本機安裝與行為仍須驗證 |
| ⚠️ 待實測 | 尚未驗證的實作前提 |
| 🔶 設計決策 | 本計畫採用的選擇與代價 |

## 0. 需求與交付界線

終端區新增 **Cowork** 分頁。使用者給一則 prompt，選定主席與參與 agent，先形成可審閱的任務板，再由 agent 執行。介面保留聊天室式時間軸與常駐任務板；Git 保存成果，manifest 保存協調狀態。

- **P1：多 agent 規劃驗證版**。產出任務板與可手動派送的文字，尚未完成原始需求中的自動共同執行。
- **P2：可靠的循序執行**。多 agent 可輪流執行，同時只有一個任務寫入，先打通派送、回報、Git 與恢復。
- **P3：多 agent 平行執行**。各 agent 有自己的 worktree，依賴排程與整合可靠後才算滿足完整需求。

第一版支援本機、有 commit 基線的 Git repo；每個 Git common directory 同時一個活動 run。非 Git 專案可用 P1 的附檔規劃，P2/P3 暫不支援。跨機共同執行、通用 mesh 與自由多輪聊天延後。

## 1. 定位：可停用的協調模式

`implement.md` 目前寫「工作台不是協調者」，Cowork 確實擴張定位。**做成可停用模式仍需要承認這個例外，B 不能免除文件修訂。**

**ADR-01（本計畫採用）**

- **背景**：需要跨 CLI 分工，官方 CLI 仍負責模型迴圈、工具與原生審批。
- **決策**：採 B；Cowork 是選用的協調模式，負責任務板、派送、狀態與成果整合。Run 狀態以 manifest 為準，ShareProjectMem 只接收使用者選擇保存的交接報告。
- **代價**：工作台新增取消、恢復與任務身分的責任；不搬入 CLI 原生迴圈。
- **替代**：A 的全面擴張沒有目前需求；C 的手動交棒無法滿足自動共同執行。

進入 P2 前同步修訂 `implement.md` 的定位與安全邊界。本次只更新本計畫。

```text
Cowork 分頁 ── IPC ── main orchestrator ── manifest（唯一 run 狀態）
                          ├─ headless runner：規劃、定案
                          ├─ 既有 PTY：執行、原生審批、人工介入
                          ├─ cowork MCP：任務接收、結果回報
                          └─ Git：worktree、任務 checkpoint、整合分支
```

## 2. 隔離與 Git：scope 是分工，worktree 隔開工作樹

**ADR-02（取代原稿預設 scoped 平行寫入）**

- **背景**：不同 scope 仍可能共改型別、lockfile 或產物；共享 index 也可能混入其他人的 staged 內容。按 scope commit 加最後 sweep 無法保證歸屬。
- **決策**：P2 用一個專用 run worktree 循序執行；P3 用 integration worktree 加每個執行 agent 的 worktree。`scope` 用於規劃與越界檢查，**不宣稱是隔離或精確歸屬的保證**。
- **代價**：需要準備依賴、磁碟空間與整合衝突處理；P2 先用一份環境降低成本。
- **替代**：共享工作樹平行寫入暫不提供；環境負擔太重就循序執行，不降級成不可靠的平行模式。

Worktree 隔開檔案與 index，仍共用 Git refs，也沒有隔開全域設定、憑證、網路、硬體與 OS。Agent 不自行 checkout、commit、merge、reset 或啟動另一套多 agent 排程；Cowork 擁有 Git 寫入流程，偵測到外部變動便暫停核對。這個約定須搭配 CLI 權限與原生審批。

### 2.1 開始 run 的基線

1. 記錄 repo 實際路徑、Git common directory、來源 branch、完整 `baseCommit`，取得 repo 的活動 run 所有權。
2. 檢查 tracked、staged、untracked、merge/rebase 狀態與編輯器未儲存內容；預設規劃與執行都使用選定的已提交快照。
3. 原工作樹可為 dirty，但 UI 明示「以 `<baseCommit>` 規劃，未提交／未儲存內容未納入」。要納入時由使用者先處理並選新基線；不自動 stash、commit、丟棄或複製修改。
4. 另建 `cowork/<runId>` 分支與專用 worktree，原工作樹不切分支。改基線須重跑規劃，舊核准失效。
5. Integration 與 agent 分支使用不同名稱，名稱衝突就停止，不覆寫。Worktree 放本機 userData 的 run 目錄，避免專案掃描與 OneDrive 同步。

### 2.2 環境與共用資源

- 安裝依賴、啟動 server 都是明確操作。P2 一份環境；P3 按需求安裝，不替每個 agent 預先跑 server。
- Port 可用 Vite 自動換 port／明確指定 port；「只有一個 5173」不是否決 worktree 的理由。不預設 symlink 或共用含 native module 的 `node_modules`。
- 任務可宣告 `resources`，例如 `device:usb-1`、`port:5173`、`build-output:firmware`；同一資源同時只派一個任務。P3 用 main 的 Set 取得／釋放即可，P2 全任務循序。只有確認使用者／背景行程已停止占用才釋放，逾時或回報未知不直接解鎖。
- 同 scope 或共同修改介面的任務加依賴或循序處理。不同 scope 不表示沒有語義依賴；detail 必須寫清楚介面契約與驗收條件。

### 2.3 Checkpoint 與 P3 整合

- Agent 回報只代表 `reported`。停止對該 session 的自動派送後，核對 worktree、scope、產物、必要驗收及是否仍有背景寫入，再形成 checkpoint。
- Git 操作串行化；每個工作樹在 task 開始時須乾淨、HEAD 符合預期。Commit 保存完整 hash，訊息帶 run/task/attempt 身分；唯讀 task 可無 commit，不強造空 commit。
- 越界先顯示 diff，調整 scope 或由使用者接手，不自動 commit 全目錄。不確定歸屬的殘留不做無條件 sweep。
- P3 按依賴順序將核准的 task commit cherry-pick 到 integration branch。衝突保留現場並 blocked，不自動選 ours/theirs。`done` 表示已整合且必要驗收通過。
- 下游開始前，agent worktree 必須乾淨，session 位於可接受新任務的邊界，再同步到包含前置成果的 integration checkpoint。**只傳 summary 和 commit hash 不會讓工作樹擁有前置程式碼。**
- 原 task commit 與 integration commit 分別保存，cherry-pick 會改 hash。有依賴的 task 不保證可單獨 revert，回滾仍須檢查下游。

## 3. CLI 能力與規劃權限

### 3.1 覆核後的能力表

| CLI | 確認來源 | 非互動／輸出 | Schema | 權限候選與限制 |
|---|---|---|---|---|
| Codex | ✅ 本機 `codex-cli 0.160.1 exec --help` | `codex exec`；`--json` 是事件 JSONL；`-o` 保存最後訊息 | `--output-schema <FILE>` | `--sandbox read-only`；外部 MCP/hooks 仍須排除，不能只靠此 flag |
| Antigravity | ✅ 本機 `agy 1.2.14 --help` | `agy -p`；`--output-format json`／`stream-json` | `--json-schema` 字串或檔案 | `--mode plan`、`--sandbox` 存在；唯讀與 MCP/hooks 行為 ⚠️ 待實測 |
| Claude Code | 📖 [CLI reference](https://code.claude.com/docs/en/cli-reference)、[programmatic usage](https://code.claude.com/docs/en/headless)；本機 PATH 未找到 | `claude -p --output-format json`，含 metadata | `--json-schema`，payload 在 `structured_output` | 工具及 MCP 限制可配置；`plan` 模式本身不是 OS sandbox，⚠️ 本機待實測 |

**修正原稿**：不是只有 agy 有 schema；Codex 上述輸出也不是用 `--output-format`。三家的 envelope 與最終 payload 分開處理。Help／文件確認不等於登入、schema、唯讀及 Windows 啟動已驗收。

Enabled 只是使用者選擇，不代表 CLI 已安裝、已登入或符合 Cowork 需求。開始前檢查可信路徑、版本與所需能力；不合格顯示原因，不偷偷替換。第一版可先支援驗證通過的兩家，不等待三家同時完工。

能力分成「可規劃」與「可自動執行」；MCP 或續派尚未通過不阻擋 P1，但不能讓該 CLI 進 P2/P3 自動執行。

### 3.2 規劃權限

**ADR-03（本計畫採用）**

- **背景**：headless 仍能改檔、跑命令與呼叫 MCP；執行前 approval 擋不住規劃期間的副作用。`cwd` 也不限制其他目錄存取。
- **決策**：規劃不繼承執行用 bypass、Connections 工具憑證或有副作用的 MCP/hooks。優先使用已驗證的唯讀工具／sandbox profile；無法驗證時，改由工作台附有界的程式碼快照，禁用 agent 工具與自訂執行入口。兩者都無法約束時不參與自動規劃。
- **代價**：附檔模式探索較弱，需補 context；CLI 登入與自身 cache 寫入不視為專案編輯，但須在能力探測中說明。
- **替代**：只在 prompt 寫「不要改檔」不足以保證唯讀；不直接對真實 workspace 跑預設 headless profile。

規劃使用基線 snapshot，結束後比較 HEAD、index、tracked/untracked 變更。有副作用就使規劃失效並保留 diff；**事後偵測只補充執行前權限約束**。Repo 指令及其他 agent 回答是待審資料，不得要求 runner 放寬權限。

### 3.3 Runner 與輸出驗證

- 沿用 `findAgentCli`、全域可信 CLI 路徑與 Windows 啟動處理。`pty.ts` 已有 `.exe/.cmd/.bat/.ps1` 分支，但 resolver 是私有函式；只抽必要啟動解析，不搬 PTY 參數或 bypass。
- 優先直接 `spawn` 執行檔，prompt 走 stdin，streaming stdout/stderr 加上限，避免 `execFile` 預設 buffer 限制。無 stdin 才用已驗證的原生 prompt 參數／檔案入口。
- `.cmd/.bat` 需 interpreter；不能把 prompt 拼入 `/c` 字串。沒有安全傳入方法時拒絕自動啟動，長 prompt、換行、引號與空白路徑都須驗收。
- 各家明確解析 envelope／事件並取最終結果，再驗 schema 與語義。**不抓第一個合法 JSON 區塊**，避免拿到工具參數或中途輸出。
- 拒絕重複 ID、未知 assignee／依賴、循環依賴、不合法 scope、超額 task 和未解 blocker。Path 正規化後拒絕絕對路徑、`..`、Git 內部路徑及 symlink/junction 跨出目標工作樹。
- 無效輸出最多一次有界修正呼叫，計入預算；仍失敗就顯示原因與人工處理入口。先用小型型別／欄位檢查，schema 複雜到難維護時再考慮驗證依賴。

## 4. 會議：主席開場、獨立覆核、一次定案

**ADR-04（修訂 R3/R4）**：主席先給框架，其他人彼此看不到回覆，再由主席一次處理全部異議與定案。獨立覆核仍可能被 R1 錨定；品質／成本改善是待驗證假設，不能標成已證明。每位覆核者都拿到原始 prompt、相同基線與來源／介面說明，不只讀主席摘要。

保留 UI 的 R1/R2/R3/R4 標籤，**R3 仲裁與 R4 定案合併一次呼叫**。不用 LLM 再判斷「兩項反對是否不同」；任一 objection、missing 或未回答問題都須處置，修正預設兩 agent 時單一反對可能被跳過的漏洞。

**R1 主席開場**：框架、草案 task、介面／資源依賴、scope、驗收、來源與不確定問題。

**R2 獨立覆核**：N−1 次平行，彼此不可見；可反對框架本身。

```jsonc
{
  "agree": ["t1"],
  "objections": [{ "id": "o1", "target": "t2", "reason": "...", "alternative": "..." }],
  "missing": [{ "id": "m1", "title": "...", "why": "..." }],
  "claims": ["t1"],
  "answers": { "q1": "..." }
}
```

**R3/R4 仲裁定案**：主席收到全部有界 R2 結果，每項 issue 有採用／拒絕與理由，未決列 blocker。Claims 是偏好，仍須符合能力、資源與依賴。輸出 `tasks`、`decisions`、`unresolved`；App 驗證 issue 處置完整、DAG 合法、無 blocker 才進 `awaiting-approval`。完整性檢查不能證明裁決正確。

- 正常規劃 **N+1 次呼叫**：2 agent 為 3 次，3 agent 為 4 次。
- R2 失敗不當成同意；保留成功結果，提供一次重試或明確「減少參與者後重定案」，更新 revision。
- 人工改板、改 prompt 或新增影響分工的補充增加 `planRevision`；核准綁定該 revision。舊呼叫完成不覆蓋新版。
- 人工改板也走同一組 scope、assignee、DAG、blocker 驗證；approval 不代替程式檢查。

## 5. 派送、回報、排程與恢復

### 5.1 Session 與可靠派送

P2 同時一個寫入任務，各 agent 可保留 **Cowork 專用 session**；P3 各 agent 一個 worktree/session，agent 內循序、agent 間平行。Headless 主席與執行 session 分開；後續定案從 manifest/diff 建 context，不假設沿用同一對話。

✅ `TerminalPanel.tsx` 的 `sendToSession` 等待 `ptyId` 後 bracketed paste，`handleDispatchToAgent` 找第一個同家未退出 session，**沒有接收確認**。`writePty` 成功只是寫入行程，4 秒無輸出的 `busy=false` 也不是完成訊號。

- P1 重用任務文字/UI，但明確選目標分頁、貼上並由人送出，不宣稱自動執行成功。
- P2 只新建／接回綁定 run 的 session；以驗證過的原生 initial prompt 或確認可輸入的 task 邊界派送。先保存 intent，再送一次；`cowork.task()` 確認當前 attempt 才轉 `running`。
- 後續 task 也須確認可接收新 prompt；沒有可靠續派能力的 CLI 可在邊界重啟 session，安全優先於 context 重用。
- 無 ACK 就 blocked，原因 `delivery-unknown`，保留 attempt；**不自動重送、另開 agent 或退回 pending**。核對終端後可接回；確定舊行程停止、殘留處理完才建立新 attempt。
- 待審批不注入 prompt 或自動 Enter；`@agent` 補充排隊，由使用者在終端確認接收，不能被誤當批准命令。

### 5.2 MCP 回報與身分

第一版三個動作足夠，`ask` 延後：

```text
cowork.task()                                       接收／確認當前 task 與 attempt
cowork.done(taskId, attemptId, planRevision, summary) 回報成果，尚未等於 done
cowork.blocked(taskId, attemptId, planRevision, reason, kind)
```

- 連線綁 repo/run/agent/session，憑證由 main 啟動時注入，模型不能自行宣稱 assignee；payload 再核對 task、attempt、revision 與狀態。
- Revision 比對該 task 派送時綁定的版本，不只比全 run 最新版本；未受改板影響的 running task 可回報原版本，受影響的舊 attempt 停止後才失效。每個 attempt 的結果留在 manifest 歷史事件，重試不覆寫舊成果。
- 同 attempt 的重複 `done` 回傳既有結果；不同 payload、舊 attempt、別人的 task 均拒絕，不能結束後來的任務。
- stdio adapter 經限本機、帶 session 憑證的通道回 main，不開公開 broker／通用 mesh；憑證不存 manifest、prompt 或版控設定。
- ✅ `ext/adapters.ts` 目前 MCP 輸出為 Claude 專案 `.mcp.json` 與 Antigravity 全域設定，**沒有 Codex MCP 設定輸出**。`AGENT_PATHS` 有 Codex 不代表註冊已完成。
- 各家須驗證 session 專屬配置／啟動入口，不為每次 run 改全域 MCP 設定；只有全域配置且無法隔開 run 的 CLI 先保留人工派送。

### 5.3 完成、失敗與復會

```text
pending → dispatching → running → reported → done
                  ↘ blocked ←──────┘
活動狀態 → failed／cancelled（保留成果，不等於可自動重派）
```

- 依賴全 `done`、資源可取得、agent 閒置才 runnable；P2 也檢查 DAG/scope，基本安全不延到 P3。
- `done` 須滿足預定驗收；要求測試、build、review 時保存實際結果。Agent 自述、無輸出、Git 有修改或 exit 0 都不能單獨證明完成；要求寫檔卻無 diff 須說明。
- 失敗 task 的下游 blocked，獨立 task 可繼續。退出／逾時／斷線不重設 pending，保留修改與錯誤，先核對再接回／重派。
- 局部卡住由使用者回覆；計畫失效由主席產出 board patch，驗證、增加 revision 並重新核准。受影響 running task 先停在安全邊界，不能在執行中改其 scope/assignee。
- 已完成歷史不改寫，修正新增 task/依賴。未來 `ask` 先做行內問題與有界回覆，不向忙碌 PTY 注入別人指令。

### 5.4 暫停、取消、崩潰恢復

- **暫停**停止新派送，running task 可走到邊界；UI 明示仍在執行。立即停止用中止，不承諾瞬間沒有副作用。
- **中止／取消**先保存 intent、撤銷回報憑證，再終止受管理行程與子行程；保留 worktree、commit、未提交 diff。確認停止才可重派。現有 Windows `hardKill` 可參考，headless／其他平台另實測。
- App／擁有者視窗關閉、workspace 切換都走生命週期；非同步操作固定用 run root，不回退到聚焦視窗 workspace。
- 重啟將非終態 run 置 `paused`，核對 manifest、Git 與存活行程；不假設舊 ptyId/PID 有效，不只依 PID 殺程序，避免 PID 重用。
- 派送／checkpoint 前先落盤 intent。Commit 已完成但 manifest 未更新時，以 run/task/attempt 標記與預期 parent/tree 找候選；不唯一便人工核對，不再 commit。
- 不承諾所有副作用 exactly-once；結果不確定就停止自動前進，不建立完整交易引擎。

## 6. 收斂與介面

### 6.1 收斂

1. 確認無活動寫入者，所有 task 有終態，未提交／越界成果列出，未知殘留交人處理，不自動 sweep。
2. 對 integration branch 核對原 prompt 與驗收。額外 agent review 可選，指定 build／測試／整體驗收仍須完成。
3. 產出 report：基線、revision、異議裁決、task/attempt、原始與整合 commit、驗收結果、未解問題、實際／估算 usage。
4. `done` 不代表已 merge；failed/cancelled 的部分成果仍可審閱。Merge/squash 前重查目標 branch 與 dirty 狀態，改變就重新核對，不自動 merge/reset。

Report 預設本機 run 的 `report.md`。使用者選匯出／寫入既有 `handoff.md` 才修改 repo；無 `.project-memory/` 就提供匯出，不 scaffold。Review 發現問題可新增明確修正 task 或保留 report，不無限延長 run。

### 6.2 分頁、時間軸與輸入

串主欄加常駐／可收合任務板；Cowork 與執行 session 為終端區兄弟分頁。重用 `AgentMark`、attach、diff 與 modal；**Cowork 分頁型別與狀態仍須實作，不能叫零新版面**。

| 階段 | 控制 |
|---|---|
| meeting | 補充進下一 revision，已送出的舊呼叫不即時收到 |
| awaiting-approval | 編輯／回饋，驗證通過才核准當前 revision |
| executing | `@agent` 只路由本 run session，忙碌／待審批先排隊；純文字為註記 |
| paused／blocked | 原因、終端、殘留 diff、接回／中止／修板入口 |
| converging／done | report/diff、匯出、merge/squash、清理 |

串顯示 R2 卡片、裁決、task 狀態與未知／逾時事件，明示「有異議待定案」「已回報，等待驗收／整合」。終端不鏡像到串；卡住可展開最後 10 行，標成診斷快照。

板上顯示 pause/stop、revision、核准與預算餘額。錯誤／待審批有文字標籤、鍵盤操作與焦點回復，不只靠顏色。

## 7. 本機資料與持久化

**ADR-05（改儲存位置，保留 JSON）**

- **背景**：幾十個 task 用 JSON 足夠；repo 可能在 OneDrive，同步 runtime/worktree 會產生跨機衝突與失效路徑。
- **決策**：放 `userData/cowork/<repoId>/<runId>/`，repoId 依本機正規化 Git common directory。Main 唯一寫入，per-repo 活動 run Map 約束多視窗。現有 dev/packaged 的 userData 不同，single-instance lock 不能保證互斥；P2 另以兩者共用的本機 appData 目錄、原子 `mkdir` 取得 repo lock，失敗就不啟動第二個執行 run。
- **代價**：狀態不自動跨機，report 可匯出；外部 CLI／其他機器不受 lock 約束，操作邊界仍須核對。
- **替代**：不加資料庫、多機租約。原 `.workbench/cowork/` 改成可選匯出位置；若匯出 runtime 須忽略版控。

```jsonc
{
  "schemaVersion": 1, "id": "r7f3a", "revision": 12,
  "planRevision": 2, "approvedPlanRevision": 2,
  "prompt": "使用者原始需求", "createdAt": 1791400000000,
  "repo": { "root": "...", "commonDir": "...", "sourceBranch": "master", "baseCommit": "<full hash>" },
  "chair": "codex", "participants": ["codex", "antigravity"],
  "executionMode": "sequential",  // P3 可 parallel；皆為專用 worktree
  "branch": "cowork/r7f3a",
  "phase": "executing", // meeting|awaiting-approval|executing|paused|converging|done|failed|cancelled
  "decisions": [], "unresolved": [],
  "budget": { "planningCallsUsed": 3, "planningMsUsed": 42000, "executionMsUsed": 0 },
  "tasks": [{
    "id": "t1", "title": "...", "detail": "...",
    "scope": ["src/main/example.ts"], "resources": [],
    "dependsOn": [], "assignee": "codex", "acceptance": ["..."],
    "status": "running", // pending|dispatching|running|reported|blocked|done|failed|cancelled
    "attemptId": "a1", "planRevision": 2,
    "worktree": "...", "expectedHead": "<full hash>",
    "sessionId": null, "ptyId": null, // CLI/session 與 runtime PTY 分開
    "dispatch": { "id": "d1", "state": "acknowledged" },
    "commit": null, "integrationCommit": null,
    "summary": null, "checks": [], "outOfScopeFiles": [], "error": null
  }],
  "log": [] // 有序事件與 intent，不再從 log 建另一套 run 狀態
}
```

```text
userData/cowork/<repoId>/<runId>/
  run.json          run.prev.json
  meeting/          report.md
  worktrees/integration/    # P2 同時是執行工作樹
  worktrees/<agent>/        # P3 才需要
```

- 寫入序列化：同目錄暫存檔、flush/fsync、保留上一份有效 manifest、rename 替換。主檔／備份驗 schema/version；Windows 占用有界重試，失敗停止新派送。原子替換防半截檔，不承諾斷電絕不丟最後更新。
- Repo lock 保存 owner 隨機 ID／PID／啟動時間，正常結束只釋放自己的 lock。崩潰留下的 lock 先核對行程與 run 再人工接管，不單靠 PID 或檔案年齡自動刪除；這是本機鎖，不是跨機租約。
- 恢復仍核對 Git/行程；fallback 少了事件不能重做副作用。未知 schemaVersion 只讀／匯出，不默默轉換續跑。
- `meeting/` 按 revision/attempt 留有界模型結果與診斷，不覆寫舊輪次。不保存完整 env、Connections 憑證或 session token；CLI 輸出也可能敏感，匯出須預覽。
- MCP 不直接寫 manifest，一律經 main 驗證。清理先檢查行程、dirty worktree 與未保存成果；解析後刪除路徑必須在該 run 目錄，不能遞迴刪 repo／外部指向。

## 8. Settings 與成本界線

不以無定義的「最強」排名選主席：

```ts
type CoworkSettings = {
  chair: AgentId | null,            // 初次明確選擇，之後記住
  participants: AgentId[],          // 預設 2 位合格 enabled agent，包含主席
  chairExecutes: boolean,           // 預設 true，規劃與執行 context 分開
  limits: {
    maxPlanningCalls: number,       // 預設 6，規劃、修正、改板、復會合計
    maxPlanningMinutes: number,     // 預設 10
    maxExecutionMinutes: number     // 預設 60
  }
}
```

- 主席須在 participants；只允許三家 agent，不含 shell。預設主席加一位覆核者，不足兩位合格 agent 就顯示缺失。
- 移除 `auto`/`all-enabled`，開始前可改名單。主席不執行時至少有另一位執行者，不產生無人可執行 task。
- 初次執行及影響 scope/assignee/依賴的改板須核准，第一版不提供關閉 approval。Cowork 不自動回覆 CLI 原生審批。
- 權限、trusted path、繞過審批與提高預算只認本機全域偏好／明確操作；repo settings 或模型不能放寬，沿用 `settings.ts` 信任區分。
- 首版預設 call 180 秒、stdout/stderr 各 1 MiB、task 上限 20、輸出修正一次、復會兩次，實測後可調。**啟動前記帳，失敗也算；總 calls 上限優先於重試額度。**
- 預算涵蓋全 run，revision/復會/重啟不歸零；達上限停止新呼叫。時間到中止受管理行程並保留結果，加額度才續跑，已花成本不能撤回。
- 時間按該階段有活動行程的 wall time 累計，平行呼叫不重複加同一段時間；人工改板／完全 paused 不計時。CLI 等原生審批仍算執行時間，UI 明示剩餘額度。記帳與限制快照存 manifest；續跑不套用新預設偷偷放寬。
- ✅ Dashboard 部分 token 是估算，Antigravity CLI 也可能沒有 token 資料。優先採可關聯 call/session 的原生 usage，其餘標估算／未知，不把未知當 0 或拿 Dashboard 總數冒充 run 費用。
- 呼叫／時間是 app 可約束的界線，**不是精確金額或 token 封頂**。有原生 turn/budget 限制才經探測採用；PTY 無可驗證上限時明示，不承諾固定花費。

## 9. 已收斂決策與待驗證前提

| 項目 | 處置／尚待確認 |
|---|---|
| A/B/C 定位 | 採 B，進 P2 前修 `implement.md` 協調例外 |
| 結構化輸出 | 三家 schema 有 help／文件依據；envelope、唯讀、Windows 做 P0 探測 |
| R2 彼此不可見 | 保留；仍須防主席錨定，能推翻框架、核對來源 |
| scoped 平行 | 不採用；P2 一個 run worktree 循序，P3 各 agent worktree |
| report 落點 | 本機 run/report.md，可匯出／寫既有 handoff |
| 不回報 done | 不推算機率；實測 MCP 前提，缺回報保持未知／blocked，不猜完成 |
| P1 成功標準 | 兩位合格 agent 對同基線開場／覆核／定案；無副作用、板合法、異議有處置、可改板／手動派送 |
| 自動執行前提 | session MCP、接收確認、邊界續派／重啟、中止與結果驗證通過；未通過只支援手動 |

## 10. 落地順序與驗收

| 階段 | 最小實作 | 完成條件 |
|---|---|---|
| **P0 能力探測** | 先挑兩家，探測路徑／版本、JSON/schema、唯讀、登入錯誤、session MCP、安全 prompt | 一次性測試 repo 證明規劃無副作用／可解析；高風險前提未過不進自動執行 |
| **P1 規劃驗證版** | runner、原子 manifest、revision、R1/R2/合併 R3-R4、串／板、limits、改板／手動貼上 | §9 P1 標準；解析／單家失敗、預算到期、取消不假裝完成；仍非完整 Cowork |
| **P2 循序閉環** | 一個 worktree、專用 PTY、三個 MCP 動作、ACK、基本 DAG、驗收／checkpoint、暫停／中止／恢復／report | 未知不重送、舊回報不結束新 task、dirty 原工作樹不進成果、崩潰可核對續跑 |
| **P3 平行共同執行** | 每 agent worktree、ready queue/resources、integration cherry-pick、依賴同步、越界／衝突處理、有界復會 | 兩位實際平行寫入不互覆，下游讀到整合成果，衝突／硬體競爭可停止恢復 |
| **P4 按需求追加** | ask、完整重指派 UI、run 匯出／重播 | 有需求才加；重播先檢視事件，不重執行副作用 |

實作時用隔離 repo／假 CLI 留下最小可執行檢查，少量真 CLI 確認權限與 MCP，不大量花模型額度。優先覆蓋：

- 假 JSON／事件、無效 DAG／越界 path、單一 reviewer objection，不能繞過定案核准。
- UTF-8 長 prompt、引號／換行／特殊字元／空白路徑，不變成 shell 指令。
- 無 ACK、重複 done、舊 attempt/revision、別 run 回報不能推進錯誤 task。
- 保存／送 prompt／commit 前後中止／崩潰，恢復不盲重送、不丟 diff、不重做 commit。
- Dirty 基線、外部 HEAD 改動、整合衝突／前置失敗時，下游不錯誤開始。

## 11. 主要風險與處置

| 風險 | 處置 |
|---|---|
| 規劃改檔／呼叫硬體 | 驗證唯讀、排除副作用 MCP/hooks／工具憑證；不合格附檔或不參與 |
| 合法 JSON 但計畫錯 | 語義驗證、異議處置、人工核准、驗收；schema 不保證品質 |
| 檔案／介面／資源衝突 | scope 預警、DAG/契約、P2 循序、P3 worktree/resources |
| 重複 prompt／誤送審批 | intent/attempt/ACK、專用 session、未知不重送、待審批不注入 |
| 完成誤報／無回報／退出 | reported 與 done 分開，驗收整合後完成；輸出/Git 只供診斷 |
| App／process 掛掉 | paused 核對、保留成果、原子 manifest/備份、commit 身分 |
| 外部變動／全域設定衝突 | per-repo run、固定 root、Git 邊界檢查、session 配置；跨機不支援 |
| 成本／會議失控 | 全 run calls/時間、有界修正復會、未知 usage 明示 |
| 清理丟成果 | 先停行程，驗 dirty／未保存成果與實際路徑，由使用者處置 |

## 附錄 A：外部參考

原稿參考 [herdr](https://github.com/herdrdev/herdr) 的終端狀態與派送設計。本次未重查其程式碼／授權細節，不新增依賴或複製實作。

- 通用 mesh 與完整終端規則引擎仍不採用；明確 run/task 回報介面即可。
- **逾時不代表沒送到，不可盲重送**同樣適用 Cowork PTY。Headless 規劃繞開畫面解析，沒有解決互動執行的接收問題。
- 未來採外部程式碼時先查實際 LICENSE/NOTICE 與適用檔案，保留要求的標頭、來源與 notices；不依賴未覆核的授權推論。
