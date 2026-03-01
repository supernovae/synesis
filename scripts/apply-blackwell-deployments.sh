#!/usr/bin/env bash
# =============================================================================
# Apply Blackwell model deployments (Executor, Manager, Planner) to OpenShift
# =============================================================================
#
# Prerequisites:
#   - Models mirrored to ECR (./scripts/mirror-models-to-ecr.sh)
#   - Or NVFP4 pipeline run for executor-nvfp4
#   - ROSA nodes typically pull ECR via node IAM; imagePullSecrets not needed
#
# Usage:
#   export ECR_REGISTRY=660250927410.dkr.ecr.us-east-1.amazonaws.com
#   export ECR_REPO=byron-ai-registry   # default
#   export EXECUTOR_IMAGE_TAG=executor-nvfp4   # G6e default; use executor for G7e FP8
#   ./scripts/apply-blackwell-deployments.sh
#
# ECR push: use your creds to mirror; NVFP4 pipeline uses IRSA on Data Science Pipelines SA.
# ECR pull: ROSA nodes usually pull same-account ECR via node IAM (no secret).
# If cross-account or different setup: uncomment imagePullSecrets in manifests and create the secret.
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BLACKWELL_DIR="$REPO_ROOT/base/model-serving/blackwell"

# ECR_URI = full repo (660250927410.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry)
# Or ECR_REGISTRY + ECR_REPO separately
if [[ -n "${ECR_URI:-}" ]]; then
  ECR_REGISTRY="${ECR_URI%%/*}"
  ECR_REPO="${ECR_URI#*/}"
else
  ECR_REGISTRY="${ECR_REGISTRY:-}"
  ECR_REPO="${ECR_REPO:-byron-ai-registry}"
fi
# G6e default: NVFP4 (FP8 won't fit 48GB). Override to executor for G7e FP8.
EXECUTOR_IMAGE_TAG="${EXECUTOR_IMAGE_TAG:-executor-nvfp4}"
export ECR_REGISTRY ECR_REPO EXECUTOR_IMAGE_TAG

log() { echo "[$(date +%H:%M:%S)] $*"; }
err() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }
die() { err "$*"; exit 1; }

main() {
  [[ -n "$ECR_REGISTRY" ]] || die "ECR_REGISTRY required. Example: 660250927410.dkr.ecr.us-east-1.amazonaws.com"
  [[ -d "$BLACKWELL_DIR" ]] || die "Blackwell dir not found: $BLACKWELL_DIR"

  log "Applying Blackwell deployments"
  log "ECR_REGISTRY=$ECR_REGISTRY ECR_REPO=$ECR_REPO EXECUTOR_IMAGE_TAG=$EXECUTOR_IMAGE_TAG"

  oc create namespace synesis-models 2>/dev/null || true
  oc create namespace synesis-planner 2>/dev/null || true

  log "Applying PVC (optional, for UDS)"
  oc apply -n synesis-models -f "$BLACKWELL_DIR/pvc-vllm-sockets.yaml" 2>/dev/null || true

  log "Applying Executor and Manager"
  export ECR_REGISTRY
  envsubst < "$BLACKWELL_DIR/deployment-vllm-executor.yaml" | oc apply -n synesis-models -f -
  envsubst < "$BLACKWELL_DIR/deployment-vllm-manager.yaml" | oc apply -n synesis-models -f -

  log "Applying Planner"
  oc apply -n synesis-planner -f "$BLACKWELL_DIR/deployment-planner-gpu.yaml"

  log "Done. Verify with: oc get pods -n synesis-models && oc get pods -n synesis-planner"
}

main "$@"
