# Agent Workbench Linux

Independent Linux app, initially copied from Windows v0.1.39. Linux starts at
v0.1.0 and has its own source, package lock, build configuration and CI. Nothing
imports application code from the Windows project at the repository root.

## Development and builds

Run on Linux x64 with Node.js 24 and npm:

```bash
cd apps/linux
npm ci
npm run typecheck
npm run check:linux
npm run check:pty
npm run dev
```

`npm run dist` builds AppImage, Debian and tar.gz packages in `apps/linux/release/`.
`npm run pack` builds an unpacked Linux directory. These commands never publish.
The native PTY dependency installs its Linux prebuilt binary through npm.

Use the AppImage with `chmod +x Agent-Workbench-Linux-*-x64.AppImage`, then run it.
Install the Debian package with `sudo apt install ./Agent-Workbench-Linux-*-x64.deb`.
The tar.gz archive contains the `agent-workbench-linux` executable.
Keep Electron's sandbox enabled; do not run the app as root.
Minimal Linux/WSL installations may lack Electron's desktop runtime libraries.
The Debian package declares these dependencies, including ALSA; AppImage and
tar.gz users need the equivalent system libraries installed separately.

## Isolation

- App ID: `io.github.zkylek1212-k.agent-workbench-linux`.
- User data: Electron's app-data directory plus `agent-workbench-linux`, usually
  `~/.config/agent-workbench-linux`; development uses `agent-workbench-linux-dev`.
- Workspace data: `.workbench-linux/`. Windows `.workbench/` is not migrated or overwritten.
  Add `.workbench-linux/` to the `.gitignore` of any workspace you open.
- System Shell uses `$SHELL`, falling back to `/bin/bash`. Explicit Bash and
  optional PowerShell Core retain their own commands. Desktop and phone use the same launcher logic.
- Both windows use native Linux title bars. System directories and symlinks into
  them are blocked as workspaces; Linux path checks preserve case.
- Credentials require an OS secret store; Electron's `basic_text` fallback is refused.
- Agent CLIs and their own home-directory settings remain managed by the user.

## Releases

The workflow builds only this app. Master changes, pull requests and manual runs
produce downloadable CI artifacts. A pushed tag `linux-v<package version>` also
publishes a **prerelease** with `--latest=false`. Do not convert Linux releases to
stable/latest: the existing Windows app reads GitHub's latest stable release.

Linux checks only published `linux-vX.Y.Z` prereleases containing a Linux x64
package and opens that release's download page. Updates are currently manual;
no Windows installer or updater manifest is used or published by this app.

Windows fixes do not automatically reach this copy. Port needed fixes explicitly
and run Linux checks before publishing. ARM64, other distributions and graphical
desktop environments need their own validation before claiming support.
