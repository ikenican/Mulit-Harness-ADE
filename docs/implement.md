# 跨工具共享記憶 — 實作方案（implement.md · 自動化版）

> **v1.1.0 起的存放方式（取代本文所有「記憶 commit 進專案 repo／post-merge／MEM_AUTOPUSH」的描述）**：記憶絕不進專案 repo，只在 clone 本機（`.git/info/exclude`），跨電腦共用交給 Agent Workbench：設定 → 記憶同步（私人 GitHub repo，或 OneDrive／Google Drive 指定資料夾）；`post-merge` 已移除；handoff 改為 State／Verified／Not verified／Next／Risks / do not 五段、最多 8000 bytes。現行規則以 `templates/memory/PROTOCOL.md` 與 README「Storage」一節為準，本文其餘內容保留為設計歷程。

> 目標：讓 **Claude Code / Antigravity / Codex** 在換電腦、換 agent、跨工作階段時，用同一份 Git 版控的專案記憶；**開局自動讀、收工強制更新**，不靠人工貼開場白、不靠 agent 自覺。
> 原則：**最小骨架、單一事實來源、分層讀取、明確更新門檻、用 hook 自動化與防呆。**

---

## 0. TL;DR（第一階段就部署）

1. `.project-memory/`：`INDEX.md`、`handoff.md`、`STATE.md`、`DECISIONS.md`、`PROTOCOL.md`。
2. 三個 agent 入口檔：`CLAUDE.md`、`AGENTS.md`、`.agents/rules/shared-memory.md`（含最小必要規則，不只一行指向）。
3. **自動化層（重點）**：
   - `.claude/settings.json` → **SessionStart hook**：Claude Code 每次開局**自動注入** INDEX + handoff（tier 1），並報告是否落後遠端。
   - `.githooks/pre-commit` → **強制**「改了工程檔卻沒更新記憶 → 擋」「新增 secret → 擋」（跨工具，任何 agent commit 都生效）。
   - `.gitattributes` → 強制 hook 為 LF，避免 Windows 換行搞掛。
   - `scripts/bootstrap.ps1` → 新電腦 clone 後**一鍵**啟用 hook。
4. 依序切換 agent **不需要** worktree；只有兩個以上 agent **同時改碼**才用（附錄 A）。

---

## 0.5 目前狀態（更新於 2026-09-07）

**階段：設計定案 + 已實作成 plugin，機制層實測通過；尚未在真實專案長期驗證。**

| 項目 | 狀態 |
|---|---|
| 設計與協定 | ✅ 定案（本文件） |
| Plugin 實作 | ✅ 完成 → [`shared-project-memory/`](shared-project-memory/) |
| 機制層測試 — Windows / Git Bash | ✅ 全數通過（見 §11） |
| 機制層測試 — Linux / Docker（Alpine + busybox） | ✅ 全數通過，含雙容器跨機閉環 |
| Codex / Antigravity **真機服從性**驗證 | ❌ **未做**，且 Docker 測不了（見 §12 第 1 項） |
| 真實專案長期試跑（1–2 週） | ❌ 未做 |
| 發佈到 marketplace | ❌ 未做 |

實作產物一覽：

```
shared-project-memory/          # Claude Code plugin，同時是三工具的安裝器
├── hooks/hooks.json            # SessionStart → 自動注入
├── commands/{memory-init,handoff}.md
├── install.sh / install.ps1    # 非 Claude Code 的安裝入口
└── templates/
    ├── status.sh               # 開局印出 tier-1（含 ff-only 同步守衛）
    ├── sync-entry-files.sh     # 把 handoff 生成進 Codex/Antigravity 的 entry 檔
    ├── commit-handoff.sh       # agent 自己提交記憶（可選 push）
    ├── pre-commit / post-merge # 強制層 + 自動再生
    └── memory/*.md             # INDEX / handoff / STATE / DECISIONS / PROTOCOL
```

---

## 1. 核心設計

**唯一事實來源**：`.project-memory/`（進 Git）。各 agent 的 Auto Memory / 私有 session 記憶可保留，但**不當跨工具、跨電腦的唯一事實來源**。

**衝突時的優先級**（記憶會過時，照這個排）：
1. 原始碼與實際測試／驗證結果 ← 最高
2. Git commit / issue / 正式規格 / 已核准文件
3. `.project-memory/` 最新內容
4. Agent 對話中的推測 ← 最弱

**檔案職責 + 單一寫入位置（消除雙重維護）**：

| 檔案 | 用途 | 啟動讀取 | 可變資訊唯一寫入處 |
|---|---|:--:|---|
| `INDEX.md` | 純索引、讀取規則、檔案定位 | 是（tier 1） | **無**——不放狀態、commit、日期 |
| `handoff.md` | 最新任務、下一步、測試、地雷 | 是（tier 1） | 最新交接狀態（含 commit） |
| `STATE.md` | 里程碑、跨模組宏觀進度、長線待辦 | 按需（tier 2） | 專案宏觀狀態 |
| `DECISIONS.md` | 追加式架構／技術決策 | 按需（tier 2） | 決策歷史 |
| `PROTOCOL.md` | 完整協定與例外處理 | 首次／按需 | 規則本身 |

> **INDEX 不寫 commit、日期或狀態列**——那些只寫在 `handoff.md`，避免兩處同步不一致。INDEX 幾乎不變（純路由），才是最小、可長期快取的 tier 1。
> 省 token 靠**分層不 eager load**（tier 2 該讀才讀），**不是砍內容**；完整保真度永遠留在磁碟 + Git。未驗證標 `Unverified`，會變動的資訊加日期。

---

## 2. 目錄結構

```text
your-project/
├── .gitattributes                  # 強制 hook 為 LF
├── .claude/
│   └── settings.json               # Claude Code SessionStart hook（自動注入記憶）
├── CLAUDE.md                       # Claude Code entry
├── AGENTS.md                       # Codex / 泛用 agent entry
├── .agents/
│   └── rules/
│       └── shared-memory.md        # Antigravity entry
├── .project-memory/
│   ├── INDEX.md                    # 純索引（tier 1，每次讀）
│   ├── handoff.md                  # 交接棒（tier 1，每次讀）
│   ├── STATE.md                    # 宏觀狀態（tier 2，按需）
│   ├── DECISIONS.md                # 追加式決策，頂部索引表（tier 2，按需）
│   ├── PROTOCOL.md                 # 唯一協定（首次/按需）
│   └── archive/                    # 舊 handoff 封存（不進啟動讀取）
├── .githooks/
│   ├── pre-commit                  # 強制記憶更新 + secret 掃描
│   └── session-start.sh            # 被 SessionStart hook 呼叫，注入 tier 1 記憶
├── scripts/
│   └── bootstrap.ps1               # 新電腦一鍵啟用 hook
└── ... (src/ tests/ firmware/ drivers/ docs/ scripts/)
```

**何時才拆檔**（提早拆 = 白花 context 又難維護）：

| 真實訊號 | 再增加 |
|---|---|
| `STATE.md` 混雜長線待辦與約束 | `NEXT_TASKS.md` / `CONSTRAINTS.md` |
| 技術債／未解 bug 太多 | `KNOWN_ISSUES.md`（tier 2） |
| 常需回溯歷史任務 | `SESSION_LOG.md`（**不進啟動讀取**） |
| 並行 agent 成日常 | worktree 建立與整合自動化（附錄 A） |
| Markdown 已無法有效檢索 | 再評估資料庫 / MCP / 向量檢索 |

---

## 3. `.project-memory/PROTOCOL.md`（唯一協定）

```markdown
# Shared Project Memory Protocol

Canonical shared memory lives in `.project-memory/`.

## Concurrency
- One agent at a time: use the normal working directory.
- Multiple agents editing concurrently: use separate Git worktrees.
- Never let two agents write to the same working tree concurrently.
- Worktree branches don't see each other's unmerged memory; the integrator owns the final canonical handoff/state.

## Startup (tiered — full fidelity stays on disk, load only what the task needs)
1. Inspect local state: `git status --short`, `git branch --show-current`, `git log -5 --oneline`.
2. Read TIER 1 (always): `.project-memory/INDEX.md` and `.project-memory/handoff.md`.
   (In Claude Code these are auto-injected by the SessionStart hook — confirm you have them.)
3. Read `PROTOCOL.md` (this file) when: first time in this repo; the task touches Git/branch/merge/
   worktree/memory files; or rules seem unclear.
4. Read TIER 2 only when relevant:
   - `STATE.md`: milestones, multi-module work, planning/release, or handoff older than 7 days,
     or Git state differs materially from the handoff commit.
   - `DECISIONS.md`: architecture/design changes — read the top index table first, then only the matching DEC.
   - `KNOWN_ISSUES.md` / `SESSION_LOG.md` / `archive/`: only if directly relevant.
5. Summarise current state in <=3 bullets (from INDEX + handoff) before substantial action.
   Do NOT re-explore what is already recorded and still valid.

## Git safety
- `git fetch` is read-only and always allowed. Everything that MUTATES the tree is restricted.
- Committing the SHARED MEMORY is allowed and expected - it is local and reversible
  (`git reset --soft HEAD~1`). Use `bash .project-memory/commit-handoff.sh "<msg>"`, which is
  pathspec-limited to memory files and never sweeps up the user's source changes.
  Committing the user's SOURCE CODE is their decision, not yours.
- Pushing happens only when `MEM_AUTOPUSH=1`. Until pushed, other machines cannot see the handoff -
  say so explicitly when you finish.
- Do NOT automatically run `git pull --rebase`, `merge`, `reset`, or force-push. Ever.
- The ONLY permitted automatic sync is `git pull --ff-only`, and only when ALL hold:
  auto-sync is enabled, the working tree is clean, and the local branch has no divergent commits.
  A non-fast-forward aborts and changes nothing — then REPORT and ask the user.
- If uncommitted changes exist, inspect them; never overwrite blindly.

## Working
- Source code and tests override stale memory. If memory conflicts with code, flag it and fix memory once verified.
- Prefer small, reversible changes. Don't overwrite another agent's uncommitted work.
- Never store credentials, passwords, API keys, tokens, certificates, or private keys.

## When memory updates are REQUIRED (update thresholds — avoids churn)
Update `handoff.md` if ANY is true:
- Source/tests/config/scripts/meaningful docs changed.
- Work is incomplete and another agent could continue it.
- Test results, environment assumptions, dependencies, or known risks changed.
- The user made a decision affecting future work.

Update `STATE.md` ONLY when a milestone, macro status, major blocker, or cross-module plan changed.
Append to `DECISIONS.md` ONLY for a durable architectural/technical decision (never rewrite old ones; supersede).

Do NOT update memory for: read-only questions, trivial explanations, no-change reviews, or failed
exploration with no reusable result.

## Completion (when an update is required)
1. Update `handoff.md`.
2. Update `STATE.md` only if its criteria apply.
3. Append a decision only if its criteria apply.
4. Run relevant tests/validation.
5. Report `git diff --stat`, results, and remaining risk.
6. Commit the memory yourself: `bash .project-memory/commit-handoff.sh "<one-line summary>"`.
   This is what makes the handoff reach the other agents and the other machines - a handoff that
   is never committed does not exist for anyone else. Report whether it was pushed.

## Size policy
- `INDEX.md` tiny (index + rules only). `handoff.md` / `STATE.md` preferably <=50 lines.
- Fidelity over brevity: shorten by moving detail to an on-demand file or `archive/`, NEVER by deleting facts.
```

---

## 4. 檔案範本

### 4.1 `INDEX.md`（tier 1 純索引，無狀態列，~100 tokens）

```markdown
# Project Memory Index

## Read at every session start (tier 1)
1. Read this file.
2. Read `handoff.md`.

## Read on demand (tier 2 — full detail lives here)
- `STATE.md`      — milestones, cross-module progress, blockers, planning.
- `DECISIONS.md`  — durable architecture/technical decisions (check quick index first).
- `KNOWN_ISSUES.md` / `SESSION_LOG.md` / `archive/` — history & known issues, if created.

## Rules
- `.project-memory/` is canonical cross-agent memory.
- Source code and tests override stale memory.
- Never store secrets. Mark uncertain content `Unverified`; date changing facts.
```

> INDEX 只做路由,不放 commit/日期/狀態——所有可變狀態只在 `handoff.md`(單一寫入處)。

### 4.2 `handoff.md`（tier 1，每次讀 + 符合門檻時覆寫）

```markdown
# Latest Handoff
- Updated: 2026-09-07 20:00 CST
- Agent: Claude Code
- Task: <本次任務>
- Branch: <branch>
- Commit: <commit hash 或 Uncommitted>

## Done
- <已完成>

## Not done
- <未完成>

## Next agent should
1. <第一個可直接執行的步驟>
2. <第二步>

## Tests
- `<測試命令>` → <結果>

## Warnings (do-not-touch)
- <不可任意變動的 API／介面／檔案／硬體相容性限制>
```

### 4.3 `STATE.md`（tier 2 宏觀儀表板，<=50 行）

```markdown
# Project State
- Milestone: <目前里程碑>
- Status: In progress
- Last updated: 2026-09-07

## Macro Progress
- [x] <已完成里程碑>
- [ ] <進行中里程碑>
- [ ] <尚未開始里程碑>

## Long-term Tasks
- P0: <必做>
- P1: <其次>

## Blocked / Needs Human Input
- <需要使用者決策的問題>
```

### 4.4 `DECISIONS.md`（tier 2 追加式，頂部索引表）

```markdown
# Architecture Decisions

## Quick Index
| ID | Title | Date | Status | Supersedes |
|---|---|---|---|---|
| DEC-001 | Shared memory is versioned in Git | 2026-09-07 | Accepted | - |

---

## DEC-001: Shared memory is versioned in Git
- Date: 2026-09-07
- Status: Accepted
- Decision: canonical memory in `.project-memory/`, synced via Git.
- Reason: Claude Code / Antigravity / Codex read the same repo files.
- Consequence: memory changes reviewed & committed with engineering work.
```

新決策取代舊的 → 頂部表格追加一列註明 `Supersedes: DEC-001`，下方追加新章節，不刪舊條。

### 4.5 封存 handoff（可選）

```bash
mkdir -p .project-memory/archive
cp .project-memory/handoff.md ".project-memory/archive/handoff-$(date +%Y-%m-%d-%H%M).md"
```

只讀最新 `handoff.md`；archive 永不在一般 session 啟動時載入。

---

## 5. 三個 agent 的入口檔（含最小必要規則）

> 入口檔**不要只寫「請讀 PROTOCOL.md」**——agent 未必會自動追蹤引用檔。把最小啟動規則直接寫進來確保觸發，完整細節仍單一來源在 `PROTOCOL.md`。
> 代價：改動啟動流程時要同步這三個檔（可靠性換 DRY，值得）。

`CLAUDE.md`
```markdown
# Project Instructions
Canonical cross-agent memory is `.project-memory/`.

Before substantial work in every session:
1. Read `.project-memory/INDEX.md` and `.project-memory/handoff.md`.
2. Inspect `git status --short` and `git branch --show-current`.
3. Summarise current context in <=3 bullets.
4. Read `.project-memory/PROTOCOL.md` for first-time setup, Git/worktree/merge, memory changes, or unclear rules.
5. Read `STATE.md` / `DECISIONS.md` only when the task needs macro status or architecture history.

Before finishing, follow PROTOCOL.md's memory-update criteria.
Do NOT auto pull/rebase/merge/reset/push without user authorization.
```

`AGENTS.md`
```markdown
# Agent Instructions
Canonical cross-agent memory is `.project-memory/`.

Before substantial work in every session:
1. Read `.project-memory/INDEX.md` and `.project-memory/handoff.md`.
2. Inspect `git status --short` and `git branch --show-current`.
3. Summarise current context in <=3 bullets.
4. Read `.project-memory/PROTOCOL.md` for first-time setup, Git/worktree/merge, memory changes, or unclear rules.
5. Read `STATE.md` / `DECISIONS.md` only when relevant.

Before finishing, apply PROTOCOL.md's memory-update criteria.
Never auto pull/rebase/merge/reset/push without user authorization.
```

`.agents/rules/shared-memory.md`（Antigravity Workspace Rule）
```markdown
# Shared Project Memory
This workspace uses `.project-memory/` as canonical cross-agent memory.

Before substantial work, read `.project-memory/INDEX.md` and `handoff.md`, inspect Git status/branch,
and summarise context in <=3 bullets. Read `PROTOCOL.md` for first-time setup, Git/worktree work,
memory changes, or uncertainty. Read `STATE.md` / `DECISIONS.md` only on demand.

Before finishing, use PROTOCOL.md's update criteria.
Do not auto pull/rebase/merge/reset/push without user authorization.
```

---

## 6. 自動化層（本方案核心）

### 6.1 Claude Code SessionStart hook — 開局自動注入記憶

`.claude/settings.json`（committed，隨 repo 走；Claude Code 首次會要你信任專案 hook，同意一次即可）：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear",
        "hooks": [
          { "type": "command", "command": "bash .githooks/session-start.sh" }
        ]
      }
    ]
  }
}
```

`.githooks/session-start.sh`（以 LF 儲存）——SessionStart hook 的 stdout 會被注入 context：

```bash
#!/usr/bin/env bash
# Claude Code 開局：先確認遠端（可選安全同步），再把 tier 1 記憶注入 context。
# 順序很重要——若真的同步了，注入的必須是同步「後」的新記憶。
MEM=".project-memory"
[ -f "$MEM/handoff.md" ] || exit 0   # 非記憶型 repo → 不做事

# 安全自動同步開關：0=只報告不動手（預設）、1=允許 fast-forward 同步
AUTOSYNC="${MEM_AUTOSYNC:-0}"

SYNC_NOTE=""
# fetch 是唯讀的，永遠安全、永遠自動；pull 會改工作樹，受開關與守衛控制。
if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
  git fetch --quiet 2>/dev/null || true
  behind=$(git rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)
  ahead=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
  dirty=$(git status --porcelain)

  if [ "${behind:-0}" -gt 0 ]; then
    # 三重守衛：開關開啟 + 工作樹乾淨 + 本地無分岔(ahead=0) → 才允許 ff-only
    if [ "$AUTOSYNC" = "1" ] && [ -z "$dirty" ] && [ "${ahead:-0}" -eq 0 ]; then
      if git pull --ff-only --quiet 2>/dev/null; then
        SYNC_NOTE="> ✅ Auto-synced: fast-forwarded $behind commit(s). Memory below is fresh."
      else
        SYNC_NOTE="> ⚠ Auto-sync aborted (not a fast-forward). Memory below may be stale — ask the user before merging."
      fi
    else
      SYNC_NOTE="> ⚠ Behind remote by $behind commit(s) (ahead=$ahead, uncommitted=$([ -n "$dirty" ] && echo yes || echo no)). Do NOT auto-pull; report this and ask the user."
    fi
  fi
fi

echo "# Shared project memory (auto-injected — tier 1)"
[ -n "$SYNC_NOTE" ] && { echo; echo "$SYNC_NOTE"; }
echo
echo "## INDEX.md"
cat "$MEM/INDEX.md" 2>/dev/null
echo
echo "## handoff.md"
cat "$MEM/handoff.md" 2>/dev/null
```

> 效果：Claude Code 每個新 session／resume／clear 都會**自動**帶入 INDEX + handoff——不需要你貼開場白，也不依賴模型讀 CLAUDE.md。

**開啟安全自動同步（可選）**：把腳本第 6 行改成 `AUTOSYNC="${MEM_AUTOSYNC:-1}"`，或在該機器 `export MEM_AUTOSYNC=1`。

為什麼是 `--ff-only` 而不是 `pull --rebase`：

| 動作 | 會改工作樹？ | 可能產生衝突／殘局？ | 適合自動化 |
|---|:--:|:--:|:--:|
| `git fetch` | ❌ 唯讀 | ❌ | ✅ 永遠自動 |
| `git pull --ff-only` | ✅ 但只快轉 | ❌ **不可能**（非快轉就中止，什麼都不做） | ✅ 有守衛即可 |
| `git pull --rebase` | ✅ 改寫歷史 | ✅ 會留半 rebase 殘局 | ❌ 不自動 |

三重守衛缺一不可：**開關開 + 工作樹乾淨 + 本地無分岔（ahead=0）**。任一不滿足就退回「只報告」。

### 6.2 `.githooks/pre-commit` — 跨工具強制（任何 agent commit 都生效）

以 LF 儲存：

```bash
#!/usr/bin/env bash
set -e
MEM=".project-memory"

# 1) 必要檔存在
for f in PROTOCOL.md INDEX.md STATE.md handoff.md DECISIONS.md; do
  [ -f "$MEM/$f" ] || { echo "❌ missing required memory file: $MEM/$f"; exit 1; }
done

# 2) 工程檔變更但沒 staged 記憶 → 擋（正向比對副檔名/目錄/build 檔，精準不誤傷）
ENG_CHANGED=$(git diff --cached --name-only | grep -E \
  '^(src|tests|app|firmware|drivers|scripts|tools|config|configs)/|(^|/)(CMakeLists\.txt|Makefile|package\.json|pyproject\.toml)$|\.(c|cc|cpp|h|hpp|py|ps1|sh|yaml|yml)$' \
  || true)
if [ -n "$ENG_CHANGED" ] && ! git diff --cached --name-only | grep -q "^$MEM/"; then
  echo "❌ Engineering files changed but shared memory was not staged."
  echo "   Update handoff.md per PROTOCOL update criteria, then: git add $MEM"
  echo "$ENG_CHANGED" | head -n 10
  exit 1
fi

# 3) secret 只掃「新增行」，不誤擋「移除金鑰」的提交
ADDED=$(git diff --cached -U0 -- "$MEM" | grep '^+' | grep -v '^+++' || true)
if [ -n "$ADDED" ]; then
  if echo "$ADDED" | grep -nEi '(api[_-]?key|secret|password|passwd|token)[[:space:]]*[:=][[:space:]]*[^[:space:]]{12,}'; then
    echo "❌ Possible secret (key=value) in newly added memory. Remove it."; exit 1
  fi
  if echo "$ADDED" | grep -nE 'BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY'; then
    echo "❌ Private key in newly added memory. Remove it."; exit 1
  fi
fi

# 4) whitespace
git diff --cached --check
echo "✅ shared project memory check passed."
```

> 若某專案是純軟體，把第 2 步的 `firmware|drivers` 與 `c|cc|cpp|h|hpp` 拿掉即可。

### 6.3 `.gitattributes`（Windows 必備）

hook 檔若被存成 CRLF，bash 會噴 `\r: command not found`。強制 LF：

```gitattributes
.githooks/* text eol=lf
```

### 6.4 新電腦一鍵啟用 — `scripts/bootstrap.ps1`

**關鍵**：`core.hooksPath` 是**每個 clone 的 local 設定**，commit `.githooks/` 不會自動生效——每台新電腦都要跑一次。

```powershell
$ErrorActionPreference = "Stop"
git config core.hooksPath .githooks
if (-not (Test-Path ".githooks/pre-commit")) { throw "Missing .githooks/pre-commit" }
# Git Bash 下的 hook 不需 chmod；純為顯示
Write-Host "Git hooks enabled: $(git config --get core.hooksPath)"
```

新電腦流程：
```powershell
git clone <repo>; cd <repo>
.\scripts\bootstrap.ps1
```
（macOS/Linux：`git config core.hooksPath .githooks && chmod +x .githooks/*`）

### 6.5 自動化覆蓋表（誠實版）

| 環節 | Claude Code | Codex | Antigravity | 機制 |
|---|:--:|:--:|:--:|---|
| 開局讀取記憶 | ✅ **全自動注入** | ⚠️ 靠 AGENTS.md | ⚠️ 靠 Workspace Rule | SessionStart hook / entry 檔 |
| 收工更新記憶 | ⚠️ 指令引導 | ⚠️ | ⚠️ | entry 檔（軟）— agent 執行 |
| 防「改碼漏更新」 | ✅ | ✅ | ✅ | **git pre-commit（硬，工具無關）** |
| 防 secret 進 repo | ✅ | ✅ | ✅ | git pre-commit |
| 跨機同步 | ✅ 自動 fetch + 報告；可選 ff-only 自動同步 | ✅ | ✅ | `status.sh` / `post-merge` |
| 新機安裝 | 一鍵 | 一鍵 | 一鍵 | bootstrap.ps1 |

> **三個 agent 都能開局自動載入**，但走兩條不同路徑（因為只有 Claude Code 能「自動執行指令並注入輸出」）：
> - **Claude Code**：SessionStart hook 執行 `status.sh` → 注入。
> - **Codex / Antigravity**：git hook 把 handoff **生成**進它們本來就會自動載入的 `AGENTS.md`
>   與 `.agents/rules/shared-memory.md`（`pre-commit` 改 handoff 即再生並自動 staged；
>   `post-merge` 於 pull 後刷新）。`handoff.md` 仍是唯一事實來源，該區塊是機器衍生、標 do-not-edit。
>
> **仍擋不住的**：hook 只能擋「沒寫」，擋不了「寫得爛」——內容品質是 LLM 本質限制，沒有工具能繞過。

### 6.6 Agent 自己提交 handoff（閉環關鍵）

不 commit 的 handoff 對其他 agent／其他電腦等於不存在。所以 agent 收工自己跑：

```bash
bash .project-memory/commit-handoff.sh "docs(memory): <一句摘要>"
```

權限按**可逆性**分級，不是一刀切：

| 動作 | 誰決定 | 理由 |
|---|---|---|
| commit **記憶** | ✅ agent 自動 | 本地、可逆（`git reset --soft HEAD~1`） |
| commit **原始碼** | ❌ 使用者 | 那是使用者的工作，agent 不代為決定 |
| **push** | ⚙️ `MEM_AUTOPUSH=1` 才做 | 對外動作；被拒只回報，**絕不 force** |

該 commit 是 **pathspec-limited**——只含 `.project-memory/` 與生成的 entry 區塊，
使用者已 staged 的原始碼**原封不動留在暫存區**。

**跨機建議兩個開關都開**：`MEM_AUTOSYNC=1`（開局自動 ff-only 拉）＋ `MEM_AUTOPUSH=1`（收工自動推）
→「A 機收工 → B 機開局看得到」全程零手動。

---

## 7. 每日流程（大多已自動）

**開工**：Claude Code 直接下任務即可（SessionStart 已自動注入記憶 + 報告 drift）。Codex/Antigravity 若沒自動讀，補一句：
```text
先讀 .project-memory/INDEX.md 與 handoff.md，用 3 點摘要現況再開始。
```

**同步**（agent 不自動做，你決定）：
```bash
git status --short && git branch --show-current
git pull --rebase   # 僅在工作區乾淨、你確認要同步時
```

**收工提交**（碼與記憶一起；pre-commit 會把關）：
```bash
git add src tests firmware drivers scripts .project-memory
git commit -m "feat: <做了什麼>"
git push
```

---

## 7.5 同步層選型（不用 GitHub 也能跨機）

**必要的只有本機 `git init`**；remote 只有「跨電腦」才需要，且**不限 GitHub**。

| 方案 | 適用情境 | 風險 |
|---|---|---|
| GitHub / GitLab private repo | 個人專案，最省事最穩 | 低 |
| **NAS／網路磁碟上的 bare repo** | 公司 IP 不能上雲 | 低 |
| **OneDrive／Google Drive 上的 bare repo** | 不想架 remote，只想用現有雲端硬碟 | 中（見下方守則） |
| 自架 Gitea | 想要 Web UI 又要自管 | 低 |
| ~~整個 repo 放進雲端同步資料夾~~ | — | ❌ **禁止**，見下 |

### ❌ 絕對不要：把整個 repo（含 `.git/`）放進雲端同步資料夾

`.git/` 對雲端同步不安全，失敗模式很具體：

1. **順序無保證**：`.git/index` 或 `refs/heads/*` 可能先於它指向的 object 抵達 → `fatal: bad object`。
2. **寫入中被讀取**：git 正在寫 packfile 時被同步讀取 → 上傳半截檔。
3. **衝突副本是垃圾**：`index-DESKTOP-ABC` 這種檔在 `.git/` 裡毫無意義，git 直接無視 → 靜默分歧。
4. **沒有 merge**：兩台都 commit 時雲端只讓一個版本贏，另一台的 commit **無聲消失**。
5. **Files On-Demand**：檔案是佔位符時 git 讀取會卡住或失敗。

**失敗是靜默且會丟歷史的**，而修正只要一個指令 —— 不值得賭。

### ✅ 正確做法：雲端只放 **bare repo** 當 remote

```text
D:\OneDrive\git-remotes\myproj.git    ← bare repo（雲端只同步這個）
D:\repos\myproj\                       ← 工作區 + .git（不在雲端資料夾內）
```

關鍵差別：**bare repo 只在 push/fetch 那一瞬間被寫入**（短暫、離散），不像工作區被 git 持續讀寫，
雲端有充裕時間收斂。而且保留了 git 原生的**衝突偵測與 merge 工具**。

設定（第一台，一次）：
```bash
git init --bare "D:/OneDrive/git-remotes/myproj.git"
cd /d/repos/myproj
git remote add origin "D:/OneDrive/git-remotes/myproj.git"
git push -u origin HEAD
```

其他電腦：
```bash
git clone "D:/OneDrive/git-remotes/myproj.git" D:/repos/myproj
cd /d/repos/myproj && git config core.hooksPath .githooks
```

**務必把該資料夾設為「一律保留在此裝置上」**（關閉 Files On-Demand），避免佔位符。
Google Drive 同理（`G:\My Drive\git-remotes\...`）—— 對 git 而言就只是個本地路徑。

**plugin 完全不用改**：`MEM_AUTOSYNC` / `MEM_AUTOPUSH` 對「本地路徑 remote」與對 GitHub 行為一致。
§11 的跨機閉環測試用的正是純檔案系統 bare repo（`git init --bare /srv/remote.git` + 兩個 clone），
**機制已實測**，差別只在 bare repo 放哪裡。

**殘留風險**：兩台**近乎同時** push 而雲端尚未收斂 → bare repo 可能不一致。循序切換風險低，
且 `status.sh` 開局會報「落後遠端 N 個 commit」可及早發現。換機前確認雲端圖示已同步完成再開工。

---

## 8. Token 與維護成本

**開銷估計（分層讀取，內容不砍）**：
- Tier 1 每次自動注入 `INDEX.md` + `handoff.md` 約 **~400–550 tokens/session**（INDEX 純索引更小了）。
- Tier 2 `STATE.md` / `DECISIONS.md` 只在任務需要時載入（DECISIONS 先看索引表，只取相關那條）；**完整保真度永遠留在磁碟，省的是不 eager load，不是刪內容**。
- 在支援 Prompt Caching 的環境，每輪命中 cache 僅約原價 10%；INDEX 幾乎不變，快取命中率高。
- **效益比**：相較於重掃碼／重新解釋架構的 **10,000–50,000 tokens**，現省 90%+ 開局浪費。佔 Opus 5 小時視窗 **遠低於 1%**（真正吃視窗的是實際 coding，不是這套記憶）。

**防失控**：INDEX/handoff 短是因 scope 小非砍內容；STATE/DECISIONS 按需；更新門檻（§3）擋掉瑣碎 session 的無謂 commit；長檔搬 `archive/`（完整保真）不刪。

---

## 9. 驗收清單

- [ ] `.gitattributes`（`.githooks/* text eol=lf`）已配置
- [ ] `.claude/settings.json` 有 SessionStart hook；新 session 會**自動**注入 INDEX + handoff
- [ ] 三個 agent 入口檔存在且含最小必要規則
- [ ] `INDEX.md` 不含會變動的 commit／日期／狀態（可變狀態只在 handoff）
- [ ] `STATE.md` 只在宏觀狀態變動時更新；`DECISIONS.md` 追加不覆寫
- [ ] 工程檔變更但未 staged 記憶 → pre-commit 擋 commit
- [ ] 新增 secret → 擋；「移除既有 secret」→ 正常通過
- [ ] 新電腦 clone 後跑 `bootstrap.ps1` 能啟用 hook
- [ ] agent 不會在未授權下自行 pull/rebase/merge/reset/force-push
- [ ] 唯讀提問／瑣碎 session 不會製造無謂記憶更新（更新門檻生效）
- [ ] `AGENTS.md` / `.agents/rules/` 含自動再生的 `AUTO-MEMORY` 區塊，且 handoff 一改就同步
- [ ] agent 收工會自己 commit 記憶，且**不會捲走使用者已 staged 的原始碼**
- [ ] `MEM_AUTOPUSH=1` 時被拒的 push 只回報，不 force、不 reset
- [ ] **（未做）真機驗證 Codex 與 Antigravity 確實載入 entry 檔並照做** — 見 §12 第 1 項

---

## 10. 開發歷程摘要

這份方案經過四輪迭代：初版精簡骨架 → Perplexity v2 補強 → Antigravity 修正 → 自動化與 plugin 化。
中途推翻過三個自己的決定，記錄在此避免重蹈：

| 我原本的做法 | 為什麼錯 | 現在的做法 |
|---|---|---|
| INDEX 放狀態列（milestone + commit） | 與 handoff 雙寫，必然 drift | INDEX 純索引，可變狀態只在 handoff |
| 建議「硬壓行數省 token」 | 壓到失真 → 下個 agent 讀不懂又去重掃，賠更多 | 只動**載入時機**（分層），不動內容多寡 |
| `/handoff` 寫死「Do not commit」 | 過度保守，親手製造「handoff 傳不出去」的缺口 | 按可逆性分級：記憶自動 commit，碼不碰，push 用開關 |

---

## 11. 已解決的問題

機制層皆在拋棄式 repo 實測通過。

| # | 問題 | 解法 |
|---|---|---|
| 1 | 換電腦／換 agent 要重講一遍專案 | `.project-memory/` + Git 為唯一事實來源 |
| 2 | 全部記憶塞進 context 會膨脹 | tier 1／tier 2 分層；**不 eager load ≠ 砍內容** |
| 3 | INDEX 與 handoff 雙寫 drift | INDEX 純索引，可變狀態單一寫入處 |
| 4 | 每個 session 都製造無謂記憶 commit | PROTOCOL 更新門檻（唯讀／瑣碎 → 不寫檔） |
| 5 | Windows CRLF 讓 hook 噴 `\r: command not found` | `.gitattributes` 強制 `*.sh` 為 LF |
| 6 | commit `.githooks/` 不會自動生效 | init 設 `core.hooksPath`；新機一鍵 bootstrap |
| 7 | secret 掃描誤擋協定裡的 "passwords/API keys" 純文字 | 改為「關鍵字＋`:=`＋12 字元以上值」才觸發 |
| 8 | 「移除舊 secret」的 commit 也被擋 | 只掃 diff 的**新增行**（`^+`） |
| 9 | 改了碼卻忘記更新記憶 | `pre-commit` 正向比對工程檔 → 擋 commit |
| 10 | 開局要手動貼「請讀記憶」開場白 | Claude Code SessionStart hook 自動注入 |
| 11 | **Codex／Antigravity 無法自動執行指令載入記憶** | git hook 把 handoff **生成**進它們本來就自動讀的 entry 檔 |
| 12 | 注入順序 bug：先注入再同步 → 餵到舊記憶 | 改為**先同步、再注入** |
| 13 | auto-pull 可能造成衝突／半 rebase 殘局 | `fetch` 唯讀常開；`pull --ff-only` ＋三重守衛 |
| 14 | handoff 沒被 commit → 其他 agent 看不到 | agent 自己 `commit-handoff.sh`（可選 push） |
| 15 | agent 提交記憶時可能捲走使用者的碼 | pathspec-limited commit（已實測不影響 staged 原始碼） |
| 16 | 全新 repo（零 commit）下 `commit-handoff.sh` 誤判「無變更」而靜默不做事 | 檢查改用 `git status --porcelain`（`git diff` 看不到**未追蹤**檔案）|

| 17 | 不想架 GitHub，但又要跨機同步 | 雲端硬碟只放 **bare repo** 當 remote，工作區在雲端資料夾**外**（見 §7.5）|

**需不需要 GitHub**：**不需要**。必要的只有 `git init`（本機 repo）；remote 只有「跨電腦」才需要，
且不限 GitHub —— GitLab／自架 Gitea／NAS bare repo／**OneDrive 或 Google Drive 上的 bare repo** 皆可（§7.5）。
無 remote 時實測：`status.sh` 正常印記憶、`pre-commit` 強制層照常生效、`commit-handoff.sh` 正常
本機提交並提示「No upstream configured」。

**已驗證行為（Windows / Git Bash）**：scaffold 冪等不覆蓋／改碼漏更新記憶被擋／新增 secret 被擋／
移除 secret 放行／純文字不誤判／hook 路徑與直接執行輸出一致／無記憶 repo 靜默 no-op／
entry 檔自動再生並 staged／sync 冪等不堆疊／pull 後 post-merge 自動刷新／
跨機閉環（A 寫→自動 push→B pull→開局即見）／push 被拒時不 force 不 reset／無變更時 no-op。

**已驗證行為（Linux / Docker，`alpine/git` + busybox）**：

| 測項 | 結果 |
|---|---|
| hook 可執行位元（Windows 建檔 → Linux 是否被 git 靜默跳過） | ✅ `-rwxr-xr-x`，未被跳過 |
| 只改碼不動記憶 → 擋 | ✅ |
| 碼＋記憶 → 放行 | ✅ |
| entry 檔自動再生 | ✅ |
| 新增 secret → 擋 | ✅ |
| `commit-handoff.sh` 不捲走已 staged 的原始碼 | ✅ |
| 雙容器共用 bare remote 的完整跨機閉環 | ✅ A 自動 commit+push → B `MEM_AUTOSYNC=1` ff-only 同步 → entry 檔與注入內容皆為最新 |

> 這輪跑在 **Alpine + busybox awk/sed** 上（比 GNU 版嚴格得多）全數通過，
> 代表腳本沒有相依 Windows／Git Bash／GNU 工具的隱性假設 —— portability 這條可以放心。

---

## 12. 待解決 / 已知限制

按重要性排序。

**P0 — 未驗證，會影響方案是否成立**

1. **Codex / Antigravity 的真機「服從性」未測。** 機制層（檔案有沒有被正確生成、hook 有沒有
   觸發、跨機有沒有同步）已在 Windows 與 Linux/Docker 兩個環境驗證完畢；**尚未驗證的是最後
   一哩：Codex 是否真的每次都載入 `AGENTS.md`、Antigravity 是否真的載入 `.agents/rules/`，
   並且照裡面的指示做。** 這是整個跨工具設計唯一剩下的前提假設。

   **「讀哪些檔」已由安裝檔實證確認**（見第 7 項）；**未確認的只剩「LLM 是否照著做」**。

   **自動化測不了這一項**，原因：
   - **Antigravity 沒有 headless／agent CLI**：`antigravity-ide --help` 只有標準 VS Code 參數
     （`--diff` / `--goto` / `--install-extension` …），無 prompt 或 agent 旗標 → 只能在 GUI 手測。
   - **Codex CLI** 可裝進容器，但需要 OpenAI 憑證；且要驗的是 LLM 服從性，得真的發 API 請求，
     屬於要你自己決定與提供憑證的範圍。

   → **已備妥 canary 測試 repo**：`memory-probe/`（一個平凡的 calc 專案）。
   handoff 裡放了字串 `PLUM-7731-KESTREL` 與任務 `Migrate the divide() helper to decimal
   arithmetic`，**兩者在程式碼與 README 中完全不存在**（已 grep 確認只出現在 3 個記憶檔）。

   測試方式（各 1 分鐘）— 在該 repo 開 agent，問：
   > 這個專案目前進行到哪？下一步該做什麼？

   | 結果 | 判定 |
   |---|---|
   | 答出 `decimal` 遷移任務／`PLUM-7731-KESTREL`／`pytest -k divide` | ✅ **通過**（只可能來自記憶檔） |
   | 只描述 `add()` 函式、說專案很簡單 | ❌ **未讀記憶**，需加強 entry 檔祈使句 |
   | 先去掃 `src/` 才回答 | ⚠️ 部分失敗（沒信任記憶，仍在重複探索） |

   不通過的退路：entry 檔頂端加更強祈使句，或退回「每次手動貼一行 `bash .project-memory/status.sh`」。
2. **真實專案未長期試跑。** 需要 1–2 週實用才知道 handoff 品質、context 膨脹、conflict 頻率。

**P1 — 已知會發生，有緩解但沒根治**

3. **hook 擋得了「沒寫」，擋不了「寫得爛」。** 內容品質是 LLM 本質限制。
   → 可能緩解：pre-commit 加 handoff 必要欄位非空檢查（目前**未實作**）。
4. **`handoff.md` merge conflict。** 跨機同時提交仍會撞。原則是保留最新時間戳區塊、合併
   「Next agent should」，但**尚未自動化**。
5. **Codex/Antigravity 拿到的是 commit／pull 時點的快照**，非未提交的即時狀態。
   （agent 自己 commit 後此差距已大幅縮小，但未提交的在製品仍看不到 → 可跑 `status.sh` 補。）
6. **worktree 並行的記憶整合仍需人工**：各分支看不到彼此未 merge 的記憶，由整合者統一重寫。

**P2 — 環境／調校**

7. ~~**Antigravity `.agents/rules/` 路徑可能隨版本變**~~ → **已用安裝檔實證確認**（2026-09-08，
   Antigravity IDE 1.107.0，VS Code fork）：
   - `resources/app/extensions/antigravity/package.json` 內含 glob `**/.agents/rules/**/*.md`
   - language server binary（`language_server_windows_x64.exe`）內含字串
     `.agents/rules/*.md`、**`AGENTS.md`（6 次）**、`GEMINI.md`（6 次）
   - **意外收穫：Antigravity 也會讀 `AGENTS.md`** —— 亦即我們生成的 `AUTO-MEMORY` 區塊
     對 Codex 與 Antigravity 是**雙重覆蓋**，冗餘度比原本預期高。
   - 仍需在每次 IDE 大版本升級後重驗（用同樣的 grep 方法即可，30 秒）。
8. **`pre-commit` 工程檔 regex 偏嵌入式**（含 `firmware|drivers`、`c/cpp/h`）：純軟體專案要自行調整。
9. **`AUTO-MEMORY` 區塊讓 `AGENTS.md` 的 diff 變吵**：每次 handoff 更新都動到兩個 entry 檔。
   （代價已知且可接受——換來的是 Codex/Antigravity 的自動載入。）
10. **Plugin 尚未發佈 marketplace**：目前只能本機安裝。
11. **記憶仍會過時**：靠 §1 優先級（code/tests 優先）＋ `Unverified` 標記，非機制保證。

---

## 附錄 A：多 agent 並行（進階，非第一階段）

依序切換 agent **不需要** worktree。兩個以上同時改碼才用：

```bash
git worktree add ../project-claude       feature/claude-task
git worktree add ../project-codex        feature/codex-task
git worktree add ../project-antigravity  feature/antigravity-task
# 完成後由整合 agent merge
git checkout main
git merge --no-ff feature/codex-task
git merge --no-ff feature/antigravity-task
```
並行時各分支保有自己的 `handoff.md`；最後由整合 agent 依 merge 結果重寫主分支 handoff，必要時更新 STATE。

---

## 附錄 B：核心心法

目標不是保存每段對話，而是留「下一個 agent 做正確下一步所需的最少可靠資訊」。別一開始就上向量庫／SQLite／MCP memory server。

```text
開局（自動注入 INDEX + handoff）→ 按需讀 STATE/DECISIONS/PROTOCOL → 執行與驗證
→ 只有符合更新門檻才更新 handoff/state/decisions → commit + push（pre-commit 把關，你授權同步）
```

先用這套 Markdown + Git + hook 跑一到兩週，再依真實的 handoff 品質、重複掃碼、merge conflict、context 膨脹決定是否升級。
