# Latest Handoff

- Agent: Claude (claude.ai cloud session)
- Updated: 2026-10-24 Asia/Taipei
- Branch: improve/accuracy-handoff, based on master b179d70 (v0.1.41 release memory commit). Pushed to origin (ikenican/Mulit-Harness-ADE) as branch improve/accuracy-handoff; not merged into master.

## State
- Commit 245cac4 on the branch: Cowork execution holds out-of-scope changes (task stops as blocked; user reverts, accepts or follows up), skips the node_modules junction when any task scope touches package.json/lockfile/node_modules, passes a structured `cowork-result` handoff plus Git changed-file list to dependent tasks, requires `assignmentReason` on model-generated tasks, and shows the chair's R1 participant assumptions.
- Memory/docs commit (this handoff): PROTOCOL.md "Handoff format" section; status.sh warns on missing handoff sections or >8000 bytes; cowork.md status banner listing superseded sections; README (EN/zh) and docs/cowork-architecture.md describe the new execution behavior.
- Commit e35392e: fork builds are versioned `<upstream>-fork.<n>`. Packaged package.json carries `updateRepo` (fork) and `upstreamRepo`; autoUpdater and the API fallback follow the fork, and Settings > About shows a Fork badge plus an upstream notice row (never installs upstream). `src/shared/version.ts` + `scripts/check-version.mts`.
- `.github/workflows/fork-release.yml`: pushing branch `release/<x.y.z>-fork.<n>` (x.y.z must equal package.json version) builds on windows-latest, runs typecheck/check-cowork/check-version, packages, checks latest.yml and node-pty files, publishes release `v<version>`, deletes the trigger branch. Tags cannot be pushed from the cloud session; branches can.
- Released v0.1.41-fork.1 from e35392e (run 40011071236, all steps green): setup.exe, blockmap, portable ZIP, latest.yml. Portable ZIP inspected: app-update.yml owner ikenican; package.json updateRepo/upstreamRepo set; win32 conpty .node files unpacked.
- Commit 3e798ed: Settings > CLI "Install" no longer spawns a hidden `powershell -ExecutionPolicy Bypass -Command "irm … | iex"` (Defender flagged it as Trojan:Win32/Commando.A!ml on the user's PC). It opens a new PowerShell/bash tab, pastes the official command after the shell settles, and the user presses Enter; `ext:installAgent`/`installCodex` IPC and the npm fallback were removed. Released as v0.1.41-fork.2 via `release/0.1.41-fork.2`.
- Next commit after fork.2: Windows install commands for Claude Code and Codex wrap the official script in try/catch and fall back to `npm install -g` (user got 404 from chatgpt.com/codex/install.ps1 on 2026-10-24). Not released yet; PowerShell syntax not executed (no pwsh in the sandbox).
- Windows v0.1.41 remains the latest release; nothing was released or version-bumped. apps/linux untouched (DEC-011).

## Verified
- `npm run typecheck` -> pass
- `node --experimental-strip-types scripts/check-cowork.mts` -> pass, including new pure tests and the e2e "scope review, structured handoff and dependency linking" scenario (fake CLIs)
- `check-portDetect`, `check-usage`, `check-bgTasks`, `check-hosts`, `check-remote`, `check-remote-files` (.mts) -> pass; `node scripts/check-approval.cjs` -> pass
- `npm run build` -> pass (main, preload, renderer)

## Not verified
- Electron-based checks (`check-custom-agent.cjs`, `check-cowork-tabs.cjs`, `check-terminal-ui.cjs`, `check-remote-cowork.cjs`, `check-custom-agent-ui.cjs`): the Electron binary could not be installed in the cloud sandbox. The new desktop/phone UI (scope review card, assumptions list, assignment reason, result details) was never rendered.
- The visible-terminal install flow was not run on Windows (paste timing in a fresh PowerShell, Defender behavior).
- The installed fork build was not run: the in-app update from one fork release to the next, and the upstream notice, have not been exercised.
- No real Claude/Codex/Antigravity meeting was run; whether real agents emit the `cowork-result` block and fill `assignmentReason` well is unknown. Missing blocks are tolerated (no result stored); an empty reason triggers one repair call.
- Windows-specific behavior of `revertFiles` (case-insensitive paths, junctions) not run.

## Next
- Owner: install v0.1.41-fork.1, check Settings > About (Fork badge, upstream row), run one Cowork Project + execution. Next fork release: push `release/0.1.41-fork.2`.
- Owner: run the Electron checks on Windows, open one Project meeting and one execution, and look at the new cards.
- Then plan items not started: agent profile settings (user-written strengths), real SessionStart hooks for Codex (`.codex/hooks.json`) and Antigravity after confirming `agy` supports SessionStart, drag-handoff reading CLI session logs, per-meeting token totals, unknown-schemaVersion read-only view, re-testing planning flags on current CLI versions.

## Risks / do not
- A Windows build cannot be made in the Linux cloud sandbox: only the linux-x64 node-pty prebuilt is installed and wine is unavailable; a cross-built installer would ship without the Windows terminal binary.
- Scope matching is case-insensitive and treats a scope entry without "/" as file or directory; an empty scope flags every change. Tasks the chair scoped too narrowly will now stop more often.
- Runs saved before this change have no assignmentReason/assumptions/result fields; UI hides them when absent.
- Do not push or merge without the user's go-ahead.

## Details
- Previous handoff (v0.1.41 release verification detail): archive/handoff-2026-10-16-v0.1.41-release.md
