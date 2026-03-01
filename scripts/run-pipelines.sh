#!/usr/bin/env bash
# Invoke Synesis pipelines on OpenShift AI (build runs in-cluster, within AWS)
#
# Usage:
#   export KFP_HOST=https://<pipelines-route>   # from oc get route -n <ds-project>
#   export ECR_URI=660250927410.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry
#   # Auth (required for 401): oc login, then token is auto-detected via oc whoami -t
#   #   Or: export KFP_TOKEN=$(oc whoami -t)
#
#   ./scripts/run-pipelines.sh manager
#   ./scripts/run-pipelines.sh manager --validate   # 0.5B model, fast validation
#   ./scripts/run-pipelines.sh manager-split              # Download→build, avoids OOM (needs PVC)
#   ./scripts/run-pipelines.sh manager-split-build-only   # Resume build (skip re-download)
#   ./scripts/run-pipelines.sh executor-split             # Quant→copy→build (needs executor PVC)
#   ./scripts/run-pipelines.sh executor-split-build-only  # Resume executor build
#   ./scripts/run-pipelines.sh executor
#   ./scripts/run-pipelines.sh all
#
# Prerequisites: pip install kfp, oc logged in, hf-hub-secret in DS project

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Prefer uv so kfp + kubernetes extras are available: uv run --with "kfp[kubernetes]"
if command -v uv &>/dev/null; then
  exec uv run --with "kfp[kubernetes]" --project "$REPO_ROOT" python "$SCRIPT_DIR/run-pipelines.py" "$@"
else
  exec python3 "$SCRIPT_DIR/run-pipelines.py" "$@"
fi
