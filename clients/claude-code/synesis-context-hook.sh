#!/usr/bin/env bash
# Synesis session context for Claude Code hooks (SessionStart, CwdChanged).
# Writes Yarn-compatible metadata keys to .claude/synesis-context.json for use
# with synesis-anthropic-proxy.mjs. Requires: jq, git (optional).
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "synesis-context-hook: jq is required (https://jqlang.org/)" >&2
  exit 2
fi

INPUT=$(cat)
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
NEW_CWD=$(echo "$INPUT" | jq -r '.new_cwd // empty')

if [ "$EVENT" = "CwdChanged" ] && [ -n "$NEW_CWD" ]; then
  WORK_CWD="$NEW_CWD"
elif [ -n "$CWD" ]; then
  WORK_CWD="$CWD"
else
  WORK_CWD="$(pwd)"
fi

ROOT="$(git -C "$WORK_CWD" rev-parse --show-toplevel 2>/dev/null || echo "$WORK_CWD")"

PLATFORM="$(uname -s)"
OS_VER="$(uname -r)"
SHELL_PATH="${SHELL:-}"

GIT_SUMMARY=""
if command -v git >/dev/null 2>&1; then
  GIT_SUMMARY="$(git -C "$ROOT" status -sb 2>/dev/null | head -c 500 || true)"
fi

PROJ_DIR="${CLAUDE_PROJECT_DIR:-.}"
OUT_DIR="$PROJ_DIR/.claude"
OUT_FILE="$OUT_DIR/synesis-context.json"
mkdir -p "$OUT_DIR"

jq -n \
  --arg pr "$ROOT" \
  --arg sc "$WORK_CWD" \
  --arg pl "$PLATFORM" \
  --arg os "$OS_VER" \
  --arg sh "$SHELL_PATH" \
  --arg gs "$GIT_SUMMARY" \
  '{
    synesis_project_root: $pr,
    synesis_shell_cwd: $sc,
    synesis_runtime: {
      platform: $pl,
      os_version: $os,
      shell: $sh
    }
  } + (if ($gs | length) > 0 then {synesis_git_summary: $gs} else {} end)' > "$OUT_FILE"

if [ "$EVENT" = "SessionStart" ]; then
  SUMMARY="Synesis session context (sidecar: ${OUT_FILE}). project_root=${ROOT} shell_cwd=${WORK_CWD} platform=${PLATFORM} shell=${SHELL_PATH}"
  jq -n --arg ctx "$SUMMARY" \
    '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
fi

exit 0
