#!/usr/bin/env bash
# Print tier-1 shared memory (INDEX + handoff), optionally after a safe fast-forward sync.
#
# TOOL-AGNOSTIC: this is the single source of truth for "what an agent sees at startup".
#   Claude Code  - run automatically by the shared-project-memory plugin's SessionStart hook.
#   Codex        - AGENTS.md instructs the agent to run it as its first command.
#   Antigravity  - .agents/rules/shared-memory.md instructs the same.
#   Human/other  - just run: bash .project-memory/status.sh
#
# Order matters: sync FIRST, then print - so what you read is the fresh memory.

MEM="$(cd "$(dirname "$0")" && pwd)"
[ -f "$MEM/handoff.md" ] || exit 0   # not a memory-enabled repo -> do nothing

# Safe auto-sync switch: 0 = report only (default), 1 = allow fast-forward sync.
AUTOSYNC="${MEM_AUTOSYNC:-0}"

SYNC_NOTE=""
# Remote check only when the memory is linked to a private GitHub memory repository
# (Workbench: Settings > Memory sync). Memory sync off (a plain folder in the project) or a
# cloud-drive folder: no network access at all.
g() { git -C "$MEM" "$@"; }
MEMREAL="$(cd "$MEM" && pwd -P)"
PROJREAL="$(cd "$MEM/.." && pwd -P)"
LINKED_REPO=0
case "$MEMREAL/" in
  "$PROJREAL"/*) ;;
  *) g rev-parse --is-inside-work-tree >/dev/null 2>&1 && LINKED_REPO=1 ;;
esac
# git fetch is read-only and always safe. Anything that MUTATES the tree is guarded.
if [ "$LINKED_REPO" = "1" ] && g rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
  g fetch --quiet 2>/dev/null || true
  behind=$(g rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)
  ahead=$(g rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
  dirty=$(g status --porcelain 2>/dev/null)

  if [ "${behind:-0}" -gt 0 ]; then
    # Triple guard: switch on + clean tree + no divergent local commits.
    if [ "$AUTOSYNC" = "1" ] && [ -z "$dirty" ] && [ "${ahead:-0}" -eq 0 ]; then
      if g pull --ff-only --quiet 2>/dev/null; then
        SYNC_NOTE="> Auto-synced: fast-forwarded $behind commit(s). Memory below is fresh."
      else
        SYNC_NOTE="> Auto-sync aborted (not a fast-forward). Memory below may be stale - ask the user before merging."
      fi
    else
      SYNC_NOTE="> Behind remote by $behind commit(s) (ahead=$ahead, uncommitted=$([ -n "$dirty" ] && echo yes || echo no)). Do NOT auto-pull; report this and ask the user."
    fi
  fi
fi

echo "# Shared project memory (tier 1)"
echo
echo "This is the canonical cross-agent memory. Do NOT re-read INDEX.md or handoff.md -"
echo "you already have them below. Read STATE.md / DECISIONS.md / PROTOCOL.md only on demand,"
echo "per the rules in INDEX.md."
[ -n "$SYNC_NOTE" ] && { echo; echo "$SYNC_NOTE"; }
echo
echo "## INDEX.md"
cat "$MEM/INDEX.md" 2>/dev/null
echo
echo "## handoff.md"
cat "$MEM/handoff.md" 2>/dev/null

# Handoff shape check (see PROTOCOL.md "Handoff format"): a missing section is easy to miss in
# free text, and an oversized Tier 1 gets truncated by context-injection hooks.
REQUIRED_SECTIONS=("## State" "## Verified" "## Not verified" "## Next" "## Risks / do not")
MISSING=()
for sec in "${REQUIRED_SECTIONS[@]}"; do
  grep -qF -- "$sec" "$MEM/handoff.md" 2>/dev/null || MISSING+=("$sec")
done
SIZE=$(wc -c < "$MEM/handoff.md" 2>/dev/null || echo 0)
if [ "${#MISSING[@]}" -gt 0 ] || [ "${SIZE:-0}" -gt 8000 ]; then
  echo
  echo "> Handoff check:"
  [ "${#MISSING[@]}" -gt 0 ] && echo ">   missing section(s): ${MISSING[*]} - treat the handoff as incomplete and verify against Git."
  [ "${SIZE:-0}" -gt 8000 ] && echo ">   handoff.md is ${SIZE} bytes (limit 8000) - move finished-event detail to archive/."
fi

# The checks above are informational; reading memory itself succeeded.
exit 0
