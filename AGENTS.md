# Agent Instructions

Canonical cross-agent memory is `.project-memory/`.

## Startup — run this ONE command first, every session

```bash
bash .project-memory/status.sh
```

It prints tier-1 memory (`INDEX.md` + `handoff.md`) and reports whether the branch is behind the
remote. Do not read those two files separately — the command already gave you their contents.

Then:
1. Inspect `git status --short` and `git branch --show-current`.
2. Summarise the current context in <=3 bullets.
3. Read `.project-memory/PROTOCOL.md` on first entry to this repo, for Git/worktree/merge tasks,
   for memory-file changes, or when the rules are unclear.
4. Read `STATE.md` / `DECISIONS.md` only when the task needs macro status or architecture history.

## Before finishing

Apply the memory-update criteria in `PROTOCOL.md`: rewrite `handoff.md` when the work meets the
threshold; skip it entirely for read-only questions, trivial explanations, and no-change reviews.

Then commit the memory yourself — an uncommitted handoff does not exist for anyone else:

```bash
bash .project-memory/commit-handoff.sh "docs(memory): <one-line summary>"
```

It is pathspec-limited to memory files, so the user's staged source changes are left untouched.
It pushes only when `MEM_AUTOPUSH=1`; otherwise say clearly that the handoff is not pushed yet.

## Never

- Auto pull/rebase/merge/reset/force-push without user authorization. `git fetch` is read-only and fine.
- Commit the user's SOURCE code on your own initiative — committing shared memory is fine, that is not.
- Commit secrets, tokens, passwords, API keys, or private keys.
- Rewrite historical decisions — supersede them instead.

<!-- BEGIN AUTO-MEMORY (generated from .project-memory/handoff.md - do not edit) -->

## Current shared memory (tier 1 - auto-generated, do not edit here)

You already have the current handoff below. Do NOT re-read `.project-memory/handoff.md`.
Read `STATE.md` / `DECISIONS.md` / `PROTOCOL.md` only on demand.
For the freshest copy plus a remote-drift check, run `bash .project-memory/status.sh`.

---

# Latest Handoff

- Agent: Claude Code (local, user's Windows 11 PC, D:\AI_Project\Mulit-Harness-ADE)
- Updated: 2026-10-24 Asia/Taipei
- Branch: improve/accuracy-handoff; code HEAD 649bb98 (+ this memory commit). Being pushed to origin with the user's go-ahead (2026-10-24), together with release/0.1.41-fork.4. Not merged into master.

## State
- Main-process blocking removed (details and numbers: archive/2026-10-24-main-thread-perf.md): async CLI detection and Cowork `--help` probe (64ac1fe); dashboard/usage scanning in a worker thread via `src/main/ipc/sessionScan.ts` + `dashboardWorker.ts`, falling back to main if the worker fails (d2dff07). Bench: `scripts/bench-main-blocking.cjs`.
- 9a336a1: Codex install falls back official script → winget OpenAI.Codex → npm on Windows; sh form no longer hides a 404. chatgpt.com/codex/install.* returned 404 on 2026-10-24.
- 902eb19 + b2de833: new app icon from the user's glossy.png (untracked in repo root; copy build/icon-source.png). `scripts/gen-app-icons.ps1` writes build/icon.png/.ico, public/app-icon-256.png and phone PWA icons; windows/notifications use `src/main/appIcon.ts`; NSIS icons set in electron-builder.yml.
- UI layout (developer mode, src/renderer/src/App.tsx + layout.ts): header has the editor group (Editor/Preview/Memory/Browser) and a terminal icon; dragging them reorders the panes (`termFirst`: terminal left in right dock / top in bottom dock, applied live, saved). The terminal icon toggles the terminal pane (`termHidden`); clicking the active editor tab hides the editor; never both hidden; a terminal open request unhides it. The old show/hide-editor button was removed (924ab38, c4ff50d, 7fbbd65). Terminal can grow until the editor has 200 px (`LIMITS.editorMin`; the 900 px cap no longer applies in developer mode).
- 5173bf2: switching workspace selects that project's most recently used open terminal tab (tabs record `workspace`); with none, it resumes the project's latest Claude/Codex/Antigravity session from dashboard data. Skips the first workspace set at startup and skips if a tab for the project appears during the lookup.
- 649bb98: file tree header button opens the project folder in Explorer (`files:revealWorkspace`, path resolved in main).
- d085d8c/6674fda: `dev.cmd` (double-click) → `dev.ps1` → `npm run dev`. This PC's PowerShell policy is Restricted, so .ps1 cannot run directly. Dev build uses %APPDATA%\agent-workbench-dev and runs beside the installed app.
- Installed on the user's PC: a LOCAL build of 0.1.41-fork.3 (10:36, before the UI commits; built with electron-builder after seeding %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0 from a partial extraction). Hence the GitHub release is fork.4, so the in-app updater offers it. No fork.3 exists on GitHub.
- package.json still 0.1.41; apps/linux untouched (DEC-011).

## Verified
- `npm run typecheck` -> pass; `npm run build` -> pass
- `node --experimental-strip-types scripts/check-{cowork,version,usage,bgTasks,portDetect,hosts,remote,remote-files}.mts` -> pass; `check-approval.cjs`, `check-custom-agent.cjs` -> pass
- `node_modules/.bin/electron scripts/check-{cowork-tabs,terminal-ui,remote-cowork,custom-agent-ui}.cjs` -> pass on Windows
- Layout drag, toggles (7 cases), terminal width 959 px / height 661 px at 1440x900, workspace switch (A tab / B resume / back to A / back to B, no duplicates), reveal folder (Explorer opened the folder): driven over CDP in isolated dev instances (separate --user-data-dir, fake home for the workspace test)
- Local fork.3 installer: exe and setup.exe icons extracted and checked

## Not verified
- The GitHub Actions run for release/0.1.41-fork.4 (pending at this commit) and the in-app update fork.3 → fork.4.
- Real mouse drag of the header items and of the splitter (tests used synthetic DragEvents / the splitter's keyboard control).
- Paste-then-Enter delay (user report): not reproduced; ConPTY, PowerShell, Claude Code direct and through the main pty pipeline respond in ~15-100 ms. Waiting for the user's details (which tab, how pasted, size, delay, Windows Terminal comparison).
- Real winget/npm Codex install, a real multi-agent meeting, Windows `revertFiles`, very large real logs.

## Next
- Watch the fork-release run for release/0.1.41-fork.4; check the release assets and record the run id; confirm the installed fork.3 is offered fork.4.
- Remaining performance candidates (not changed): archive/2026-10-24-main-thread-perf.md.
- Earlier plan items: agent profile settings, Codex/Antigravity SessionStart hooks, drag-handoff from CLI session logs, per-meeting token totals, unknown-schemaVersion read-only view.

## Risks / do not
- Dashboard session status depends on log age: compare dashboard output only with paired runs on the same fixture mtimes.
- A test dev instance must use its own `--user-data-dir`; otherwise the single-instance lock hands over to the user's running dev window and the test instance exits.
- Do not merge into master or release without the user's go-ahead. Do not touch apps/linux (DEC-011). Do not delete user files (glossy.png) without asking.

## Details
- Bench method, numbers, remaining candidates: archive/2026-10-24-main-thread-perf.md
- Previous handoffs: archive/handoff-2026-10-24-before-main-thread-perf.md (Cowork scope review, fork.1/fork.2)

<!-- END AUTO-MEMORY -->
