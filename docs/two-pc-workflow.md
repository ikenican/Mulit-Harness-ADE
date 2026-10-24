# 兩台電腦的工作流程

在兩台 PC 上輪流開發同一個專案時，讓兩邊（以及 Claude Code、Codex、Antigravity 三家 AI）都知道「做到哪、下一步是什麼」。

兩條同步管道：
- **程式碼**：專案 repo（git push / pull）。
- **專案記憶**（`.project-memory/`，含 handoff）：你自己的**私人** GitHub repo（預設 `ai-project-memory`，所有專案共用，每個專案一個資料夾）。專案 repo 不追蹤記憶檔，所以記憶不會出現在公開的專案 repo。

Workbench 本身的設定、儀表板紀錄、Cowork 會議紀錄存在各台電腦本機，**不會**同步。

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
   git config core.hooksPath .githooks
   ```
   `core.hooksPath` 每個 clone 都要設一次：`git pull` 之後會自動更新 Codex／Antigravity 讀的入口檔。
3. **記憶同步**（Workbench：設定 → 記憶同步）
   1. 打開「開啟記憶同步」開關（先看清楚頁面上的說明）。
   2. 第 1 步：按「安裝 GitHub CLI」「登入 GitHub」，指令會貼進新的終端分頁，按 Enter 執行，需要時在瀏覽器登入。完成後按「重新偵測」。
   3. 第 2 步：按「建立或連結私人 repo」。第一台會建立私人 repo；其他電腦會連到同一個 repo。repo 若是公開的會被拒絕。
   4. 第 3 步（在專案打開的狀態下）：
      - 第一台：「把記憶搬到私人 repo」。本機記憶先備份，搬進私人 repo 並推送；專案 repo 會多一個「停止追蹤記憶檔」的提交（不會自動推送，確認後自己 push）。
      - 其他電腦：「使用私人 repo 裡的記憶」。直接連到私人 repo 裡的記憶，入口檔（`AGENTS.md`、`.agents/rules/shared-memory.md`）會自動補回。
4. **Claude Code 記憶外掛**（有用 Claude Code 才需要，自己執行）
   ```bash
   claude plugin marketplace add zkylek1212-k/ShareProjectMem
   claude plugin install shared-project-memory@shared-project-memory
   ```
   裝了之後，Claude 每次開新對話會自動讀到專案記憶。沒裝時，`CLAUDE.md` 會指示它自己執行 `bash .project-memory/status.sh`。
   外掛會在開新對話時執行**該專案自己的** `.project-memory/status.sh`，只在信任的專案使用。
5. **Workbench 本機設定**（每台各自做）：設定 → CLI（安裝或指定各家 CLI）、設定 → Cowork、Customized 面板的連線憑證。

## 二、每次開工

1. 專案程式碼：`git pull`
2. 打開 Workbench 和專案。記憶同步的「開啟專案時自動拉取」開著時，記憶會自動拉到最新；沒開就到設定 → 記憶同步按「立即同步」。
3. 三家 AI 啟動時都會讀到最新的 handoff。想手動看：`bash .project-memory/status.sh`（會顯示記憶 repo 是否落後）。

## 三、每次收工（換電腦前一定要做）

1. 請 AI **更新 handoff**（`.project-memory/PROTOCOL.md` 的固定欄位：State / Verified / Not verified / Next / Risks / Details）。
2. **提交記憶**：
   ```bash
   bash .project-memory/commit-handoff.sh "docs(memory): <一句話摘要>"
   ```
   只會提交並推送到私人記憶 repo；記憶還沒連結到私人 repo 時會拒絕執行，不會寫進專案 repo。新增的內容若含密碼、API key、私鑰也會被擋下。
3. **提交並推送程式碼**：`git push`
4. 另一台開工時從第二節開始。

> 若有安裝使用量保護 hook（`~/.claude/hooks/usage-guard.cjs`），Claude 的用量剩不到 3% 時會自動停下來做第 1、2 步。

## 四、工具（MCP、skill、外掛）怎麼兩台一致

- 在 Workbench 的 **Customized** 面板宣告要用的 MCP／skill／外掛，會寫進 `.workbench/extensions.yaml`，跟著專案 repo 同步。
- 另一台拉下來後，在同一個專案的 Customized 面板套用。憑證不寫在這個檔案裡（用 `${conn:名稱}`），每台在 Connections 各自輸入。

## 五、不會同步的東西

| 項目 | 存放位置 | 說明 |
|---|---|---|
| CLI 路徑、Cowork 預設、最近開過的專案、記憶同步設定 | `%APPDATA%\agent-workbench\` | 每台各自設定 |
| 連線憑證 | 本機，作業系統加密 | 刻意不同步 |
| 儀表板的會話紀錄與 token 用量 | 各台的 `~/.claude`、`~/.codex`、`~/.gemini` | 只看得到本機的紀錄 |
| Cowork 會議紀錄、背景執行的 worktree | `%APPDATA%\agent-workbench\cowork` | 在哪台開的會就在哪台 |
| 記憶搬移前的本機備份 | 記憶 repo 副本裡的 `.local-backups/` | 不會推送 |
| 版面配置 | Workbench 的本機儲存 | 每台各自調整 |

## 六、注意事項

- **不要兩台同時改同一份記憶**。兩台都改了同一行時，「立即同步」會回報衝突，你的改動保留在本機的提交裡；到記憶 repo 副本資料夾（設定頁的「開啟資料夾」）解決後再同步。
- 程式碼也一樣：先推、另一台再拉。
- 私人記憶 repo **不要改成公開**。Workbench 每次建立或連結時都會檢查。
- 改到 `package.json` 或 lockfile 後，另一台拉下來記得再跑一次 `npm install`。
