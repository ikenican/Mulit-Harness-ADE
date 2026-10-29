# Project Memory Index

## Read at every session start (tier 1)
1. Read this file.
2. Read `handoff.md`.

## Read on demand (tier 2 - full detail lives here)
- `STATE.md`     - milestones, cross-module progress, blockers, planning.
- `DECISIONS.md` - durable architecture/technical decisions (check the quick index first,
                   then load only the matching DEC entry).
- `PROTOCOL.md`  - full working protocol; read on first entry to this repo, when the task
                   touches Git/worktree/memory files, or when rules seem unclear.
- `KNOWN_ISSUES.md` / `SESSION_LOG.md` / `archive/` - history and known issues, if created.

## Rules
- `.project-memory/` is the canonical cross-agent memory.
- Source code and tests override stale memory.
- Never store secrets. Mark uncertain content `Unverified`; date changing facts.
- This file holds NO mutable state - no commit hashes, dates, or status.
  All changing state lives in `handoff.md` only.
