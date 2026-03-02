#!/usr/bin/env bash
# =============================================================================
# Bootstrap Synesis pipelines: ECR repo, buildah-ecr image, hf-hub-secret
# =============================================================================
#
# Run once before invoking pipelines. Ensures ECR repo exists, buildah-ecr is
# built and pushed, and hf-hub-secret is created in your Data Science project.
#
# Usage:
#   export ECR_REGISTRY=660250927410.dkr.ecr.us-east-1.amazonaws.com
#   export ECR_URI=660250927410.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry
#   export DS_PROJECT=your-data-science-project
#   export HF_TOKEN=hf_xxxx
#
#   ./scripts/bootstrap-pipelines.sh
#
# Pipeline server: create via OpenShift AI GUI first. Bootstrap looks up KFP_HOST in DS_PROJECT.
# Or: ECR_URI alone works (derived from ECR_REGISTRY + repo name if needed).
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ECR_URI="${ECR_URI:-}"
ECR_REGISTRY="${ECR_REGISTRY:-}"
ECR_REPO="${ECR_REPO:-byron-ai-registry}"
DS_PROJECT="${DS_PROJECT:-}"
HF_TOKEN="${HF_TOKEN:-}"

log() { echo "[$(date +%H:%M:%S)] $*"; }
err() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }
die() { err "$*"; exit 1; }

# ECR_URI = registry/repo. Prefer ECR_URI, else build from ECR_REGISTRY + ECR_REPO.
if [[ -z "$ECR_URI" && -n "$ECR_REGISTRY" ]]; then
  ECR_URI="${ECR_REGISTRY}/${ECR_REPO}"
  log "Using ECR_URI=$ECR_URI"
fi
[[ -n "$ECR_URI" ]] || die "Set ECR_URI or ECR_REGISTRY (e.g. ECR_URI=660250927410.dkr.ecr.us-east-1.amazonaws.com/byron-ai-registry)"

# 1. Ensure ECR repo exists
log "Ensuring ECR repo exists..."
REPO_NAME="${ECR_URI#*/}"
REGISTRY="${ECR_URI%%/*}"
AWS_REGION="${AWS_REGION:-us-east-1}"
if aws ecr describe-repositories --repository-names "$REPO_NAME" --region "$AWS_REGION" &>/dev/null; then
  log "ECR repo $REPO_NAME exists"
else
  log "Creating ECR repo $REPO_NAME"
  aws ecr create-repository --repository-name "$REPO_NAME" --region "$AWS_REGION" --image-scanning-configuration scanOnPush=true || true
fi

# 2. Build and push buildah-ecr (Red Hat stack)
log "Building and pushing buildah-ecr..."
export ECR_URI
"$REPO_ROOT/pipelines/buildah-ecr/build.sh"

# 3. Apply Buildah SCC (capabilities for overlay storage)
log "Applying Buildah SCC..."
oc apply -f "$REPO_ROOT/pipelines/manifests/buildah-scc.yaml"
if [[ -n "$DS_PROJECT" ]]; then
  log "Granting buildah-capabilities SCC to pipeline-runner-dspa in $DS_PROJECT"
  oc adm policy add-scc-to-user buildah-capabilities -z pipeline-runner-dspa -n "$DS_PROJECT" 2>/dev/null || true
  log "Granting anyuid SCC (required for Buildah Job runAsUser:0)"
  oc adm policy add-scc-to-user anyuid -z pipeline-runner-dspa -n "$DS_PROJECT" 2>/dev/null || true
  log "Granting privileged SCC (required for Buildah uid_map in strict environments)"
  oc adm policy add-scc-to-user privileged -z pipeline-runner-dspa -n "$DS_PROJECT" 2>/dev/null || true
  log "Applying pipeline-runner Job RBAC (ModelCar build workaround)"
  sed "s/NAMESPACE/$DS_PROJECT/g" "$REPO_ROOT/pipelines/manifests/pipeline-runner-job-rbac.yaml" | oc apply -f -
else
  log "DS_PROJECT not set; grant manually: oc adm policy add-scc-to-user buildah-capabilities -z pipeline-runner-dspa -n <ds-project>"
  log "Apply Job RBAC manually: sed \"s/NAMESPACE/<ds-project>/\" $REPO_ROOT/pipelines/manifests/pipeline-runner-job-rbac.yaml | oc apply -f -"
fi

# 4. Create hf-hub-secret in DS project (avoids rate limiting)
if [[ -n "$DS_PROJECT" ]]; then
  if [[ -n "$HF_TOKEN" ]]; then
    log "Creating hf-hub-secret in $DS_PROJECT"
    oc create secret generic hf-hub-secret -n "$DS_PROJECT" \
      --from-literal=HF_TOKEN="$HF_TOKEN" \
      --dry-run=client -o yaml | oc apply -f -
  else
    log "HF_TOKEN not set; create hf-hub-secret manually:"
    echo "  oc create secret generic hf-hub-secret -n $DS_PROJECT --from-literal=HF_TOKEN=hf_xxx"
  fi
else
  log "DS_PROJECT not set; create hf-hub-secret manually in your Data Science project"
fi

# Discover KFP_HOST from cluster (DS_PROJECT must have pipeline server)
KFP_HOST=""
if [[ -n "$DS_PROJECT" ]] && oc get project "$DS_PROJECT" &>/dev/null; then
  # Try DSPA status first, then routes
  KFP_HOST=$(oc get dspa -n "$DS_PROJECT" -o jsonpath='{.items[0].status.components.apiServer.externalUrl}' 2>/dev/null || true)
  if [[ -z "$KFP_HOST" ]]; then
    # Try common route patterns: ds-pipeline-*-apiserver, pipelines, ds-pipelines
    KFP_HOST=$(oc get route -n "$DS_PROJECT" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.host}{"\n"}{end}' 2>/dev/null | grep -iE 'pipeline|dspa|apiserver|api-server' | head -1 | awk '{print "https://"$2}')
  fi
  if [[ -z "$KFP_HOST" ]]; then
    # Fallback: first route in project (often pipelines if it's the only one)
    ROUTE_HOST=$(oc get route -n "$DS_PROJECT" -o jsonpath='{.items[0].spec.host}' 2>/dev/null || true)
    [[ -n "$ROUTE_HOST" ]] && KFP_HOST="https://${ROUTE_HOST}"
  fi
fi

# Optional: PVC for manager-split pipeline (avoids OOM)
if [[ -n "$DS_PROJECT" ]]; then
  if ! oc get secret aws-ecr-credentials -n "$DS_PROJECT" &>/dev/null; then
    log "Create aws-ecr-credentials for ECR push:"
    echo "  export DS_PROJECT=$DS_PROJECT"
    echo "  aws sso login && ./scripts/mint-ecr-credentials.sh"
  fi
  for pvc in modelcar-build-pvc executor-build-pvc; do
    if ! oc get pvc "$pvc" -n "$DS_PROJECT" &>/dev/null; then
      log "Create PVC for split pipelines (avoids OOM):"
      echo "  sed \"s/NAMESPACE/$DS_PROJECT/\" $REPO_ROOT/pipelines/manifests/modelcar-build-pvc.yaml | oc apply -f -"
      echo "  sed \"s/NAMESPACE/$DS_PROJECT/\" $REPO_ROOT/pipelines/manifests/executor-build-pvc.yaml | oc apply -f -"
      break
    fi
  done
fi

log "Done. Run pipelines with:"
echo "  export ECR_URI=$ECR_URI"
if [[ -n "$KFP_HOST" ]]; then
  echo "  export KFP_HOST=$KFP_HOST"
else
  echo "  export KFP_HOST=https://<pipelines-route>   # oc get route -n $DS_PROJECT"
fi
echo "  ./scripts/run-pipelines.sh manager"
echo "  ./scripts/run-pipelines.sh executor"
