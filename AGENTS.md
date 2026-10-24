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
- Branch: improve/accuracy-handoff; code HEAD b2de833 (+ this memory commit). Local commits 8d8ddba..b2de833 are NOT pushed; origin/improve/accuracy-handoff is still ccca94e. Not merged into master.

## State
- 64ac1fe: CLI detection without blocking main. `findCliAsync`/`findAgentCliAsync` (src/main/ext/paths.ts) use execFile + fs.promises with the same selection rules as `findCli`. Async users: Cowork capabilities, ext:agents, Settings CLI test. The Cowork `--help` flag probe is execFile instead of spawnSync, and concurrent calls share one in-flight probe. `resolveCli`/`resolveExecCli` may return a Promise; the executor registers its AbortController before awaiting. Sync `findCli` (terminal spawn) reuses a found path for 5 min after re-checking that it exists; not-found is never cached.
- d2dff07: dashboard scanning runs in a worker thread. Scanners moved verbatim (only exports changed) from dashboard.ts to `src/main/ipc/sessionScan.ts`; it and `usage.ts` no longer import Electron. `dashboardWorker.ts` (electron-vite `?nodeWorker`) serves `dashboard:data` and `dashboard:usage`; if the worker cannot start or fails, the same functions run on main. State and active PTYs are read after the scan; concurrent non-forced requests share one scan. Archive/delete/unmark use the cached-session snapshot returned by the worker.
- 9a336a1: Codex install. Windows: official script → `winget install --id OpenAI.Codex -e` → npm → message. macOS/Linux: the script is downloaded first, and npm is used if the download or the script fails (`curl | sh` used to exit 0 on a 404). chatgpt.com/codex/install.ps1, install.sh and releases.openai.com/codex all returned 404 on 2026-10-24, even though the Codex README still lists them.
- 902eb19 + b2de833: new app icon from the user's glossy.png (kept untracked in the repo root; copy at build/icon-source.png). scripts/gen-app-icons.ps1 re-masks the tile (drops the ragged white fringe) and writes build/icon.png, build/icon.ico (win.icon + NSIS installer/uninstaller/header), public/app-icon-256.png (Settings > About logo, favicon) and the phone PWA icons (512 no longer maskable). Windows and OS notifications use src/main/appIcon.ts. gen-remote-icons.mjs is superseded (would restore the old icon).
- Release in progress: the user asked (2026-10-24) to release with the new icon as release/0.1.41-fork.3. This PC has no GitHub credentials, so the user must push that branch (Git Credential Manager browser login); fork-release.yml then builds, publishes v0.1.41-fork.3 and deletes the branch.
- scripts/bench-main-blocking.cjs (8d8ddba, 0cedbb0, 59de84b): measures main-thread blocking as real IPC round trips (see Details).
- Nothing released; package.json still 0.1.41; apps/linux untouched (DEC-011). package-lock.json was restored after npm 11 rewrote "peer" flags (not committed).

## Verified
- `npm run typecheck` -> pass (after each change)
- `node --experimental-strip-types scripts/check-{cowork,version,usage,bgTasks,portDetect,hosts,remote,remote-files}.mts` -> all pass; `node scripts/check-approval.cjs` -> pass; `node scripts/check-custom-agent.cjs` -> pass
- `node_modules/.bin/electron scripts/check-{cowork-tabs,terminal-ui,remote-cowork,custom-agent-ui}.cjs` -> all pass on Windows (first run on Windows)
- `npm run build` -> pass; out/main has dashboardWorker-*.js, sessionScan-*.js and the icon .ico/.png chunks
- Icons loaded from an asar copy of out/: nativeImage icon.png 1024 / icon.ico 256 non-empty; favicon and About logo resolve to 256 px
- Bench, worst IPC round trip before -> after: dashboard:data cold 527-535 -> 0.4-1.4 ms, warm 60-72 -> 0.3-1.9 ms; ext:agents 90-102 -> 1-14 ms; cowork:capabilities first 279-293 -> 3-4 ms. Paired runs: dashboard:data/usage output byte-identical (12/12).
- findCli vs findCliAsync -> identical for 13 cases on this PC
- Built app packed into an asar, run with Electron, real renderer -> dashboard data correct, worker used (no fallback log)
- Codex install command: PowerShell 5.1 parse OK; with the real 404 and stubbed winget/npm: winget ok / winget fails → npm / neither → message; sh form in Git Bash: 404 → npm

## Not verified
- `npx electron-builder --dir` failed locally (winCodeSign 7z needs symlink privilege), so an installer-built app was not run; the asar test above stands in. The fork-release workflow (windows-latest) should package normally.
- Real `winget install OpenAI.Codex` and real npm install were not run (stubbed), to avoid installing Codex on the user's PC.
- Installed fork in-app update, a real multi-agent meeting, and Windows `revertFiles` behaviour: still not run (see archived handoff).
- Dashboard with very large real logs (>64 MB) and many Antigravity sessions: only the synthetic fixture was used.

## Next
- After the user pushes release/0.1.41-fork.3: watch the fork-release run, then check the release assets (setup.exe icon, installer icon, portable ZIP) and record the run id. Pushing improve/accuracy-handoff itself still needs the user's go-ahead.
- Paste-then-Enter delay (user report 2026-10-24): not reproduced. ConPTY/cmd, PowerShell, Claude Code direct and through the app's main pty pipeline all respond in ~15-100 ms after a paste (PowerShell PSReadLine ~0.9 s for 10k chars). Bracketed paste reaches Claude Code and agy. Waiting on the user: which tab, how they paste, size, how long, whether Windows Terminal lags too. Remaining suspects: renderer side, or fork.2 main-process blocking (fixed in fork.3).
- Remaining performance candidates (listed for the user, not changed): incremental parsing of active session logs (polled every 5 s); usage ignores files >64 MB (accuracy); unmarkDeletedOrArchivedWorkspace scans on main at every workspace open; loadSettings uncached; Cowork writeJsonAtomic fsync + Atomics.wait retry on main; scanBgTasks every 4 s; sync findCli for uninstalled CLIs on tab open. Full list with numbers: archive/2026-10-24-main-thread-perf.md.
- Then the earlier plan items: agent profile settings, Codex/Antigravity SessionStart hooks, drag-handoff from CLI session logs, per-meeting token totals, unknown-schemaVersion read-only view.

## Risks / do not
- Dashboard session status depends on log age: compare dashboard output only with paired runs on the same fixture mtimes (bench `--touch`, or touch once and alternate WB_BENCH_SRC runs).
- The worker writes dashboard-cache.json / usage-cache.json in userData; if the worker fails, main writes them instead. Never both at once by design, but a crash mid-scan falls back on main.
- The dev app adds "-dev" to `--user-data-dir`; without that flag a dev run shares %APPDATA%\agent-workbench with the user's installed app.
- Do not push, merge, or release without the user's go-ahead. Do not touch apps/linux (DEC-011).

## Details
- Bench method, raw numbers, remaining-candidate list: archive/2026-10-24-main-thread-perf.md
- Previous handoff (Cowork scope review, fork.1/fork.2 releases): archive/handoff-2026-10-24-before-main-thread-perf.md

<!-- END AUTO-MEMORY -->
