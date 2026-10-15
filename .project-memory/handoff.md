# Latest Handoff

- Agent: Codex
- Updated: 2026-10-15 Asia/Taipei
- Branch: feat/custom-agent; source commit 8ead826, pushed. PR #45 open against master: https://github.com/zkylek1212-k/Mulit-Harness-ADE/pull/45. Not merged or released. User requested a new PR for an opt-in custom harness and matching extension management.
- Branch starts at origin/master; does not include phone Cowork parity PR #44, which remains open separately: https://github.com/zkylek1212-k/Mulit-Harness-ADE/pull/44.

## Done
- Settings → CLI & Agents → Customize Agent: defaults off; optional display name, executable/command, one-argument-per-line args, executable browse/test, native Skills/Plugins directory and MCP/Hooks file paths. Disabled hides configuration fields, terminal launch/dispatch choices and custom extension editor; existing sessions and config/files are preserved.
- Terminal launchpad, + menu and prompt dispatcher show the enabled custom harness. Phone New Terminal lists it via the existing shared launchers/PTY route. Global enable/config changes refresh other desktop windows and connected phones.
- Settings → Extensions has a gated native editor with Skills/MCP/Plugins/Hooks categories and file creation/editing. Uses the user's actual harness paths and format, not guessed adapters. File I/O checks disabled state, relative path boundaries, symbolic links, UTF-8/1 MB limit, JSON syntax, external edits and backup destination hard links. Writes preserve a .workbench-backup; new-file creation does not overwrite existing files.
- Executable/args/paths/opt-in only read from global userData; customAgent is omitted from workspace settings. Repository launcher IDs cannot impersonate custom-agent. Custom harnesses receive their own args without provider-specific bypass/default flags. Global settings write failures now propagate to the UI.
- New shared customAgent types, preload IPC contract and native resource helper; no new dependencies. Existing AgentId/Cowork/provider parsers remain unchanged. README includes English/Traditional Chinese usage and limits.

## Validation
- npm run typecheck and npm run build passed on final source.
- node scripts/check-custom-agent.cjs passed: persisted settings isolation, opt-in, real phone launcher filtering, direct/launcher PTY args, Windows script prefixes and spaced args, four resource types, backup/conflict/JSON/path/link checks.
- electron scripts/check-custom-agent-ui.cjs passed: actual React settings save, enable/hide, terminal launch, all four extension editors, draft switch protection, English/Traditional Chinese and light/dark screenshots.
- node scripts/check-approval.cjs, electron scripts/check-terminal-ui.cjs and node --experimental-strip-types scripts/check-remote.mts passed. Existing PTY test fixtures updated for new shared import.
- UI screenshots inspected in C:/Users/milan.chang/AppData/Local/Temp/workbench-custom-ui-j2XaG9 (settings.png and extensions language/theme variants).

## Next / limits
- Review/merge PR #45 when authorized. One custom harness slot; native extension editing only, no generic marketplace installer or format conversion. Paths must match the harness's own discovery rules. Browse up to six directory levels/500 files; edit UTF-8 text up to 1 MB.
- No real third-party harness or physical iPhone tested. Cowork, provider history and token telemetry stay with the three built-in CLIs. Linux app unchanged per DEC-011.
- User's pre-existing untracked Temp/ and phone view bug.png / phone view_bug1.png / phone view_bug2.png were preserved and excluded from commits.
- Previous phone Cowork work and its validation/limits remain on feat/phone-cowork-parity (PR #44, source 0ad67ea, memory 40a63ab). Do not merge it automatically.
