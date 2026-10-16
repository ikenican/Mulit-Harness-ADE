# Shared Project Memory

This workspace uses `.project-memory/` as the canonical cross-agent memory.

## Startup — run this ONE command first, every session

```bash
bash .project-memory/status.sh
```

It prints tier-1 memory (`INDEX.md` + `handoff.md`) and reports remote drift. Do not read those two
files separately — you already have their contents.

Then inspect `git status --short` and `git branch --show-current`, and summarise the context in
<=3 bullets before substantial work. Read `.project-memory/PROTOCOL.md` on first entry to this repo,
for Git/worktree work, for memory changes, or when uncertain. Read `STATE.md` and `DECISIONS.md`
only on demand.

## Before finishing

Apply the memory-update criteria in `PROTOCOL.md`. Rewrite `handoff.md` when the work meets the
threshold; skip memory updates for read-only questions and trivial, no-change work.

Then commit the memory yourself — an uncommitted handoff does not exist for anyone else:

```bash
bash .project-memory/commit-handoff.sh "docs(memory): <one-line summary>"
```

It is pathspec-limited to memory files, so staged source changes are left untouched. It pushes only
when `MEM_AUTOPUSH=1`; otherwise say clearly that the handoff is not pushed yet.

## Never

Do not auto pull, rebase, merge, reset, or force-push without user authorization.
Do not commit the user's source code on your own initiative — committing shared memory is fine.
Never store secrets in project memory. Never rewrite historical decisions — supersede them.

<!-- BEGIN AUTO-MEMORY (generated from .project-memory/handoff.md - do not edit) -->

## Current shared memory (tier 1 - auto-generated, do not edit here)

You already have the current handoff below. Do NOT re-read `.project-memory/handoff.md`.
Read `STATE.md` / `DECISIONS.md` / `PROTOCOL.md` only on demand.
For the freshest copy plus a remote-drift check, run `bash .project-memory/status.sh`.

---

# Latest Handoff

- Agent: Codex
- Updated: 2026-10-15 Asia/Taipei
- Branch: feat/custom-agent; source commit 8ead826, pushed. PR #45 open against master: https://github.com/zkylek1212-k/Mulit-Harness-ADE/pull/45. Not merged or released. User requested a new PR for an opt-in custom harness and matching extension management.
- Branch starts at origin/master; does not include phone Cowork parity PR #44, which remains open separately: https://github.com/zkylek1212-k/Mulit-Harness-ADE/pull/44.

## Done
- Settings → CLI & Agents → Customize Agent: defaults off; optional display name, executable/command, one-argument-per-line args, executable browse/test, native Skills/Plugins directory and MCP/Hooks file paths. Disabled hides configuration fields, terminal launch/dispatch choices and custom extension editor; existing sessions and config/files are preserved.
- Terminal launchpad, + menu and prompt dispatcher show the enabled custom harness. Phone New Terminal lists it via the existing shared launchers/PTY route. Global enable/config changes refresh other desktop windows and connected phones.
- Settings → Extensions has a gated native editor with Skills/MCP/Plugins/Hooks categories and file creation/editing. Uses the user's actual harness paths and format, not guessed adapters. File I/O checks disabled state, relative path boundaries, symbolic links, UTF-8/1 MB limit, JSON syntax, external edits and backup destination hard links. Writes preserve a .workbench-backup; new-file creation does not overwrite existing files.
- Executable/args/paths/opt-in only read from global userData; customAgent is omitted from workspace settings. Repository launcher IDs cannot impersonate custom-agent. Custom harnesses receive their own args without provider-specific bypass/default flags. Global settings write failures now propagate to the UI.
- New shared customAgent types, preload IPC contract and native resource helper; no new dependencies. Existing AgentId/Cowork/provider parsers remain unchanged. README includes English/Traditional Chinese usage and limits.

## Validation
- npm run typecheck and npm run build passed on final source.
- node scripts/check-custom-agent.cjs passed: persisted settings isolation, opt-in, real phone launcher filtering, direct/launcher PTY args, Windows script prefixes and spaced args, four resource types, backup/conflict/JSON/path/link checks.
- electron scripts/check-custom-agent-ui.cjs passed: actual React settings save, enable/hide, terminal launch, all four extension editors, draft switch protection, English/Traditional Chinese and light/dark screenshots.
- node scripts/check-approval.cjs, electron scripts/check-terminal-ui.cjs and node --experimental-strip-types scripts/check-remote.mts passed. Existing PTY test fixtures updated for new shared import.
- UI screenshots inspected in C:/Users/milan.chang/AppData/Local/Temp/workbench-custom-ui-j2XaG9 (settings.png and extensions language/theme variants).

## Next / limits
- Review/merge PR #45 when authorized. One custom harness slot; native extension editing only, no generic marketplace installer or format conversion. Paths must match the harness's own discovery rules. Browse up to six directory levels/500 files; edit UTF-8 text up to 1 MB.
- No real third-party harness or physical iPhone tested. Cowork, provider history and token telemetry stay with the three built-in CLIs. Linux app unchanged per DEC-011.
- User's pre-existing untracked Temp/ and phone view bug.png / phone view_bug1.png / phone view_bug2.png were preserved and excluded from commits.
- Previous phone Cowork work and its validation/limits remain on feat/phone-cowork-parity (PR #44, source 0ad67ea, memory 40a63ab). Do not merge it automatically.

<!-- END AUTO-MEMORY -->
