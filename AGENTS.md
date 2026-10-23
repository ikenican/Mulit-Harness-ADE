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

- Agent: Claude (claude.ai cloud session)
- Updated: 2026-10-24 Asia/Taipei
- Branch: improve/accuracy-handoff, based on master b179d70 (v0.1.41 release memory commit). Pushed to origin (ikenican/Mulit-Harness-ADE) as branch improve/accuracy-handoff; not merged into master.

## State
- Commit 245cac4 on the branch: Cowork execution holds out-of-scope changes (task stops as blocked; user reverts, accepts or follows up), skips the node_modules junction when any task scope touches package.json/lockfile/node_modules, passes a structured `cowork-result` handoff plus Git changed-file list to dependent tasks, requires `assignmentReason` on model-generated tasks, and shows the chair's R1 participant assumptions.
- Memory/docs commit (this handoff): PROTOCOL.md "Handoff format" section; status.sh warns on missing handoff sections or >8000 bytes; cowork.md status banner listing superseded sections; README (EN/zh) and docs/cowork-architecture.md describe the new execution behavior.
- Commit 4d8e2f4 adds `.github/workflows/fork-release.yml`: on a pushed tag `fork-v<version>` (or manual run), builds on windows-latest, runs typecheck + check-cowork, packages with `publish.owner` overridden to the fork, and publishes setup.exe, blockmap, portable ZIP and latest.yml as a GitHub prerelease. Never run yet. Intended first tag: `fork-v0.1.42-fork.1` (the cloud session's git proxy refused to push tags).
- Windows v0.1.41 remains the latest release; nothing was released or version-bumped. apps/linux untouched (DEC-011).

## Verified
- `npm run typecheck` -> pass
- `node --experimental-strip-types scripts/check-cowork.mts` -> pass, including new pure tests and the e2e "scope review, structured handoff and dependency linking" scenario (fake CLIs)
- `check-portDetect`, `check-usage`, `check-bgTasks`, `check-hosts`, `check-remote`, `check-remote-files` (.mts) -> pass; `node scripts/check-approval.cjs` -> pass
- `npm run build` -> pass (main, preload, renderer)

## Not verified
- Electron-based checks (`check-custom-agent.cjs`, `check-cowork-tabs.cjs`, `check-terminal-ui.cjs`, `check-remote-cowork.cjs`, `check-custom-agent-ui.cjs`): the Electron binary could not be installed in the cloud sandbox. The new desktop/phone UI (scope review card, assumptions list, assignment reason, result details) was never rendered.
- No real Claude/Codex/Antigravity meeting was run; whether real agents emit the `cowork-result` block and fill `assignmentReason` well is unknown. Missing blocks are tolerated (no result stored); an empty reason triggers one repair call.
- Windows-specific behavior of `revertFiles` (case-insensitive paths, junctions) not run.

## Next
- Owner: enable Actions on the fork if prompted, then push the tag from a local clone (`git fetch origin && git tag fork-v0.1.42-fork.1 origin/improve/accuracy-handoff && git push origin fork-v0.1.42-fork.1`) and check the run.
- Owner: run the Electron checks on Windows, open one Project meeting and one execution, and look at the new cards.
- Then plan items not started: agent profile settings (user-written strengths), real SessionStart hooks for Codex (`.codex/hooks.json`) and Antigravity after confirming `agy` supports SessionStart, drag-handoff reading CLI session logs, per-meeting token totals, unknown-schemaVersion read-only view, re-testing planning flags on current CLI versions.

## Risks / do not
- A Windows build cannot be made in the Linux cloud sandbox: only the linux-x64 node-pty prebuilt is installed and wine is unavailable; a cross-built installer would ship without the Windows terminal binary.
- Scope matching is case-insensitive and treats a scope entry without "/" as file or directory; an empty scope flags every change. Tasks the chair scoped too narrowly will now stop more often.
- Runs saved before this change have no assignmentReason/assumptions/result fields; UI hides them when absent.
- Do not push or merge without the user's go-ahead.

## Details
- Previous handoff (v0.1.41 release verification detail): archive/handoff-2026-10-16-v0.1.41-release.md

<!-- END AUTO-MEMORY -->
