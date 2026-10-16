# Latest Handoff

- Agent: Claude Code
- Updated: 2026-10-14 Asia/Taipei
- Branch: feat/phone-cowork-parity (source commit 0ad67ea), pushed; PR #44 open against master (https://github.com/zkylek1212-k/Mulit-Harness-ADE/pull/44). Not merged, not released. User authorised commit/push/PR on 2026-10-14.
- Task: the user asked that phone Cowork offer the same options as desktop, and that Cowork open from the terminal's "new" menu instead of being a separate tile.

## Done this session (in PR #44)
- Phone entry point: removed the per-workspace Cowork tile (`src/renderer/remote/App.tsx`); the "New Terminal" sheet now has a Cowork section (`onCowork` → existing `cowork` view), same as the desktop terminal "+" popover.
- Phone new-meeting form (`src/renderer/remote/CoworkView.tsx`) now matches desktop StartForm: mode description, per-agent unavailable reason + agy slow hint, Make Chair, per-agent model + effort selects (via the `models` op), recorder + summary timing (discussion), auto-effort switch, project baseline (branch@commit, dirty files, warnings), limits line, per-mode start label, "Open It" for `active-run-exists`. Start now sends models/autoEffort/summarizer/summarizeEachRound like desktop.
- Phone run screen: recorder select in discussions, "Skip {name}" on a failed speaker, "Turn into Project Plan" after a conclusion (uses `discussionProjectPrompt`), Delete Meeting for finished runs.
- Bug fix: the phone `call()` treated ops that return nothing (raiseLimits, delete…) as failures, so "Raise Limits and Retry" never retried. Now success returns null.
- `capabilities` op (`src/main/ipc/cowork.ts`) `defaults` also carries models, summarizer, summarizeEachRound and limits.
- Model/effort rules extracted to `modelPickerState` / `pickModel` in `src/shared/cowork.ts`; the desktop `ModelPicker.tsx` uses them too (same behaviour).
- Desktop and phone Claude model names: in Claude Code 2.1.296, `displayName` holds the name ("Opus 5.5") and `description` holds only the blurb, so `parseClaudeModelCatalog` showed the blurb as the name. It now takes the name from `description` only when it contains " · " (old format), otherwise from `displayName`. A test for the new format was added to check-cowork.mts and verified against real CLI output.
- `scripts/check-remote-cowork.cjs`: opens Cowork through the New Terminal sheet, asserts no tile, checks the new options and start args, skip speaker, raise→retry, and delete. The fake desktop now omits `data` for void ops like the real one.

## Validation
- `npm run typecheck`, `npm run build`, `electron scripts/check-remote-cowork.cjs`, `check-cowork.mts`, `check-remote.mts` all pass.
- Screenshots: `check-remote-cowork.cjs` runs with `show: false`, so its screenshots are stale frames. A copy with `show: true` gave correct shots of the sheet and form.
- Not tested on a real iPhone.

## Next / limits
- Next: review/merge PR #44 (needs user OK), then a release if wanted. Local master still has the two memory commits 1c8c677/e5b32f2 unpushed; they are also on the PR branch, so merging the PR brings them in.
- Running Cowork meetings no longer have a home-screen entry; reach them via New Terminal → Cowork (list). Could list active meetings in the workspace group if wanted.
- Board editing remains desktop-only. Not ported to apps/linux (DEC-011 manual port).
- Long effort labels truncate in the narrow selects ("Automatic (l…").
- Carry-over from 2026-10-09 (still valid): temp worktree `C:/Users/milan.chang/AppData/Local/Temp/agent-workbench-test-pr35-37` has 19 modified + 1 untracked files (not 5); `.git` has OneDrive conflict copies (`index-GG5275-NB`, `FETCH_HEAD-GG5275-NB*`); `.project-memory/handoff-GG5275-NB.md` is a stale 2026-09-17 conflict copy. Git status works normally again on this machine.
- History: archive/handoff-2026-10-14-before-phone-cowork-parity.md.
