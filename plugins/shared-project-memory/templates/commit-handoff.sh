#!/usr/bin/env bash
# Save the handoff so it reaches other agents (and, with memory sync on, other machines).
#
# Three cases, decided by where .project-memory/ really points (Workbench: Settings > Memory sync):
#   1. Memory sync OFF: .project-memory is a plain folder in the project. The handoff stays on this
#      machine. Nothing is committed and there is NO network access - and there is nothing else to
#      do: do not commit memory any other way and do not retry.
#   2. Cloud folder (OneDrive / Google Drive): .project-memory links into the chosen folder (it has
#      a .workbench-memory.json marker). Saving the file is enough; the cloud client uploads it.
#   3. Private GitHub repository: .project-memory links into a clone of the user's private memory
#      repo. The change is committed there and pushed (MEM_AUTOPUSH=0 to skip the push).
# The project repository never receives memory files.
#
# Usage: bash .project-memory/commit-handoff.sh ["commit message"]

set -e
MEM="$(cd "$(dirname "$0")" && pwd)"          # logical path, inside the project
REPO="$(cd "$MEM/.." && pwd)"
cd "$REPO"

MSG="${1:-docs(memory): update handoff}"
real() { (cd "$1" 2>/dev/null && pwd -P) || echo "$1"; }
MEMREAL="$(real "$MEM")"
PROJREAL="$(real "$REPO")"

# Regenerate the block Codex/Antigravity auto-load (local files only).
[ -f "$MEM/sync-entry-files.sh" ] && bash "$MEM/sync-entry-files.sh" >/dev/null 2>&1 || true

# 1) not linked: memory sync is off
case "$MEMREAL/" in
  "$PROJREAL"/*)
    echo "Memory sync is off: the handoff is saved on this machine only. Nothing else to do."
    exit 0
    ;;
esac

# Keep a template copy of both entry files in the memory folder so another machine can recreate
# them (the project does not track them). The copy leaves out the generated AUTO-MEMORY block:
# every machine regenerates it from its own handoff.md, so storing it would make the machines
# conflict on every handoff.
mkdir -p "$MEM/entry"
template() { awk '/<!-- BEGIN AUTO-MEMORY/{skip=1} !skip{print} /<!-- END AUTO-MEMORY -->/{skip=0}' "$1" > "$2"; }
[ -f "AGENTS.md" ] && template "AGENTS.md" "$MEM/entry/AGENTS.md"
[ -f ".agents/rules/shared-memory.md" ] && template ".agents/rules/shared-memory.md" "$MEM/entry/shared-memory.md"

# 2) cloud folder: find the marker above the project's memory folder
d="$MEMREAL"
while [ -n "$d" ] && [ "$d" != "/" ] && [ "$d" != "$(dirname "$d")" ]; do
  if [ -f "$d/.workbench-memory.json" ]; then
    echo "Saved in the synced folder ($d); your cloud drive uploads it. Nothing else to do."
    exit 0
  fi
  d="$(dirname "$d")"
done

# 3) private GitHub repository
MEMTOP="$(git -C "$MEM" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$MEMTOP" ]; then
  echo "The memory folder is linked but is neither a synced folder nor a git repository; nothing was committed."
  echo "Check Agent Workbench: Settings > Memory sync."
  exit 1
fi
TOPREAL="$(real "$MEMTOP")"
REL="${MEMREAL#"$TOPREAL"/}"

if [ -z "$(git -C "$MEMTOP" status --porcelain -- "$REL")" ]; then
  echo "No memory changes to commit."
  exit 0
fi

git -C "$MEMTOP" add -A -- "$REL"

# Secret scan on added lines only (removing an old secret is never blocked).
ADDED="$(git -C "$MEMTOP" diff --cached -U0 -- "$REL" | grep '^+' | grep -v '^+++' || true)"
if echo "$ADDED" | grep -nEi '(api[_-]?key|secret|password|passwd|token)[[:space:]]*[:=][[:space:]]*[^[:space:]]{12,}' \
   || echo "$ADDED" | grep -nE 'BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY'; then
  git -C "$MEMTOP" reset -q -- "$REL"
  echo "Possible secret in the new memory content (lines above). Remove it, then run this again."
  exit 1
fi

git -C "$MEMTOP" commit -q -m "$MSG" -- "$REL"
echo "Committed memory to the private repository: $(git -C "$MEMTOP" rev-parse --short HEAD) $MSG"

if [ "${MEM_AUTOPUSH:-1}" = "1" ]; then
  if git -C "$MEMTOP" push --quiet 2>/dev/null; then
    echo "Pushed."
  elif git -C "$MEMTOP" pull --rebase --quiet 2>/dev/null && git -C "$MEMTOP" push --quiet 2>/dev/null; then
    echo "Pushed (after rebasing onto the other machine's memory)."
  else
    echo "Push failed (offline, or a conflict with another machine). The commit is kept locally;"
    echo "use Settings > Memory sync > Sync now, or resolve in: $MEMTOP"
  fi
else
  echo "Not pushed (MEM_AUTOPUSH=0)."
fi
