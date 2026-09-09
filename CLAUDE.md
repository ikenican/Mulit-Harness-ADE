
## Shared project memory

Canonical cross-agent memory is `.project-memory/`.

Tier-1 memory (`INDEX.md` + `handoff.md`) is auto-injected at session start by the
shared-project-memory plugin. If it is present in your context, do NOT re-read those files.
If it is absent (plugin not installed), run `bash .project-memory/status.sh` yourself — the same
command Codex and Antigravity use.

Before substantial work:
1. Have `.project-memory/INDEX.md` and `.project-memory/handoff.md` in context.
2. Inspect `git status --short` and `git branch --show-current`.
3. Summarise the current context in <=3 bullets.
4. Read `.project-memory/PROTOCOL.md` on first entry, for Git/worktree/merge work, for memory
   changes, or when rules are unclear.
5. Read `STATE.md` / `DECISIONS.md` only when the task needs macro status or architecture history.

Before finishing, apply the memory-update criteria in `PROTOCOL.md` — update `handoff.md` when the
work meets the threshold, and skip it for read-only or trivial sessions.

Do NOT auto pull/rebase/merge/reset/push without user authorization. `git fetch` is fine.
