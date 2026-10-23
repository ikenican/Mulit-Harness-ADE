# Shared Project Memory Protocol

Canonical shared memory lives in `.project-memory/`.

## Concurrency
- One agent at a time: use the normal working directory.
- Multiple agents editing concurrently: use separate Git worktrees.
- Never let two agents write to the same working tree concurrently.
- Worktree branches don't see each other's unmerged memory; the integrator owns the final
  canonical handoff and state.

## Startup (tiered - full fidelity stays on disk, load only what the task needs)
1. Inspect local state: `git status --short`, `git branch --show-current`, `git log -5 --oneline`.
2. TIER 1 (always): `.project-memory/INDEX.md` and `.project-memory/handoff.md`.
   In Claude Code these are auto-injected by the SessionStart hook - do not re-read them.
3. Read this PROTOCOL when: first time in this repo; the task touches Git/branch/merge/worktree/
   memory files; or the rules seem unclear.
4. TIER 2, only when relevant:
   - `STATE.md`: milestones, multi-module work, planning/release, handoff older than 7 days,
     or Git state differs materially from the handoff commit.
   - `DECISIONS.md`: architecture/design changes - read the quick index first, then only the
     matching DEC entry.
   - `KNOWN_ISSUES.md` / `SESSION_LOG.md` / `archive/`: only if directly relevant.
5. Summarise the current state in <=3 bullets before substantial action.
   Do NOT re-explore what is already recorded and still valid.

## Git safety
- `git fetch` is read-only and always allowed. Everything that MUTATES the tree is restricted.
- Committing the SHARED MEMORY is allowed and expected - it is local and reversible
  (`git reset --soft HEAD~1`). Use `bash .project-memory/commit-handoff.sh "<msg>"`, which is
  pathspec-limited to memory files and never sweeps up the user's source changes.
  Committing the user's SOURCE CODE is their decision, not yours.
- Pushing happens only when `MEM_AUTOPUSH=1`. Until pushed, other machines cannot see the handoff -
  say so explicitly when you finish.
- Do NOT automatically run `git pull --rebase`, `merge`, `reset`, or force-push. Ever.
- The ONLY permitted automatic sync is `git pull --ff-only`, and only when ALL hold: auto-sync is
  enabled, the working tree is clean, and the local branch has no divergent commits. A
  non-fast-forward aborts and changes nothing - then REPORT and ask the user.
- If uncommitted changes exist, inspect them; never overwrite blindly.

## Working
- Source code and tests override stale memory. If memory conflicts with code, flag it and fix the
  memory once verified.
- Prefer small, reversible changes. Don't overwrite another agent's uncommitted work.
- Never store credentials, passwords, API keys, tokens, certificates, or private keys.

## When memory updates are REQUIRED (thresholds - these prevent churn)
Update `handoff.md` if ANY is true:
- Source, tests, config, scripts, or meaningful docs changed.
- Work is incomplete and another agent could continue it.
- Test results, environment assumptions, dependencies, or known risks changed.
- The user made a decision affecting future work.

Update `STATE.md` ONLY when a milestone, macro status, major blocker, or cross-module plan changed.
Append to `DECISIONS.md` ONLY for a durable architectural/technical decision (never rewrite old
ones; add a superseding decision instead).

Do NOT update memory for: read-only questions, trivial explanations, no-change reviews, or failed
exploration with no reusable result.

## Completion (when an update is required)
1. Update `handoff.md`.
2. Update `STATE.md` only if its criteria apply.
3. Append a decision only if its criteria apply.
4. Run relevant tests/validation.
5. Report `git diff --stat`, results, and remaining risk.
6. Commit the memory yourself: `bash .project-memory/commit-handoff.sh "<one-line summary>"`.
   This is what makes the handoff reach the other agents and the other machines - a handoff that
   is never committed does not exist for anyone else. Report whether it was pushed.

## Handoff format
`handoff.md` uses these sections, in this order. `status.sh` warns when one is missing.

```
# Latest Handoff
- Agent / Updated (date, Asia/Taipei) / Branch / HEAD commit
## State          - what is true now: branch, commit, clean or dirty tree, what is merged or released
## Verified       - each check that was actually run, as `command -> result`
## Not verified   - what was NOT run or could not be run, and why (write "none" if truly none)
## Next           - the next concrete step(s) for whoever continues
## Risks / do not - known risks, and actions the next agent must not take
## Details        - links to archive/ files holding the full record
```

Precision rule: the next agent must be able to act on Tier 1 alone. Keep everything it needs
(exact branch, commit, commands, what is unverified). Move what only documents a finished event
(asset sizes, hashes, temp paths, PIDs, log file names) to `archive/` and link it under Details.
Keep `handoff.md` under 8000 bytes (roughly 2,500 tokens) so a context-injection hook can load it
whole instead of truncating it.

## Size policy
- `INDEX.md` tiny (index + rules only, no mutable state).
- `handoff.md` / `STATE.md` preferably <=50 lines.
- Fidelity over brevity: shorten a file by moving detail into an on-demand file or `archive/`,
  NEVER by deleting facts to hit a line limit.
