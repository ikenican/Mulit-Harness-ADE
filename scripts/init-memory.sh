#!/usr/bin/env bash
# Scaffold shared project memory for the current clone.
# Idempotent: never overwrites an existing file. Memory is NEVER committed to the project
# repository: it stays local (.git/info/exclude) and is shared through Agent Workbench memory sync.
set -e

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
T="$ROOT/templates"
MEM=".project-memory"

git rev-parse --git-dir >/dev/null 2>&1 || {
  echo "Not a git repository. Run 'git init' first."
  exit 1
}

copy_if_absent() {  # $1=src $2=dst
  if [ -e "$2" ]; then
    echo "  skip (exists): $2"
  else
    mkdir -p "$(dirname "$2")"
    cp "$1" "$2"
    echo "  created:       $2"
  fi
}

echo "Scaffolding shared project memory..."
mkdir -p "$MEM/archive" .githooks .agents/rules

for f in INDEX.md handoff.md STATE.md DECISIONS.md PROTOCOL.md; do
  copy_if_absent "$T/memory/$f" "$MEM/$f"
done
# Tool-agnostic startup script: every agent (and you) runs this same file.
copy_if_absent "$T/status.sh"           "$MEM/status.sh"
copy_if_absent "$T/sync-entry-files.sh" "$MEM/sync-entry-files.sh"
copy_if_absent "$T/commit-handoff.sh"   "$MEM/commit-handoff.sh"
copy_if_absent "$T/AGENTS.md"           "AGENTS.md"
copy_if_absent "$T/shared-memory.md"    ".agents/rules/shared-memory.md"
copy_if_absent "$T/pre-commit"          ".githooks/pre-commit"
chmod +x .githooks/pre-commit \
         "$MEM/status.sh" "$MEM/sync-entry-files.sh" "$MEM/commit-handoff.sh" 2>/dev/null || true

# Keep memory and the generated entry files out of the project repository (this clone only; the
# same root-anchored patterns Agent Workbench writes). Files the project already tracks, such as a
# team AGENTS.md, are unaffected and sync-entry-files.sh leaves them alone.
EXCLUDE="$(git rev-parse --git-path info/exclude)"
mkdir -p "$(dirname "$EXCLUDE")"
for p in /.project-memory /AGENTS.md /.agents/rules/shared-memory.md; do
  if ! grep -qxF "$p" "$EXCLUDE" 2>/dev/null; then
    printf '%s\n' "$p" >> "$EXCLUDE"
    echo "  excluded:      $p"
  fi
done

# Seed the AUTO-MEMORY block so Codex/Antigravity have memory from day one.
bash "$MEM/sync-entry-files.sh" >/dev/null 2>&1 || true

# .gitattributes: append the LF rule if missing (CRLF breaks bash hooks on Windows)
if ! grep -q '\.githooks/\* text eol=lf' .gitattributes 2>/dev/null; then
  {
    printf '.githooks/* text eol=lf\n'
  } >> .gitattributes
  echo "  updated:       .gitattributes"
else
  echo "  skip (exists): .gitattributes rule"
fi

# CLAUDE.md: append the memory block only if not already referenced
if ! grep -q 'project-memory' CLAUDE.md 2>/dev/null; then
  printf '\n' >> CLAUDE.md
  cat "$T/CLAUDE.md" >> CLAUDE.md
  echo "  updated:       CLAUDE.md"
else
  echo "  skip (exists): CLAUDE.md block"
fi

# core.hooksPath is per-clone local config; committing .githooks/ does NOT enable it.
git config core.hooksPath .githooks
echo "  git hooks:     $(git config --get core.hooksPath)"

echo
echo "Done. Next:"
echo "  1. Fill in $MEM/STATE.md and $MEM/handoff.md for this project."
echo "  2. Never commit $MEM, AGENTS.md or .agents to this repository. To share memory between"
echo "     computers, use Agent Workbench: Settings > Memory sync (private GitHub repo / OneDrive /"
echo "     Google Drive). Until then the handoff stays on this machine."
echo "  3. Optional: commit .githooks .gitattributes CLAUDE.md; on every OTHER clone run:"
echo "     git config core.hooksPath .githooks"
