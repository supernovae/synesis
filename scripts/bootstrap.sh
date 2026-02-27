#!/usr/bin/env bash
set -euo pipefail

# Synesis Bootstrap Script
#
# Prepares an OpenShift cluster for Synesis deployment.
# Requires: RHOAI operator + NVIDIA GPU Operator already installed.
#
# Usage: ./scripts/bootstrap.sh [--force] [--ghcr-creds] [--skip-ghcr-creds]
#   --ghcr-creds     Prompt for GitHub credentials to create GHCR pull secrets (for private images)
#   --skip-ghcr-creds  Skip GHCR pull secret setup (use when images are public)

FORCE=false
GHCR_CREDS=false
SKIP_GHCR_CREDS=false

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=true ;;
        --ghcr-creds) GHCR_CREDS=true ;;
        --skip-ghcr-creds) SKIP_GHCR_CREDS=true ;;
        --help|-h)
            echo "Usage: $0 [--force] [--ghcr-creds] [--skip-ghcr-creds]"
            echo ""
            echo "Prepares an OpenShift cluster for Synesis deployment."
            echo "  --force           Continue even if RHOAI/GPU checks fail"
            echo "  --ghcr-creds      Prompt for GitHub user/token to create GHCR pull secrets (private images)"
            echo "  --skip-ghcr-creds Skip GHCR pull secret setup (default when not prompting)"
            echo ""
            echo "For non-interactive use, set GITHUB_USERNAME and GITHUB_TOKEN env vars."
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg"
            exit 1
            ;;
    esac
done

log()  { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }
warn() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $*" >&2; }
err()  { echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2; }

PREFLIGHT_FAILURES=0

check_prerequisites() {
    local missing=()

    command -v oc &>/dev/null        || missing+=("oc")
    command -v kubectl &>/dev/null   || missing+=("kubectl")
    command -v kustomize &>/dev/null || missing+=("kustomize")

    if [[ ${#missing[@]} -gt 0 ]]; then
        err "Missing required tools: ${missing[*]}"
        exit 1
    fi

    if ! oc whoami &>/dev/null; then
        err "Not logged into an OpenShift cluster. Run 'oc login' first."
        exit 1
    fi

    log "Connected to cluster: $(oc whoami --show-server)"
    log "Logged in as: $(oc whoami)"
}

# ---------------------------------------------------------------------------
# RHOAI detection
#
# Three things must be true for InferenceService resources to work:
#   1. RHOAI operator is installed (CSV exists)
#   2. A DataScienceCluster CR exists with kserve Managed
#   3. The odh-model-controller webhook has endpoints (pods running)
#
# The operator alone is not enough -- without the DSC CR, no model
# controller pods are deployed and the webhook service has no endpoints.
# ---------------------------------------------------------------------------
verify_rhoai() {
    log "Verifying Red Hat OpenShift AI (RHOAI)..."

    local operator_found=false
    local dsc_found=false
    local kserve_managed=false

    # --- Step 1: Is the operator installed? ---
    if oc get crd datascienceclusters.datasciencecluster.opendatahub.io &>/dev/null; then
        operator_found=true
        log "  RHOAI operator: installed (DataScienceCluster CRD exists)"
    elif oc get csv --all-namespaces 2>/dev/null | grep -qi 'rhods-operator\|rhoai-operator\|opendatahub'; then
        operator_found=true
        log "  RHOAI operator: installed (CSV found)"
    fi

    if [[ "$operator_found" != "true" ]]; then
        err "RHOAI operator NOT detected."
        err ""
        err "  Install 'Red Hat OpenShift AI' from OperatorHub."
        err "  Docs: https://docs.redhat.com/en/documentation/red_hat_openshift_ai_self-managed/"
        PREFLIGHT_FAILURES=$((PREFLIGHT_FAILURES + 1))
        return 1
    fi

    # --- Step 2: Does a DataScienceCluster CR exist? ---
    local dsc_name=""
    dsc_name=$(oc get datascienceclusters.datasciencecluster.opendatahub.io \
        --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null | head -1 || true)

    if [[ -n "$dsc_name" ]]; then
        dsc_found=true
        log "  DataScienceCluster CR: $dsc_name"

        # Check if kserve component is Managed
        local kserve_state
        kserve_state=$(oc get datascienceclusters.datasciencecluster.opendatahub.io "$dsc_name" \
            -o jsonpath='{.spec.components.kserve.managementState}' 2>/dev/null || echo "unknown")
        log "  KServe managementState: $kserve_state"

        if [[ "$kserve_state" == "Managed" ]]; then
            kserve_managed=true
        fi
    fi

    if [[ "$dsc_found" != "true" ]]; then
        warn "RHOAI operator is installed but NO DataScienceCluster CR exists."
        warn ""
        warn "  Without a DataScienceCluster, RHOAI won't deploy KServe, the model"
        warn "  controller, or the webhook -- InferenceService resources will fail."
        warn ""
        warn "  Create one via the RHOAI dashboard, Terraform, or apply a manifest:"
        warn ""
        warn "    apiVersion: datasciencecluster.opendatahub.io/v1"
        warn "    kind: DataScienceCluster"
        warn "    metadata:"
        warn "      name: default-dsc"
        warn "    spec:"
        warn "      components:"
        warn "        kserve:"
        warn "          managementState: Managed"
        warn "          serving:"
        warn "            ingressGateway:"
        warn "              certificate:"
        warn "                type: SelfSigned"
        warn "            managementState: Managed"
        warn "            name: knative-serving"
        warn "        dashboard:"
        warn "          managementState: Managed"
        warn "        modelmeshserving:"
        warn "          managementState: Managed"
        warn "        datasciencepipelines:"
        warn "          managementState: Managed"
        warn "        workbenches:"
        warn "          managementState: Managed"
        warn ""
        warn "  Also ensure these prerequisite operators are installed:"
        warn "    - OpenShift Serverless (for KNative Serving)"
        warn "    - OpenShift Service Mesh (for Istio/Maistra)"
        warn ""
        PREFLIGHT_FAILURES=$((PREFLIGHT_FAILURES + 1))
        return 1
    fi

    if [[ "$kserve_managed" != "true" ]]; then
        warn "DataScienceCluster exists but kserve is not 'Managed'."
        warn "  InferenceService resources will not work until kserve is Managed."
        warn "  Update your DataScienceCluster: spec.components.kserve.managementState: Managed"
        PREFLIGHT_FAILURES=$((PREFLIGHT_FAILURES + 1))
        return 1
    fi

    # --- Step 3: Is the webhook actually running? ---
    local webhook_ready=false
    local endpoint_count
    endpoint_count=$(oc get endpoints odh-model-controller-webhook-service \
        -n redhat-ods-applications -o jsonpath='{.subsets[*].addresses}' 2>/dev/null | wc -c | tr -d ' ' || echo "0")
    if [[ "$endpoint_count" -gt 2 ]]; then
        webhook_ready=true
    fi

    if [[ "$webhook_ready" == "true" ]]; then
        log "  Model controller webhook: ready"
    else
        warn "Model controller webhook has no endpoints yet."
        warn "  The DSC was likely just created -- pods may still be starting."
        warn "  Check: oc get pods -n redhat-ods-applications -l app=odh-model-controller"
        warn "  deploy.sh will retry automatically when the webhook comes online."
    fi

    log "  RHOAI: OK"
    return 0
}

# ---------------------------------------------------------------------------
# NVIDIA GPU Operator detection
#
# Strategy:
#   1. Check for the ClusterPolicy CRD (NVIDIA-specific, definitive)
#   2. Check for GPU capacity on any node
#   3. Fall back to CSV scan
# ---------------------------------------------------------------------------
verify_gpu_operator() {
    log "Verifying NVIDIA GPU Operator..."

    # Method 1: ClusterPolicy CRD
    if oc get crd clusterpolicies.nvidia.com &>/dev/null; then
        local cp_state
        cp_state=$(oc get clusterpolicy -o jsonpath='{.items[0].status.state}' 2>/dev/null || echo "unknown")
        if [[ "$cp_state" == "ready" ]]; then
            log "  GPU Operator detected (ClusterPolicy state: ready)"
        else
            log "  GPU Operator detected (ClusterPolicy state: $cp_state)"
            warn "ClusterPolicy is not 'ready'. GPU scheduling may fail until it is."
        fi

        local gpu_nodes
        gpu_nodes=$(oc get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.capacity.nvidia\.com/gpu}{"\n"}{end}' 2>/dev/null | awk '$2 > 0' | wc -l | tr -d ' ')
        if [[ "$gpu_nodes" -gt 0 ]]; then
            log "  Found $gpu_nodes node(s) with NVIDIA GPUs"
        else
            warn "No nodes reporting nvidia.com/gpu capacity."
            warn "  If the cluster is autoscaling, GPU nodes may appear once workloads are scheduled."
        fi
        return 0
    fi

    # Method 2: CSV scan
    if oc get csv --all-namespaces 2>/dev/null | grep -qi 'gpu-operator'; then
        log "  GPU Operator CSV found (operator installed, ClusterPolicy may still be initializing)"
        return 0
    fi

    # Method 3: check if any node already has GPUs (operator might be in a non-standard namespace)
    local gpu_cap
    gpu_cap=$(oc get nodes -o jsonpath='{range .items[*]}{.status.capacity.nvidia\.com/gpu}{"\n"}{end}' 2>/dev/null | awk '$1 > 0' | head -1 || true)
    if [[ -n "$gpu_cap" ]]; then
        log "  GPU capacity found on nodes (operator may be installed in a non-standard namespace)"
        return 0
    fi

    err "NVIDIA GPU Operator NOT detected."
    err ""
    err "  Synesis requires at least one 48GB GPU for the Qwen 2.5 Coder 32B model."
    err "  Install the 'NVIDIA GPU Operator' from OperatorHub and create a ClusterPolicy."
    err ""
    err "  Docs: https://docs.nvidia.com/datacenter/cloud-native/openshift/latest/install-gpu-ocp.html"
    PREFLIGHT_FAILURES=$((PREFLIGHT_FAILURES + 1))
    return 1
}

# ---------------------------------------------------------------------------
# Preflight gate -- abort if critical operators are missing (unless --force)
# ---------------------------------------------------------------------------
preflight_gate() {
    if [[ "$PREFLIGHT_FAILURES" -gt 0 ]]; then
        err ""
        err "$PREFLIGHT_FAILURES critical component(s) missing."
        if [[ "$FORCE" == "true" ]]; then
            warn "Continuing anyway (--force). Deployment will likely fail without these components."
        else
            err "Fix the above issues and re-run, or use --force to continue anyway."
            exit 1
        fi
    fi
}

create_namespaces() {
    log "Creating Synesis namespaces..."
    local namespaces=(
        synesis-models synesis-gateway synesis-planner synesis-rag
        synesis-sandbox synesis-search synesis-lsp synesis-webui
    )
    for ns in "${namespaces[@]}"; do
        oc create namespace "$ns" 2>/dev/null || log "  Namespace $ns already exists"
        oc label namespace "$ns" app.kubernetes.io/part-of=synesis --overwrite
    done
}

# ---------------------------------------------------------------------------
# GHCR pull secrets for private container images
#
# When Synesis images are in a private GHCR repo, OpenShift needs credentials
# to pull them. This creates a docker-registry secret and links it to the
# default service account in each namespace.
#
# Use GITHUB_USERNAME (or GITHUB_USER) and GITHUB_TOKEN for non-interactive.
# ---------------------------------------------------------------------------
configure_ghcr_pull_secrets() {
    local gh_user="${GITHUB_USERNAME:-${GITHUB_USER:-}}"
    local gh_token="${GITHUB_TOKEN:-}"

    # Prompt if --ghcr-creds and values missing
    if [[ "$GHCR_CREDS" == "true" ]] && [[ -z "$gh_user" || -z "$gh_token" ]]; then
        if [[ -t 0 ]]; then
            log "GitHub credentials for GHCR (private container images)"
            [[ -z "$gh_user" ]] && read -rp "  GitHub username: " gh_user
            [[ -z "$gh_token" ]] && read -rsp "  GitHub token (or PAT): " gh_token && echo ""
        else
            warn "Cannot prompt for credentials (non-interactive). Set GITHUB_USERNAME and GITHUB_TOKEN."
            return 1
        fi
    fi

    if [[ -z "$gh_user" || -z "$gh_token" ]]; then
        return 0
    fi

    log "Creating GHCR pull secrets in Synesis namespaces..."
    local namespaces=(
        synesis-gateway synesis-planner synesis-rag synesis-sandbox
        synesis-search synesis-lsp synesis-webui
    )
    for ns in "${namespaces[@]}"; do
        if oc get namespace "$ns" &>/dev/null; then
            oc create secret docker-registry ghcr-pull-secret \
                --docker-server=ghcr.io \
                --docker-username="$gh_user" \
                --docker-password="$gh_token" \
                -n "$ns" \
                --dry-run=client -o yaml | oc apply -f -
            oc secrets link default ghcr-pull-secret --for=pull -n "$ns"
            # synesis-planner namespace: health monitor uses custom SA
            if [[ "$ns" == "synesis-planner" ]]; then
                oc secrets link synesis-health-monitor ghcr-pull-secret --for=pull -n "$ns" 2>/dev/null || true
            fi
        fi
    done
    log "  GHCR pull secrets configured (ghcr.io)"
}

main() {
    log "=== Synesis Bootstrap ==="
    log ""

    check_prerequisites

    log ""
    log "--- Preflight: Required Operators ---"
    verify_rhoai  || true
    verify_gpu_operator || true
    preflight_gate

    log ""
    log "--- Namespaces ---"
    create_namespaces

    if [[ "$SKIP_GHCR_CREDS" != "true" ]]; then
        log ""
        log "--- GHCR Pull Secrets (private images) ---"
        if [[ "$GHCR_CREDS" == "true" ]] || [[ -n "${GITHUB_USERNAME:-}${GITHUB_USER:-}" && -n "${GITHUB_TOKEN:-}" ]]; then
            configure_ghcr_pull_secrets || true
        else
            log "  Skipped (use --ghcr-creds to prompt, or set GITHUB_USERNAME + GITHUB_TOKEN)"
        fi
    fi

    log ""
    log "=== Bootstrap complete ==="
    log ""
    log "Next steps:"
    log "  1. Deploy models via OpenShift AI dashboard (Model Hub or HuggingFace hf://)"
    log "  2. Update base/gateway/litellm-route.yaml with your cluster domain"
    log "  3. Run: ./scripts/deploy.sh dev"
}

main "$@"
