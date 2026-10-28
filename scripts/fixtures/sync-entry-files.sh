#!/usr/bin/env bash
# Regenerate the AUTO-MEMORY block inside the entry files that Codex and Antigravity
# auto-load at startup.
#
# WHY: those two tools auto-load STATIC FILES (AGENTS.md, .agents/rules/*) but cannot run a
# command and inject its output the way Claude Code's SessionStart hook can. So instead of asking
# them to run status.sh, we derive the current handoff INTO the files they already read.
#
# handoff.md remains the single source of truth. The block below is GENERATED - never hand-edited.
# Run automatically by .githooks/pre-commit (when handoff.md is staged) and .githooks/post-merge.

set -e
MEM="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$MEM/.." && pwd)"
cd "$REPO"

[ -f "$MEM/handoff.md" ] || exit 0

BEGIN_MARK="<!-- BEGIN AUTO-MEMORY (generated from .project-memory/handoff.md - do not edit) -->"
END_MARK="<!-- END AUTO-MEMORY -->"

BLOCK="$(mktemp)"
trap 'rm -f "$BLOCK"' EXIT

{
  printf '%s\n\n' "$BEGIN_MARK"
  printf '## Current shared memory (tier 1 - auto-generated, do not edit here)\n\n'
  printf 'You already have the current handoff below. Do NOT re-read `.project-memory/handoff.md`.\n'
  printf 'Read `STATE.md` / `DECISIONS.md` / `PROTOCOL.md` only on demand.\n'
  printf 'For the freshest copy plus a remote-drift check, run `bash .project-memory/status.sh`.\n\n'
  printf -- '---\n\n'
  cat "$MEM/handoff.md"
  printf '\n%s\n' "$END_MARK"
} > "$BLOCK"

inject() {
  local f="$1"
  [ -f "$f" ] || return 0
  if grep -qF "$BEGIN_MARK" "$f"; then
    # replace everything between the markers (inclusive) with the new block
    awk -v b="$BEGIN_MARK" -v e="$END_MARK" -v bf="$BLOCK" '
      $0 == b { while ((getline line < bf) > 0) print line; close(bf); skip=1; next }
      skip && $0 == e { skip=0; next }
      !skip { print }
    ' "$f" > "$f.spmtmp" && mv "$f.spmtmp" "$f"
  else
    printf '\n' >> "$f"
    cat "$BLOCK" >> "$f"
  fi
  echo "  synced: $f"
}

inject "AGENTS.md"
inject ".agents/rules/shared-memory.md"
