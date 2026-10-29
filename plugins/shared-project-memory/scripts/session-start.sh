#!/usr/bin/env bash
# Claude Code SessionStart hook: inject tier-1 shared memory into the session context.
#
# Thin wrapper on purpose. The real logic lives in the REPO at .project-memory/status.sh so that
# Codex, Antigravity and humans run the exact same thing - one definition of "startup memory",
# versioned with the project rather than with this plugin.

[ -f ".project-memory/status.sh" ] || exit 0   # not a memory-enabled repo -> silent no-op
exec bash ".project-memory/status.sh"
