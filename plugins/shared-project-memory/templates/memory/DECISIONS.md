# Architecture Decisions

## Quick Index
| ID | Title | Date | Status | Supersedes |
|---|---|---|---|---|
| DEC-001 | Shared memory is versioned in Git | <YYYY-MM-DD> | Accepted | - |

---

## DEC-001: Shared memory is versioned in Git
- Date: <YYYY-MM-DD>
- Status: Accepted
- Decision: Store canonical cross-agent memory in `.project-memory/` and sync it through Git.
- Reason: Claude Code, Codex and Antigravity all read the same repository files.
- Consequence: Memory changes are reviewed and committed alongside engineering work.

<!--
新決策取代舊的:在上方 Quick Index 追加一列並填 Supersedes,
下方追加新章節。永遠不要改寫或刪除既有決策。
-->
