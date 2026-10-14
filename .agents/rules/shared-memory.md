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

- Agent: Claude Code
- Updated: 2026-10-14 Asia/Taipei
- Branch: master (da12ebf), source changes UNCOMMITTED in the main workspace. Not released.
- Task: the user asked that phone Cowork offer the same options as desktop, and that Cowork open from the terminal's "new" menu instead of being a separate tile.

## Done this session (uncommitted)
- Phone entry point: removed the per-workspace Cowork tile (`src/renderer/remote/App.tsx`); the "New Terminal" sheet now has a Cowork section (`onCowork` → existing `cowork` view), same as the desktop terminal "+" popover.
- Phone new-meeting form (`src/renderer/remote/CoworkView.tsx`) now matches desktop StartForm: mode description, per-agent unavailable reason + agy slow hint, Make Chair, per-agent model + effort selects (via the `models` op), recorder + summary timing (discussion), auto-effort switch, project baseline (branch@commit, dirty files, warnings), limits line, per-mode start label, "Open It" for `active-run-exists`. Start now sends models/autoEffort/summarizer/summarizeEachRound like desktop.
- Phone run screen: recorder select in discussions, "Skip {name}" on a failed speaker, "Turn into Project Plan" after a conclusion (uses `discussionProjectPrompt`), Delete Meeting for finished runs.
- Bug fix: the phone `call()` treated ops that return nothing (raiseLimits, delete…) as failures, so "Raise Limits and Retry" never retried. Now success returns null.
- `capabilities` op (`src/main/ipc/cowork.ts`) `defaults` also carries models, summarizer, summarizeEachRound and limits.
- Model/effort rules extracted to `modelPickerState` / `pickModel` in `src/shared/cowork.ts`; the desktop `ModelPicker.tsx` uses them too (same behaviour).
- `scripts/check-remote-cowork.cjs`: opens Cowork through the New Terminal sheet, asserts no tile, checks the new options and start args, skip speaker, raise→retry, and delete. The fake desktop now omits `data` for void ops like the real one.

## Validation
- `npm run typecheck`, `npm run build`, `electron scripts/check-remote-cowork.cjs`, `check-cowork.mts`, `check-remote.mts` all pass.
- Screenshots: `check-remote-cowork.cjs` runs with `show: false`, so its screenshots are stale frames. A copy with `show: true` gave correct shots of the sheet and form.
- Not tested on a real iPhone.

## Next / limits
- The user has not yet decided to commit, push or release this.
- Running Cowork meetings no longer have a home-screen entry; reach them via New Terminal → Cowork (list). Could list active meetings in the workspace group if wanted.
- Board editing remains desktop-only. Not ported to apps/linux (DEC-011 manual port).
- Long effort labels truncate in the narrow selects ("Automatic (l…").
- Carry-over from 2026-10-09 (still valid): temp worktree `C:/Users/milan.chang/AppData/Local/Temp/agent-workbench-test-pr35-37` has 19 modified + 1 untracked files (not 5); `.git` has OneDrive conflict copies (`index-GG5275-NB`, `FETCH_HEAD-GG5275-NB*`); `.project-memory/handoff-GG5275-NB.md` is a stale 2026-09-17 conflict copy. Git status works normally again on this machine.
- History: archive/handoff-2026-10-14-before-phone-cowork-parity.md.

<!-- END AUTO-MEMORY -->
