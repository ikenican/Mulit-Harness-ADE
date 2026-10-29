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

Then save the memory — use the Handoff format in `PROTOCOL.md` (under 8000 bytes):

```bash
bash .project-memory/commit-handoff.sh "docs(memory): <one-line summary>"
```

It saves according to Agent Workbench: Settings > Memory sync (off: this machine only; OneDrive /
Google Drive folder; or a commit + push to the private memory repository). Tell the user what it
printed.

## Never

Never commit `.project-memory/`, `AGENTS.md` or `.agents/` to the project repository.
Do not auto pull, rebase, merge, reset, or force-push without user authorization.
Do not commit the user's source code on your own initiative.
Never store secrets in project memory. Never rewrite historical decisions — supersede them.
