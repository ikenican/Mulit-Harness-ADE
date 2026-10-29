---
description: Run the completion protocol — write the handoff and update shared memory if the work meets the threshold
---

Run the shared-project-memory completion protocol for the work done in this session.

**First, check the update threshold.** Update memory only if ANY of these is true:
- Source, tests, config, scripts, or meaningful docs changed.
- Work is incomplete and another agent could continue it.
- Test results, environment assumptions, dependencies, or known risks changed.
- The user made a decision affecting future work.

If none apply (read-only question, trivial explanation, no-change review, or exploration that
produced nothing reusable), say so and **stop — do not write anything**. Needless churn is a cost,
not diligence.

If the threshold is met:

1. Rewrite `.project-memory/handoff.md` in the Handoff format of `PROTOCOL.md`: `## State`
   (Updated, Agent, Task, Branch, Commit from `git rev-parse --short HEAD` or `Uncommitted`, Done),
   `## Verified`, `## Not verified`, `## Next`, `## Risks / do not`. "Next" must be concrete enough
   to execute without this conversation. Keep it under 8000 bytes: move the previous handoff's
   finished-event detail to `.project-memory/archive/<YYYY-MM-DD>-<topic>.md` first if it is worth
   keeping.
2. Update `.project-memory/STATE.md` **only** if a milestone, macro status, major blocker, or
   cross-module plan changed.
3. Append to `.project-memory/DECISIONS.md` **only** for a durable architectural decision — add a
   row to the Quick Index and a new section below. Never rewrite an existing decision; supersede it.
4. Run the relevant tests or validation and record the actual command and result under
   `## Verified`; anything failed or not run goes under `## Not verified` — never record an
   unverified pass.
5. Show `git diff --stat` and state any remaining risk.
6. **Save the memory** so other agents and other machines receive it:

```bash
bash .project-memory/commit-handoff.sh "docs(memory): <one-line summary of this session>"
```

   It regenerates the block Codex and Antigravity auto-load, then saves according to Agent
   Workbench: Settings > Memory sync — off: stays on this machine; OneDrive / Google Drive folder:
   the cloud client uploads it; private GitHub repository: committed and pushed there. It never
   commits to the project repository. Tell the user what it printed; if memory sync is off, say the
   handoff is on this machine only. Do not commit or copy memory any other way.

Never `git add` `.project-memory/`, `AGENTS.md` or `.agents/` to the project repository. Do not
pull, rebase, merge, reset, or force-push; committing the user's source code is not yours to decide.
