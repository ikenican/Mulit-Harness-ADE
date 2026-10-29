#!/usr/bin/env bash
# Standalone installer - works WITHOUT Claude Code.
# Use this from Codex, Antigravity, or a plain shell.
#
#   bash /path/to/shared-project-memory/install.sh          # install into current repo
#   bash /path/to/shared-project-memory/install.sh /my/repo # install into another repo
#
# Claude Code users can instead run the /memory-init slash command.

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-$PWD}"

cd "$TARGET"
CLAUDE_PLUGIN_ROOT="$HERE" bash "$HERE/scripts/init-memory.sh"
