---
description: Scaffold shared project memory for this clone (.project-memory/, entry files for all three agents, git hook) — never committed to the project repo
---

Set up cross-tool shared project memory in the current repository.

1. Run the scaffolding script. On Windows, use the bundled PowerShell installer so `bash`
   cannot resolve to WSL:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/install.ps1" "${PWD}"
```

On macOS/Linux, run:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/init-memory.sh"
```

2. Report exactly what it created vs skipped (it never overwrites existing files).

3. Then fill in the two placeholder files from what you can actually verify about this repo —
   read the README, package/build files, and recent `git log` first. Do NOT invent status:

   - `.project-memory/STATE.md` — current milestone, macro progress, long-term tasks. Mark
     anything you inferred rather than confirmed as `Unverified`.
   - `.project-memory/handoff.md` — fill the Handoff format sections (`## State` with
     Agent/Branch/Commit from the real repo state, `## Verified`, `## Not verified`, `## Next`,
     `## Risks / do not`). If there is no work in flight, say so plainly rather than fabricating a task.

4. Tell the user:
   - The memory and the generated `AGENTS.md` / `.agents/` are local to this clone (listed in
     `.git/info/exclude`) and must never be committed to the project repository.
   - To share memory between computers, set it up in Agent Workbench: Settings > Memory sync
     (private GitHub repository, or a OneDrive / Google Drive folder). Until then the handoff stays
     on this machine.
   - Only `.githooks/`, `.gitattributes` and the `CLAUDE.md` block (instructions, no memory content)
     may be committed, if the user wants. On every OTHER machine after cloning:
     `git config core.hooksPath .githooks` (per-clone config; committing `.githooks/` does not enable it).
