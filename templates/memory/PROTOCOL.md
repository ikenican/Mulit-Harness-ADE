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

## Storage (memory never goes into the project repository)
- `.project-memory/` and the generated entry files (`AGENTS.md`, `.agents/rules/shared-memory.md`)
  are local to this clone (`.git/info/exclude`). NEVER `git add` them to the project repository,
  not even with `-f`; the `.githooks/pre-commit` guard rejects it.
- Where memory is kept is chosen in Agent Workbench: Settings > Memory sync.
  - Off: `.project-memory/` is a plain folder; the handoff stays on this machine.
  - OneDrive / Google Drive folder: `.project-memory/` links into that folder; the cloud client
    uploads it.
  - Private GitHub repository: `.project-memory/` links into a clone of the user's private memory
    repository; `commit-handoff.sh` commits there and pushes (`MEM_AUTOPUSH=0` skips the push).
- Always save through `bash .project-memory/commit-handoff.sh "<msg>"`; it picks the right case.
  Do not commit or copy memory anywhere by other means.

## Git safety
- `git fetch` is read-only and always allowed. Everything that MUTATES the tree is restricted.
- Committing the user's SOURCE CODE is their decision, not yours.
- Do NOT automatically run `git pull --rebase`, `merge`, `reset`, or force-push on the project. Ever.
- Syncing the private memory repository is done by Agent Workbench and the two memory scripts
  (`status.sh` fast-forwards only with `MEM_AUTOSYNC=1`, a clean memory tree and no divergent
  commits). Do not pull, rebase or push it by hand; if a script reports a conflict, REPORT and ask.
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
1. Rewrite `handoff.md` in the Handoff format below.
2. Update `STATE.md` only if its criteria apply.
3. Append a decision only if its criteria apply.
4. Run relevant tests/validation.
5. Report `git diff --stat`, results, and remaining risk.
6. Save the memory: `bash .project-memory/commit-handoff.sh "<one-line summary>"`, and tell the
   user what it printed (saved locally / saved in the synced folder / committed and pushed / push
   failed). Memory sync off means the handoff stays on this machine - say so; do not work around it.

## Handoff format
`handoff.md` describes the CURRENT state, not a diary. Rewrite it each time with these sections
(`status.sh` warns when one is missing):
- `## State` - Updated (date), Agent, Task, Branch, Commit (`git rev-parse --short HEAD` or
  `Uncommitted`), and what is done.
- `## Verified` - what you actually checked: exact commands and results.
- `## Not verified` - what you did not check or could not run. Never record an unverified pass.
- `## Next` - numbered steps concrete enough to execute without this conversation.
- `## Risks / do not` - open risks, and APIs/files/compatibility constraints not to touch.

## Size policy
- `INDEX.md` tiny (index + rules only, no mutable state).
- `handoff.md` at most 8000 bytes (`status.sh` warns above it; larger tier 1 gets truncated when
  injected). `STATE.md` preferably <=50 lines.
- Before rewriting the handoff, move the previous one's finished-event detail to
  `archive/<YYYY-MM-DD>-<topic>.md` if it is still worth keeping.
- Fidelity over brevity: shorten a file by moving detail into an on-demand file or `archive/`,
  NEVER by deleting facts to hit a line limit.
