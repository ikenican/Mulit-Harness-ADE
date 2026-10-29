---
name: shared-project-memory
description: Manually initialize shared project memory in the current Git repository. Use only when the user explicitly invokes this skill or asks to initialize this project's shared memory.
---

# Shared Project Memory initializer

Use this skill only after the user explicitly invokes `$shared-project-memory` or asks to initialize shared project memory. Do not initialize a project just because it is new or because memory is mentioned.

1. Work only in the requested project root. Check whether `.project-memory/` or related entry files already exist. The installer is idempotent and does not overwrite existing files; explain what it will create if the target already has memory files.
2. Confirm the target is a Git repository with `git rev-parse --git-dir`. If it is not, ask before running `git init`; initialization requires Git hooks.
3. Run the bundled installer from the plugin root. On Windows, use
   `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <plugin-root>/install.ps1 <target-repository>`
   so Windows cannot resolve `bash` to WSL. On macOS/Linux, run
   `<plugin-root>/install.sh <target-repository>`.
4. Report created files and the per-clone hook activation command: `git config core.hooksPath .githooks`. Do not commit or push unless asked.
5. Do not invent project status. Populate `STATE.md` and `handoff.md` only from verifiable project files and history, following `.project-memory/PROTOCOL.md`.
