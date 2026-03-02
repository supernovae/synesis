#!/usr/bin/env bash
# =============================================================================
# Bootstrap Synesis pipelines: ECR + pipeline container, hf-hub-secret, PVCs
# =============================================================================
#
# 1. ECR + model-pvc-download: Build and push pipeline container (uv + hf_hub)
#    for model download to PVC. ECR is your container registry.
# 2. hf-hub-secret: For HuggingFace model downloads (avoids throttling).
# 3. PVCs: Model pipelines download to PVC; deployments load from PV.
#
# Usage (full):
#   export ECR_URI=660250927410.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry
#   export DS_PROJECT=synesis-models
#   export HF_TOKEN=hf_xxxx   # optional
#   ./scripts/bootstrap-pipelines.sh
#
# Usage (no ECR): Omit ECR_URI. Skips container build (pipelines use public uv image).
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ECR_URI="${ECR_URI:-}"
ECR_REGISTRY="${ECR_REGISTRY:-}"
ECR_REPO="${ECR_REPO:-byron-ai-registry}"
DS_PROJECT="${DS_PROJECT:-synesis-models}"
HF_TOKEN="${HF_TOKEN:-}"

log() { echo "[$(date +%H:%M:%S)] $*"; }
err() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }
die() { err "$*"; exit 1; }

if [[ -z "$ECR_URI" && -n "$ECR_REGISTRY" ]]; then
  ECR_URI="${ECR_REGISTRY}/${ECR_REPO}"
  log "Using ECR_URI=$ECR_URI"
fi

log "Bootstrap pipelines (DS_PROJECT=$DS_PROJECT)"

# ---------------------------------------------------------------------------
# 1. ECR + model-pvc-download container (when ECR_URI set)
# ---------------------------------------------------------------------------
if [[ -n "$ECR_URI" ]]; then
  log "--- ECR + model-pvc-download ---"
  REPO_NAME="${ECR_URI#*/}"
  AWS_REGION="${AWS_REGION:-us-east-1}"
  if aws ecr describe-repositories --repository-names "$REPO_NAME" --region "$AWS_REGION" &>/dev/null; then
    log "ECR repo $REPO_NAME exists"
  else
    log "Creating ECR repo $REPO_NAME"
    aws ecr create-repository --repository-name "$REPO_NAME" --region "$AWS_REGION" --image-scanning-configuration scanOnPush=true || true
  fi
  log "Building and pushing model-pvc-download..."
  export ECR_URI
  "$REPO_ROOT/pipelines/model-pvc-download/build.sh"
else
  log "--- ECR + model-pvc-download --- skipped (set ECR_URI to enable)"
fi

# ---------------------------------------------------------------------------
# 2. hf-hub-secret
# ---------------------------------------------------------------------------
log "--- HuggingFace secret ---"
if oc get project "$DS_PROJECT" &>/dev/null; then
  if [[ -n "$HF_TOKEN" ]]; then
    log "Creating hf-hub-secret in $DS_PROJECT"
    oc create secret generic hf-hub-secret -n "$DS_PROJECT" \
      --from-literal=HF_TOKEN="$HF_TOKEN" \
      --dry-run=client -o yaml | oc apply -f -
  else
    log "HF_TOKEN not set; create manually: oc create secret generic hf-hub-secret -n $DS_PROJECT --from-literal=HF_TOKEN=hf_xxx"
  fi
else
  die "Project $DS_PROJECT not found. Create it first."
fi

# ---------------------------------------------------------------------------
# 2. PVCs (model pipelines download here; deployments mount)
# ---------------------------------------------------------------------------
log "--- Model PVCs ---"
for pvc in modelcar-build-pvc executor-build-pvc; do
  if oc get pvc "$pvc" -n "$DS_PROJECT" &>/dev/null; then
    log "PVC $pvc exists"
  else
    log "Create PVCs:"
    echo "  oc apply -f pipelines/manifests/storage-class-gp3-high.yaml   # cluster-admin, once"
    echo "  sed \"s/NAMESPACE/$DS_PROJECT/\" pipelines/manifests/modelcar-build-pvc.yaml | oc apply -f -"
    echo "  sed \"s/NAMESPACE/$DS_PROJECT/\" pipelines/manifests/executor-build-pvc.yaml | oc apply -f -"
    break
  fi
done

# ---------------------------------------------------------------------------
# Discover KFP_HOST
# ---------------------------------------------------------------------------
KFP_HOST=""
if oc get project "$DS_PROJECT" &>/dev/null; then
  KFP_HOST=$(oc get dspa -n "$DS_PROJECT" -o jsonpath='{.items[0].status.components.apiServer.externalUrl}' 2>/dev/null || true)
  [[ -z "$KFP_HOST" ]] && KFP_HOST=$(oc get route -n "$DS_PROJECT" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.host}{"\n"}{end}' 2>/dev/null | grep -iE 'pipeline|dspa|apiserver|api-server' | head -1 | awk '{print "https://"$2}')
  [[ -z "$KFP_HOST" ]] && KFP_HOST=$(oc get route -n "$DS_PROJECT" -o jsonpath='{.items[0].spec.host}' 2>/dev/null | sed 's/^/https:\/\//')
fi

log ""
log "Done. Run model pipelines:"
echo "  export KFP_HOST=${KFP_HOST:-https://<pipelines-route>}"
echo "  export DS_PROJECT=$DS_PROJECT"
[[ -n "$ECR_URI" ]] && echo "  export ECR_URI=$ECR_URI"
echo "  ./scripts/run-pipelines.sh manager"
echo "  ./scripts/run-pipelines.sh executor"
