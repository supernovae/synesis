#!/usr/bin/env bash
# =============================================================================
# Apply Blackwell model deployments (Executor, Manager, Planner) to OpenShift
# =============================================================================
#
# Prerequisites:
#   - Models downloaded to PVC via pipelines (./scripts/run-pipelines.sh)
#   - PVCs: modelcar-build-pvc, executor-build-pvc in synesis-models
#
# Usage:
#   ./scripts/apply-blackwell-deployments.sh
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BLACKWELL_DIR="$REPO_ROOT/base/model-serving/blackwell"

log() { echo "[$(date +%H:%M:%S)] $*"; }
err() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }
die() { err "$*"; exit 1; }

main() {
  [[ -d "$BLACKWELL_DIR" ]] || die "Blackwell dir not found: $BLACKWELL_DIR"

  log "Applying Blackwell deployments"

  oc create namespace synesis-models 2>/dev/null || true
  oc create namespace synesis-planner 2>/dev/null || true

  log "Applying PVC (optional, for UDS)"
  oc apply -n synesis-models -f "$BLACKWELL_DIR/pvc-vllm-sockets.yaml" 2>/dev/null || true

  log "Applying Executor and Manager"
  oc apply -n synesis-models -f "$BLACKWELL_DIR/deployment-vllm-executor.yaml"
  oc apply -n synesis-models -f "$BLACKWELL_DIR/deployment-vllm-manager.yaml"

  log "Applying Planner"
  oc apply -n synesis-planner -f "$BLACKWELL_DIR/deployment-planner-gpu.yaml"

  log "Done. Verify with: oc get pods -n synesis-models && oc get pods -n synesis-planner"
}

main "$@"
