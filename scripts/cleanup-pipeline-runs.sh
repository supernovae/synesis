#!/usr/bin/env bash
# Clean up old KFP pipeline runs — reduce clutter in OpenShift AI Pipelines UI.
#
# Usage:
#   export KFP_HOST=https://<pipelines-route>
#   ./scripts/cleanup-pipeline-runs.sh --dry-run
#   ./scripts/cleanup-pipeline-runs.sh --keep 5
#   ./scripts/cleanup-pipeline-runs.sh --archive -y

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if command -v uv &>/dev/null; then
  exec uv run --with "kfp[kubernetes]" --project "$REPO_ROOT" python "$SCRIPT_DIR/cleanup-pipeline-runs.py" "$@"
else
  exec python3 "$SCRIPT_DIR/cleanup-pipeline-runs.py" "$@"
fi
