# 兩台電腦的工作流程

在兩台 PC 上輪流開發這個專案時，讓兩邊（以及 Claude Code、Codex、Antigravity 三家 AI）都知道「做到哪、下一步是什麼」。

核心觀念：**同步靠 git**。程式碼和專案記憶（`.project-memory/handoff.md`）都在 repo 裡，
一台推上去、另一台拉下來就同步了。Workbench 本身的設定、儀表板紀錄、Cowork 會議紀錄存在各台電腦本機，**不會**同步。

---

## 一、每台電腦的一次性設定

1. **安裝工具**
   ```powershell
   winget install --id Git.Git -e
   winget install --id OpenJS.NodeJS.LTS -e
   ```
2. **取得專案**
   ```bash
   git clone https://github.com/ikenican/Mulit-Harness-ADE.git
   cd Mulit-Harness-ADE
   git checkout improve/accuracy-handoff
   npm install
   ```
3. **啟用 git hook**（每個 clone 都要做一次，設定不會跟著 repo 走）
   ```bash
   git config core.hooksPath .githooks
   ```
   - 提交 handoff 時，自動更新 Codex 和 Antigravity 開機會讀的 `AGENTS.md`、`.agents/rules/shared-memory.md`。
   - `git pull` 之後，自動更新同兩個檔案。
   - 記憶裡新增的內容如果含密碼、API key、私鑰，提交會被擋下（記憶會推上 GitHub）。
4. **Claude Code 記憶外掛**（有用 Claude Code 才需要）
   ```bash
   claude plugin marketplace add zkylek1212-k/ShareProjectMem
   claude plugin install shared-project-memory@shared-project-memory
   ```
   裝了之後，Claude 每次開新對話會自動讀到專案記憶。沒裝的話，要靠 `CLAUDE.md` 的指示，讓它自己執行 `bash .project-memory/status.sh`。
   注意：外掛會在開新對話時執行**該專案自己的** `.project-memory/status.sh`，只在信任的專案使用。
5. **Workbench 本機設定**（每台各自做）
   - 設定 → CLI：安裝或指定 Claude Code / Codex / Antigravity 的路徑，按「偵測」。
   - 設定 → Cowork：預設參與者、主席、模型、預算。
   - 連線憑證（Customized 面板的 Connections）：每台各自輸入，刻意不同步。
6. **GitHub 登入**：第一次 `git push` 會跳出 Git Credential Manager 的登入視窗，用瀏覽器登入一次即可。

## 二、每次開工

1. **先拉最新**
   ```bash
   git pull
   ```
2. 打開 Workbench 和專案，讓 AI 開工。三家 AI 啟動時都會讀到最新的 handoff：
   - Claude Code：外掛自動載入（或依 `CLAUDE.md` 自己執行 `status.sh`）
   - Codex：讀 `AGENTS.md`
   - Antigravity：讀 `.agents/rules/shared-memory.md`
3. 想手動看目前狀態：`bash .project-memory/status.sh`

## 三、每次收工（換電腦前一定要做）

1. 請 AI **更新 handoff**：依 `.project-memory/PROTOCOL.md` 的固定欄位（State / Verified / Not verified / Next / Risks / Details），寫清楚做了什麼、驗證了什麼、沒驗證什麼、下一步。
2. **提交記憶**（只提交記憶相關檔案，不會動到其他改動）
   ```bash
   bash .project-memory/commit-handoff.sh "docs(memory): <一句話摘要>"
   ```
3. **提交程式碼**（若還有未提交的改動），然後**推送**
   ```bash
   git push
   ```
4. 另一台電腦開工時從第二節開始。

> 若有安裝使用量保護 hook（`~/.claude/hooks/usage-guard.cjs`），Claude 的用量剩不到 3% 時會自動停下來做第 1、2 步。

## 四、工具（MCP、skill、外掛）怎麼兩台一致

- 在 Workbench 的 **Customized** 面板宣告要用的 MCP / skill / 外掛，它們會寫進 `.workbench/extensions.yaml`，跟著 git 同步。
- 另一台拉下來後，打開同一個專案的 Customized 面板套用，就會產生各家 CLI 需要的原生設定。
- 憑證不寫在這個檔案裡（用 `${conn:名稱}` 代替），每台在 Connections 各自輸入。

## 五、不會同步的東西

| 項目 | 存放位置 | 說明 |
|---|---|---|
| CLI 路徑、Cowork 預設、最近開過的專案 | `%APPDATA%\agent-workbench\` | 每台各自設定 |
| 連線憑證 | 本機，作業系統加密 | 刻意不同步 |
| 儀表板的會話紀錄與 token 用量 | 各台的 `~/.claude`、`~/.codex`、`~/.gemini` | 只看得到本機的紀錄 |
| Cowork 會議紀錄、背景執行的 worktree | `%APPDATA%\agent-workbench\cowork` | 在哪台開的會就在哪台 |
| 正在執行的終端 | 本機 | — |
| 版面配置（左右位置、欄寬） | Workbench 的本機儲存 | 每台各自調整 |

## 六、注意事項

- **不要兩台同時在同一個分支上改**。一定要先推、另一台再拉，否則 handoff 很容易衝突。
- handoff 衝突時，以內容較新的一邊為準，手動合併後再提交；`DECISIONS.md` 只能新增、不能改舊內容。
- Cowork 的背景執行在哪台開始，就要在哪台合併或清理（worktree 在那台本機）。
- 改到 `package.json` 或 lockfile 後，另一台拉下來記得再跑一次 `npm install`。
