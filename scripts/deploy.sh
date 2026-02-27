#!/usr/bin/env bash
set -euo pipefail

# Synesis Deployment Script
#
# Applies Kustomize overlays to the cluster.
# Auto-generates a LiteLLM API key if one doesn't exist.
#
# Usage: ./scripts/deploy.sh <environment>
#   environment: dev | staging | prod

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

ENV="${1:-}"

if [[ -z "$ENV" ]] || [[ ! "$ENV" =~ ^(dev|staging|prod)$ ]]; then
    echo "Usage: $0 <dev|staging|prod>"
    exit 1
fi

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

OVERLAY_DIR="$PROJECT_ROOT/overlays/$ENV"

if [[ ! -d "$OVERLAY_DIR" ]]; then
    log "ERROR: Overlay directory not found: $OVERLAY_DIR"
    exit 1
fi

# -----------------------------------------------------------------------
# Ensure a LiteLLM API key exists in the cluster secret.
# If the secret doesn't exist or still has the placeholder value,
# generate a real key and create/update the secret.
# -----------------------------------------------------------------------
ensure_litellm_key() {
    local ns="synesis-gateway"
    local secret_name="litellm-secrets"
    local existing_key=""

    oc create namespace "$ns" 2>/dev/null || true

    if oc get secret "$secret_name" -n "$ns" &>/dev/null; then
        existing_key=$(oc get secret "$secret_name" -n "$ns" \
            -o jsonpath='{.data.master-key}' 2>/dev/null | base64 -d 2>/dev/null || true)
    fi

    if [[ -z "$existing_key" ]] || [[ "$existing_key" == "sk-synesis-change-me" ]]; then
        LITELLM_KEY="sk-synesis-$(openssl rand -hex 24)"
        log "Generating LiteLLM API key..."

        oc create secret generic "$secret_name" \
            -n "$ns" \
            --from-literal=master-key="$LITELLM_KEY" \
            --dry-run=client -o yaml | oc apply -f -

        log "  Key stored in secret $ns/$secret_name"
    else
        LITELLM_KEY="$existing_key"
        log "LiteLLM API key already exists in $ns/$secret_name"
    fi
}

ensure_webui_key() {
    local webui_ns="synesis-webui"
    oc create namespace "$webui_ns" 2>/dev/null || true

    log "Syncing API key to Open WebUI namespace..."
    oc create secret generic webui-api-key \
        -n "$webui_ns" \
        --from-literal=api-key="$LITELLM_KEY" \
        --dry-run=client -o yaml | oc apply -f -
    log "  Key synced to $webui_ns/webui-api-key"
}

log "=== Deploying Synesis ($ENV) ==="
log ""

ensure_litellm_key
ensure_webui_key

log ""
log "Validating kustomize build..."
if ! kustomize build "$OVERLAY_DIR" 2>/dev/null >/dev/null; then
    log "ERROR: Kustomize build failed. Fix errors and retry."
    kustomize build "$OVERLAY_DIR" 2>&1
    exit 1
fi

log "Generating manifest preview..."
MANIFEST_COUNT=$(kustomize build "$OVERLAY_DIR" 2>/dev/null | grep -c '^kind:' || true)
log "  $MANIFEST_COUNT resources to apply"

# -----------------------------------------------------------------------
# Pre-flight: verify custom images are reachable.
# Spot-check one image from the kustomize output to catch the common
# mistake of deploying before building/pushing images.
# -----------------------------------------------------------------------
check_custom_images() {
    log "Checking custom image availability..."
    local sample_image
    sample_image=$(kustomize build "$OVERLAY_DIR" 2>/dev/null \
        | grep 'image:' | grep 'ghcr.io.*synesis' | head -1 \
        | sed 's/.*image: *//' | tr -d '"' | tr -d "'" || true)

    if [[ -z "$sample_image" ]]; then
        sample_image=$(kustomize build "$OVERLAY_DIR" 2>/dev/null \
            | grep 'image:' | grep 'synesis-' | head -1 \
            | sed 's/.*image: *//' | tr -d '"' | tr -d "'" || true)
        if [[ -n "$sample_image" && "$sample_image" != *"/"* ]]; then
            log "WARNING: Custom images still use bare names (e.g., $sample_image)."
            log "  Kubernetes will try docker.io/library/$sample_image which does not exist."
            log "  Ensure the kustomize overlay has an 'images:' block with your registry."
            log "  See: overlays/$ENV/kustomization.yaml"
            log ""
        fi
        return
    fi

    if command -v skopeo &>/dev/null; then
        if ! skopeo inspect --no-tags "docker://$sample_image" &>/dev/null; then
            log "WARNING: Cannot reach image $sample_image"
            log "  Build and push images first:"
            log "    ./scripts/build-images.sh --push"
            log "  If the repo is private, create a pull secret in each namespace."
            log ""
        else
            log "  Image check OK ($sample_image)"
        fi
    else
        log "  Skipping image pull check (skopeo not installed)"
        log "  Sample image: $sample_image"
    fi
}

check_custom_images

# -----------------------------------------------------------------------
# Pre-flight: check RHOAI model serving readiness.
# InferenceService resources require:
#   1. A DataScienceCluster CR with kserve: Managed
#   2. The odh-model-controller webhook to have running endpoints
# If (1) is missing, retrying won't help -- skip InferenceService apply.
# If (1) exists but (2) is not ready, retry with backoff.
# -----------------------------------------------------------------------

ISVC_SKIP=false

check_dsc_kserve() {
    local dsc_name
    dsc_name=$(oc get datascienceclusters.datasciencecluster.opendatahub.io \
        --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null | head -1 || true)

    if [[ -z "$dsc_name" ]]; then
        return 1
    fi

    local kserve_state
    kserve_state=$(oc get datascienceclusters.datasciencecluster.opendatahub.io "$dsc_name" \
        -o jsonpath='{.spec.components.kserve.managementState}' 2>/dev/null || echo "unknown")
    [[ "$kserve_state" == "Managed" ]]
}

check_rhoai_webhook() {
    local endpoint_json
    endpoint_json=$(oc get endpoints odh-model-controller-webhook-service \
        -n redhat-ods-applications -o jsonpath='{.subsets[*].addresses}' 2>/dev/null || true)
    [[ "${#endpoint_json}" -gt 2 ]]
}

# -----------------------------------------------------------------------
# Runtime discovery: verify ClusterServingRuntimes exist for model deployment.
# Override via SYNESIS_RUNTIME_GPU, SYNESIS_RUNTIME_CPU env vars (requires overlay patches).
# -----------------------------------------------------------------------
discover_runtimes() {
    if [[ "$ISVC_SKIP" == "true" ]]; then return 0; fi

    local names
    names=$(oc get servingruntimes -n synesis-models -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)
    if [[ -n "$names" ]]; then
        log "  ServingRuntimes in synesis-models: $names"
        for r in synesis-supervisor synesis-executor synesis-critic; do
            echo "$names" | grep -q "$r" || log "  WARNING: $r not found (deploy creates it)"
        done
    fi
}

log ""
log "Checking RHOAI model serving readiness..."

if ! check_dsc_kserve; then
    log "WARNING: No DataScienceCluster CR found with kserve: Managed."
    log "  InferenceService/ServingRuntime resources will be SKIPPED."
    log "  All other Synesis resources will be applied normally."
    log ""
    log "  To fix, create a DataScienceCluster CR (via Terraform, dashboard, or manifest):"
    log "    spec.components.kserve.managementState: Managed"
    log "  Then re-run:  ./scripts/deploy.sh $ENV"
    log ""
    log "  Prerequisites:"
    log "    - OpenShift Serverless operator (KNative Serving)"
    log "    - OpenShift Service Mesh operator (Istio)"
    ISVC_SKIP=true
elif check_rhoai_webhook; then
    log "  DataScienceCluster: OK (kserve Managed)"
    log "  Model controller webhook: ready"
    discover_runtimes
else
    log "  DataScienceCluster: OK (kserve Managed)"
    log "  Model controller webhook: not ready yet (will retry after apply)"
    discover_runtimes
fi

build_manifests() {
    if [[ "$ISVC_SKIP" == "true" ]]; then
        kustomize build "$OVERLAY_DIR" 2>/dev/null \
            | python3 -c "
import sys
docs = sys.stdin.read().split('---')
for doc in docs:
    if 'kind: InferenceService' not in doc and 'kind: ServingRuntime' not in doc:
        print('---')
        print(doc)
"
    else
        kustomize build "$OVERLAY_DIR" 2>/dev/null
    fi
}

# -----------------------------------------------------------------------
# Migration: clean up resources with stale selector labels.
#
# The old commonLabels injected app.kubernetes.io/managed-by,
# app.kubernetes.io/part-of, and synesis.io/environment into
# spec.selector.matchLabels on Deployments and spec.template on Jobs.
# These fields are immutable -- the only fix is delete + recreate.
# This runs once; after recreation the new selectors are clean.
# -----------------------------------------------------------------------
migrate_stale_selectors() {
    log "Checking for selector label migration..."

    local synesis_ns=(synesis-gateway synesis-planner synesis-rag synesis-sandbox synesis-search synesis-lsp synesis-webui)
    local deleted=0

    for ns in "${synesis_ns[@]}"; do
        # Deployments: check if selector has labels that shouldn't be there
        local deploys
        deploys=$(oc get deployments -n "$ns" --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null || true)
        for deploy in $deploys; do
            [[ -z "$deploy" ]] && continue
            local sel
            sel=$(oc get deployment "$deploy" -n "$ns" \
                -o jsonpath='{.spec.selector.matchLabels}' 2>/dev/null || true)
            if echo "$sel" | grep -q 'managed-by\|synesis.io/environment'; then
                log "  Deleting deployment/$deploy -n $ns (stale selector)"
                oc delete deployment "$deploy" -n "$ns" --ignore-not-found 2>/dev/null || true
                deleted=$((deleted + 1))
            fi
        done

        # Jobs: template labels are immutable, delete any synesis jobs
        local jobs
        jobs=$(oc get jobs -n "$ns" -l app.kubernetes.io/part-of=synesis \
            --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null || true)
        for job in $jobs; do
            [[ -z "$job" ]] && continue
            log "  Deleting job/$job -n $ns (immutable template)"
            oc delete job "$job" -n "$ns" --ignore-not-found 2>/dev/null || true
            deleted=$((deleted + 1))
        done
    done

    if [[ $deleted -gt 0 ]]; then
        log "  Cleaned up $deleted resources with stale selectors"
    else
        log "  No migration needed"
    fi
}

apply_manifests() {
    local output
    output=$(build_manifests | oc apply -f - 2>&1)
    echo "$output" | grep -v '^#'

    if echo "$output" | grep -qi 'failed calling webhook'; then
        return 1
    fi
    if echo "$output" | grep -qi 'field is immutable'; then
        return 1
    fi
    return 0
}

migrate_stale_selectors

log ""
log "Applying manifests to cluster..."

APPLY_OK=false
MAX_ATTEMPTS=6
ATTEMPT=1
WAIT_SECS=10

if [[ "$ISVC_SKIP" == "true" ]]; then
    MAX_ATTEMPTS=1
fi

while [[ $ATTEMPT -le $MAX_ATTEMPTS ]]; do
    if apply_manifests; then
        APPLY_OK=true
        break
    fi

    if [[ $ATTEMPT -lt $MAX_ATTEMPTS ]]; then
        log ""
        log "WARNING: Apply had errors (attempt $ATTEMPT/$MAX_ATTEMPTS)."
        if ! check_rhoai_webhook; then
            log "  RHOAI webhook not ready (odh-model-controller pods may still be starting)."
            log "  Waiting ${WAIT_SECS}s..."
        else
            log "  Retrying in ${WAIT_SECS}s..."
        fi
        sleep "$WAIT_SECS"
        WAIT_SECS=$((WAIT_SECS * 2))
    fi
    ATTEMPT=$((ATTEMPT + 1))
done

if [[ "$APPLY_OK" != "true" && "$ISVC_SKIP" != "true" ]]; then
    log ""
    log "WARNING: Some resources failed to apply after $MAX_ATTEMPTS attempts."
    log "  The RHOAI model controller webhook is not responding."
    log "  Diagnose:"
    log "    oc get datascienceclusters"
    log "    oc get pods -n redhat-ods-applications -l app=odh-model-controller"
    log "    oc get endpoints odh-model-controller-webhook-service -n redhat-ods-applications"
    log "  Once ready, re-run:  ./scripts/deploy.sh $ENV"
fi

log ""
log "Waiting for rollouts..."

wait_for_deployment() {
    local ns="$1" name="$2"
    if oc get deployment "$name" -n "$ns" &>/dev/null; then
        log "  Waiting for $ns/$name..."
        oc rollout status deployment/"$name" -n "$ns" --timeout=300s || {
            log "WARNING: Rollout timeout for $ns/$name"
        }
    fi
}

wait_for_deployment synesis-gateway litellm-proxy
wait_for_deployment synesis-planner synesis-planner
wait_for_deployment synesis-planner synesis-health-monitor
wait_for_deployment synesis-rag etcd-deployment
wait_for_deployment synesis-rag milvus-standalone
wait_for_deployment synesis-rag embedder
wait_for_deployment synesis-webui open-webui

log ""
log "Model serving status (synesis-models namespace):"
if [[ "$ISVC_SKIP" == "true" ]]; then
    log "  InferenceServices SKIPPED (no DataScienceCluster with kserve Managed)"
    log "  Models must be deployed manually via OpenShift AI dashboard."
else
    if oc get inferenceservice -n synesis-models --no-headers 2>/dev/null | head -5 | grep -q .; then
        log ""
        oc get inferenceservice -n synesis-models 2>/dev/null
        log ""
        log "  Deployed models: synesis-supervisor, synesis-executor, synesis-critic"
        log "  Planner uses synesis-supervisor. Wait for PredictorReady before using."
    else
        log "  No InferenceServices found yet (webhook may not be ready, or apply failed)"
        log "  Check: oc get servingruntimes -n synesis-models (deploy creates synesis-supervisor, -executor, -critic)"
        log "  Then retry: ./scripts/deploy.sh $ENV"
    fi
fi

log ""
log "=== Deployment complete ($ENV) ==="

ROUTE_HOST=$(oc get route synesis-api -n synesis-gateway -o jsonpath='{.spec.host}' 2>/dev/null || echo "not-yet-created")
WEBUI_HOST=$(oc get route synesis-webui -n synesis-webui -o jsonpath='{.spec.host}' 2>/dev/null || echo "not-yet-created")

log ""
log "============================================================"
log "  API endpoint:  https://$ROUTE_HOST"
log "  API key:       $LITELLM_KEY"
log "  Web UI:        https://$WEBUI_HOST"
log "============================================================"
log ""
log "Open WebUI:"
log "  Browse to https://$WEBUI_HOST"
log "  Create an admin account on first visit."
log "  Models are pre-configured -- select 'synesis-agent' to start."
log ""
log "Export for your shell:"
log "  export SYNESIS_API_KEY=$LITELLM_KEY"
log "  export SYNESIS_API_URL=https://$ROUTE_HOST/v1"
log ""
log "Cursor setup:"
log "  Settings > Models > Add Model > OpenAI Compatible"
log "  Base URL: https://$ROUTE_HOST/v1"
log "  API Key:  $LITELLM_KEY"
log "  Model:    synesis-agent"
log ""
log "Quick test:"
log "  curl -s https://$ROUTE_HOST/v1/models -H 'Authorization: Bearer $LITELLM_KEY' | python3 -m json.tool"
