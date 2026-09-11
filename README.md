# Agent Workbench

A lightweight, **agent-native** developer workbench: a Monaco code editor, a
Git visualizer, and N embedded CLI terminals — nothing more. Built with
Electron + React + Vite.

> **Design principle — not an agent runtime.** This workbench does not implement
> an agent loop, hold API keys, or parse any vendor's private protocol. The agent
> loop is run by each vendor's **official CLI** in a real terminal; cross-CLI
> hand-off is done through a shared `.project-memory/` (handoff notes + Git). The
> workbench only does four things: **edit code, visualize Git, spawn CLI terminal
> shells, and render shared memory.**

## Features

- **Monaco editor** — the same editor core as VS Code (via the MIT-licensed
  `monaco-editor`), with edit and diff views, including commit-level diffs from
  the Git panel.
- **Git panel** — status, staging, commit, branch switch, a commit graph, and
  recent-commit / file diffs.
- **Multi-CLI terminals** — each CLI gets its own `xterm.js` terminal tab, run
  natively as a child process via `node-pty`. No keys stored; the CLIs use their
  own subscriptions/auth.
- **Preview** — live Markdown / HTML preview that auto-syncs on edit and save.
- **Dashboard** — local session/token statistics scanned from local records.

## Requirements

- Node.js 18+ (LTS recommended)
- On Windows the terminal uses a prebuilt native binary (`@lydell/node-pty`);
  no compiler toolchain is required.

## Getting started

```bash
npm install
npm run dev        # launch in development
```

## Build

```bash
npm run typecheck  # TypeScript check, no emit
npm run build      # compile main / preload / renderer
npm run dist       # build an installer with electron-builder
```

Installer output goes to `release/`. Build config is in `electron-builder.yml`.

## Project layout

```
src/main       Electron main process (IPC, git, pty, files, extensions)
src/preload    the single IPC contract surface
src/renderer   React UI (editor / git / terminal / preview / dashboard panels)
.project-memory  shared cross-agent memory (handoff, protocol, decisions)
```

## Configuration notes

- `src/preload/index.ts` is the **single IPC contract** between main and renderer.
- `src/renderer/src/store.ts` holds cross-panel state.
- Theme colors come from CSS variables in `src/renderer/src/styles.css` — do not
  hard-code colors inside panels.
- Per-machine runtime state (`.workbench/settings.json`,
  `.workbench/dashboard-state.json`) is git-ignored; `.workbench/extensions.yaml`
  is the checked-in template.

## License

[MIT](LICENSE) © 2026 zkyle.

## Trademark & affiliation notice

This project is an independent tool and is **not affiliated with, endorsed by, or
sponsored by** Anthropic, OpenAI, Google, or Microsoft. "Claude Code", "Codex",
"Antigravity", "VS Code", and other product names are trademarks of their
respective owners and are used here only nominatively to describe interoperability.
Agent Workbench bundles none of those products; it launches whichever CLIs the
user has installed.

## Third-party software

All bundled runtime dependencies are permissively licensed (MIT), including
`monaco-editor`, `@monaco-editor/react`, `@xterm/xterm`, `react`, `react-dom`,
`react-markdown`, `rehype-highlight`, `remark-gfm`, `mermaid`, `simple-git`,
`js-yaml`, and `@lydell/node-pty`. Their license terms continue to apply to those
components.
