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

- Agent: Codex
- Updated: 2026-10-16 Asia/Taipei
- Branch: master. Windows v0.1.41 PUBLISHED and marked Latest: https://github.com/zkylek1212-k/Mulit-Harness-ADE/releases/tag/v0.1.41. Annotated tag v0.1.41 points to release merge commit 1c7cf17c1fe0d9bfc995405e54b8ab65482e6b99.
- User explicitly authorized merging both PRs and releasing a new version. PR #44 merged as 2bbdd37, #45 as 9f256da, release/version/docs PR #46 as 1c7cf17. No open PRs at verification. Linux remains independent linux-v0.1.0 prerelease; not changed.

## Included / integration
- Phone Cowork now opens via New Terminal → Cowork and matches desktop model/effort/chair/recorder/summary/baseline/limits choices. Includes skip failed speaker, raise-budget retry, conclusion-to-Project and delete finished meetings; fixes void-op success handling and current Claude model labels.
- Default-off Customize Agent: one custom harness name/command/args; enabled-only desktop/phone terminal launch and prompt dispatch. Native Skills/Plugins directories plus MCP/Hooks file creation/editing under Settings → Extensions; global-only settings, backups, conflict/JSON/UTF-8/size/path/link checks. No provider default/bypass flags injected.
- Merging #44 into #45 caused only handoff/generated-entry conflicts. Resolved these, verified application source exactly equals local test/pr-44-45 integration, pushed #45, then merged it. Release PR #46 changes root package/lock to 0.1.41 plus bilingual CHANGELOG and current phone Cowork README instructions.
- Local master fast-forwarded to origin/master; previous local memory commits are retained through the PR history. Local test/pr-44-45 (1797a31, merge 386328d) remains available; feature/release branches kept.

## Release assets / checks
- Published four assets: Agent-Workbench-0.1.41-setup.exe (130282013 bytes), Agent-Workbench-0.1.41-portable.zip (178194759 bytes), setup.exe.blockmap (135815 bytes), latest.yml (362 bytes).
- Built on release source 6a1e2e4; tagged master source equivalence checked before publication. EXE file/product versions 0.1.41 / 0.1.41.0; packed package.json version 0.1.41.
- npm run typecheck and npm run dist passed. Used existing scripts/release.ps1 -SkipBuild -Draft after packaging, verified uploaded assets, then gh release edit --draft=false --latest. GitHub reports public, non-prerelease Latest v0.1.41, published 2026-10-16T07:03:58Z.
- All four uploaded asset sizes and GitHub SHA256 digests match local files. latest.yml version, installer URL/size and both SHA512 fields match the installer. Portable ZIP has 98 entries; executable, ASAR and native PTY binary hashes match win-unpacked.
- node scripts/check-custom-agent.cjs, node scripts/check-approval.cjs, node --experimental-strip-types scripts/check-remote.mts passed.
- electron scripts/check-remote-cowork.cjs and electron scripts/check-custom-agent-ui.cjs passed on 0.1.41 build; UI shots in C:/Users/milan.chang/AppData/Local/Temp/workbench-custom-ui-Gvdjzh.
- Packaged ASAR smoke passed: renderer/preload startup, isolated settings, opt-in custom launcher and real Windows native PTY I/O. Temporary harness: %TEMP%/workbench-v0.1.41-packaged-smoke.js. Prior combined-source check-cowork.mts suite passed during local testing; application code unchanged since that test.
- Logs/checks: %TEMP%/workbench-v0.1.41-dist.log, workbench-v0.1.41-publish.log, workbench-v0.1.41-assets.json, workbench-v0.1.41-verify.cjs. No release-script source changes or new dependencies.

## Next / limits
- Existing Windows installations can use Check for Updates or download the setup/portable asset. No local installed app was closed, upgraded or reconfigured during release.
- No paid/real provider meeting, third-party custom harness, physical iPhone or full NSIS install was tested. One custom harness slot; native formats/discovery remain the harness's responsibility. Cowork/provider history/token telemetry stay with the original three CLIs; phone board editing stays desktop-only. Linux unchanged per DEC-011.
- Test-profile remote config remains isolated in agent-workbench-dev, disabled by default on port 47610; installed profile previously used 47600. Test app PID 19480 had exited before release preparation.
- Pre-existing untracked Temp/ and three phone screenshots were preserved and excluded. Previous master handoff archived at archive/handoff-2026-10-16-before-v0.1.41-release.md; detailed local-test handoff remains on test/pr-44-45.

<!-- END AUTO-MEMORY -->
