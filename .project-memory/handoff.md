# Latest Handoff

- Agent: Claude Code (local, user's Windows 11 PC, D:\AI_Project\Mulit-Harness-ADE)
- Updated: 2026-10-24 Asia/Taipei
- Branch: improve/accuracy-handoff; code HEAD 59de84b (+ this memory commit). Local commits 8d8ddba..59de84b are NOT pushed; origin/improve/accuracy-handoff is still ccca94e. Not merged into master.

## State
- 64ac1fe: CLI detection without blocking main. `findCliAsync`/`findAgentCliAsync` (src/main/ext/paths.ts) use execFile + fs.promises with the same selection rules as `findCli`. Async users: Cowork capabilities, ext:agents, Settings CLI test. The Cowork `--help` flag probe is execFile instead of spawnSync, and concurrent calls share one in-flight probe. `resolveCli`/`resolveExecCli` may return a Promise; the executor registers its AbortController before awaiting. Sync `findCli` (terminal spawn) reuses a found path for 5 min after re-checking that it exists; not-found is never cached.
- d2dff07: dashboard scanning runs in a worker thread. Scanners moved verbatim (only exports changed) from dashboard.ts to `src/main/ipc/sessionScan.ts`; it and `usage.ts` no longer import Electron. `dashboardWorker.ts` (electron-vite `?nodeWorker`) serves `dashboard:data` and `dashboard:usage`; if the worker cannot start or fails, the same functions run on main. State and active PTYs are read after the scan; concurrent non-forced requests share one scan. Archive/delete/unmark use the cached-session snapshot returned by the worker.
- 9a336a1: Codex install. Windows: official script → `winget install --id OpenAI.Codex -e` → npm → message. macOS/Linux: the script is downloaded first, and npm is used if the download or the script fails (`curl | sh` used to exit 0 on a 404). chatgpt.com/codex/install.ps1, install.sh and releases.openai.com/codex all returned 404 on 2026-10-24, even though the Codex README still lists them.
- scripts/bench-main-blocking.cjs (8d8ddba, 0cedbb0, 59de84b): measures main-thread blocking as real IPC round trips (see Details).
- Nothing released; package.json still 0.1.41; apps/linux untouched (DEC-011). package-lock.json was restored after npm 11 rewrote "peer" flags (not committed).

## Verified
- `npm run typecheck` -> pass (after each change)
- `node --experimental-strip-types scripts/check-{cowork,version,usage,bgTasks,portDetect,hosts,remote,remote-files}.mts` -> all pass; `node scripts/check-approval.cjs` -> pass; `node scripts/check-custom-agent.cjs` -> pass
- `node_modules/.bin/electron scripts/check-{cowork-tabs,terminal-ui,remote-cowork,custom-agent-ui}.cjs` -> all pass on Windows (first run on Windows)
- `npm run build` -> pass; out/main has dashboardWorker-*.js and sessionScan-*.js
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
- Ask the user before pushing improve/accuracy-handoff (8 local commits) and before releasing `release/0.1.41-fork.3` (would include the npm fallback, winget, async CLI detection, scan worker).
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
