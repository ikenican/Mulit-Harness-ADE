# Main-process blocking work and remaining performance candidates (2026-10-24, Windows 11, local)

## How it was measured
`node_modules/.bin/electron scripts/bench-main-blocking.cjs scan|cli [--touch] [--json out.json]`
- Bundles the real IPC handlers from src/ with esbuild (only src/main/index.ts is stubbed), runs them in Electron,
  and a hidden renderer pings main over real IPC (`ipcRenderer.invoke`) every 5 ms while each handler runs.
  "ipc max" = longest round trip = how long the UI could not get an IPC answer.
- `scan`: fake home in %TEMP%\wb-bench\home (300 Claude jsonl ~150 KB, 200 Codex rollouts ~150 KB,
  50 Antigravity transcripts ~100 KB). Session status depends on log age, so before/after must be paired;
  `WB_BENCH_SRC=<worktree of the earlier commit>` bundles that checkout, and touching the fixture once before
  alternating runs keeps both sides on the same mtimes.
- `cli`: real home (claude.exe and agy.exe installed, codex not installed).

## Results (worst IPC round trip, ms)
| step | before | after |
|---|---|---|
| dashboard:data, cold cache | 525-535 | 0.4-1.4 |
| dashboard:data, warm | 60-72 | 0.3-1.9 |
| dashboard:usage, warm | 11-14 | 0.2-0.6 |
| ext:agents | 90-102 | 1-14 |
| cowork:capabilities, first (spawnSync --help) | 279-293 | 2.6-4.1 |
| cowork:capabilities, probes cached | 84-87 | 1.9-6.3 |

- dashboard:data wall time: cold ~530 -> ~570 ms (worker start + structured clone), warm unchanged (~70 ms).
- Paired scan runs (3 x before/after, same fixture mtimes): all 12 dashboard:data/usage results byte-identical
  (204,462 bytes, 350 sessions). CLI runs: ext:agents identical; cowork:capabilities identical except the git dirty list.
- findCli vs findCliAsync on this PC: identical for claude, agy, codex (null), node, npm, git, powershell, cmd,
  where, a missing name, and findAgentCli for all three agents.
- Built app packed into an asar (out/ + package.json) and run with the repo Electron: renderer
  `api.dashboard.data(true)` returned 350 sessions, no worker fallback logged, caches written by the worker.
  `npx electron-builder --dir` itself failed: winCodeSign extraction needs symlink privilege on this account.

## Remaining candidates (not changed; ordered by expected impact)
1. Dashboard re-reads whole active session files. DashboardPanel polls dashboard:data every 5 s (+ twice when agent
   tabs open/close). An active session's mtime changes constantly, so its whole .jsonl is read and parsed again
   (session details in sessionScan.ts and usage in usage.ts) on every poll. Now off the main thread, but it still costs
   CPU, disk and memory. Fix: incremental parse from the last byte offset (logs are append-only).
2. Accuracy: usage.ts gives files > 64 MB zero tokens (guard against whole-file readFileSync). A streaming line reader would
   count them and also remove the memory spike.
3. unmarkDeletedOrArchivedWorkspace (dashboard.ts) runs on the main thread on every workspace open/add
   (setOnRecentWorkspaceAdded, files:setWorkspaceRoot): readdir of every ~/.claude/projects dir plus head/tail reads of
   every Antigravity transcript. Grows with history. Candidate to move into the scan worker.
4. loadSettings() has no cache: each call reads and JSON-parses the global and workspace settings.json. It is called from
   isCliEnabled (several times per dashboard scan, inside the PTY loop), getCustomCliPath (every CLI lookup),
   isCliBypassPermissions, PTY spawn, cowork. Fix: cache keyed by mtime, cleared by saveSettings.
5. Cowork writeJsonAtomic (cowork/store.ts): every save is write + fsync + copy .prev + rename on the main thread, and its
   EPERM/EBUSY retry sleeps with Atomics.wait (up to 25+50+...+150 = 525 ms blocked) when antivirus holds the file.
   Fix: async coalescing write queue.
6. scanBgTasks: polled every 4 s by the Vibe Status pane and by each phone's 'status' request; readdir + stat + reads up to
   30 Codex rollouts. Bench: 27.5 ms blocked cold, 2.4 ms warm. Candidate for the worker.
7. Terminal tabs: pty.ts resolveCommand still uses sync findCli. A found path is reused for 5 min, but a CLI that is not
   installed is looked up again (where + ~25 stats) on every tab open and every listLaunchers call. Fix: async spawn
   path or warm the cache at startup.
8. Smaller: runner.ts kills process trees with execFileSync('taskkill') (main thread, on cancel only);
   remote/files.ts serves phone file views with sync reads; orchestrator init scans the run directory synchronously at startup.
