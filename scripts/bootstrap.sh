#!/usr/bin/env bash
set -euo pipefail

# Synesis Bootstrap Script
#
# Prepares an OpenShift cluster for Synesis deployment.
#
# Usage: ./scripts/bootstrap.sh [--mode MODE] [--force] [--force-tokens]
#            [--ghcr-creds] [--skip-ghcr-creds] [--hf-token] [--github-token]
#
#   --mode MODE        Deployment mode: "local" (default, requires RHOAI + GPU)
#                      or "api" (API-only, no GPU/model-serving needed)
#   --force            Continue even if operator preflight checks fail
#   --force-tokens     Overwrite existing token secrets without prompting
#   --ghcr-creds       Prompt for GitHub credentials to create GHCR pull secrets
#   --skip-ghcr-creds  Skip GHCR pull secret setup (use when images are public)
#   --hf-token         Prompt for HuggingFace token (gated model access)
#   --github-token     Create synesis-github-token in synesis-rag (RAG indexer)

MODE="local"
FORCE=false
FORCE_TOKENS=false
GHCR_CREDS=false
SKIP_GHCR_CREDS=false
HF_TOKEN=false
GITHUB_TOKEN_FLAG=false
for arg in "$@"; do
    case "$arg" in
        --mode=*) MODE="${arg#*=}" ;;
        --openrouter|--api) MODE="api" ;;
        --force) FORCE=true ;;
        --force-tokens) FORCE_TOKENS=true ;;
        --ghcr-creds) GHCR_CREDS=true ;;
        --skip-ghcr-creds) SKIP_GHCR_CREDS=true ;;
        --hf-token) HF_TOKEN=true ;;
        --github-token) GITHUB_TOKEN_FLAG=true ;;
        --help|-h)
            echo "Usage: $0 [--mode MODE] [--force] [--force-tokens] [--ghcr-creds] [--skip-ghcr-creds] [--hf-token] [--github-token]"
            echo ""
            echo "Prepares an OpenShift cluster for Synesis deployment."
            echo ""
            echo "Modes:"
            echo "  --mode=local       (default) Full deployment: RHOAI + GPU + local vLLM model serving"
            echo "  --mode=api         API-only: skip RHOAI/GPU checks, no model PVC, no local model serving"
            echo "  --api / --openrouter  Shorthand for --mode=api"
            echo ""
            echo "Options:"
            echo "  --force            Continue even if operator preflight checks fail"
            echo "  --force-tokens     Overwrite existing token secrets without prompting"
            echo "  --ghcr-creds       Prompt for GitHub user/token to create GHCR pull secrets (private images)"
            echo "  --skip-ghcr-creds  Skip GHCR pull secret setup (default when not prompting)"
            echo "  --hf-token         Prompt for HuggingFace token (gated model access, avoids throttling)"
            echo "  --github-token     Create synesis-github-token in synesis-rag (RAG indexer jobs)"
            echo ""
            echo "Environment variables (non-interactive):"
            echo "  GITHUB_USERNAME / GITHUB_USER, GITHUB_TOKEN, HUGGINGFACE_TOKEN"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg"
            exit 1
            ;;
    esac
done

case "$MODE" in
    local|api) ;;
    openrouter) MODE="api" ;;
    *)
        echo "Unknown mode: $MODE (expected 'local' or 'api')"
        exit 1
        ;;
esac

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
# RHBK (Red Hat Build of Keycloak) operator detection
# ---------------------------------------------------------------------------
verify_keycloak_operator() {
    log "Verifying Red Hat Build of Keycloak operator..."

    if oc get crd keycloaks.k8s.keycloak.org &>/dev/null; then
        log "  RHBK operator: installed (Keycloak CRD exists)"
        return 0
    fi

    if oc get csv --all-namespaces 2>/dev/null | grep -qi 'keycloak-operator\|rhbk-operator'; then
        log "  RHBK operator: installed (CSV found, CRD may still be initializing)"
        return 0
    fi

    warn "Red Hat Build of Keycloak operator NOT detected."
    warn ""
    warn "  Install from OperatorHub: 'Red Hat build of Keycloak'"
    warn "  Or community: 'Keycloak Operator'"
    warn ""
    warn "  Keycloak is required for SSO authentication."
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
        synesis-admin synesis-auth
    )
    for ns in "${namespaces[@]}"; do
        oc create namespace "$ns" 2>/dev/null || log "  Namespace $ns already exists"
        oc label namespace "$ns" app.kubernetes.io/part-of=synesis --overwrite
    done
}

# ---------------------------------------------------------------------------
# Shared EFS PVC for model weights
#
# All models share a single EFS volume (synesis-models-efs) with per-role
# subpaths. Requires efs-sc StorageClass provisioned by Terraform.
# ---------------------------------------------------------------------------
create_model_pvc() {
    log "Ensuring shared EFS PVC in synesis-models..."

    local pvc="synesis-models-efs"
    if oc get pvc "$pvc" -n synesis-models &>/dev/null; then
        log "  PVC $pvc exists"
    else
        log "  Creating $pvc PVC (requires efs-sc StorageClass from Terraform)..."
        oc apply -f "$PROJECT_ROOT/pipelines/manifests/synesis-models-efs-pvc.yaml"
    fi
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
        synesis-search synesis-lsp synesis-webui synesis-admin synesis-auth
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

    # Also create synesis-github-token in synesis-rag (RAG indexer jobs use this for GitHub API)
    configure_github_token_rag "$gh_token"
}

# ---------------------------------------------------------------------------
# Token management helpers
#
# ensure_secret_in_ns: check if a secret exists in a namespace, prompt to
# overwrite if interactive, respect --force-tokens for silent rotation.
# Returns 0 if the secret should be written, 1 if skipped.
# ---------------------------------------------------------------------------
_should_write_secret() {
    local secret_name="$1" ns="$2"

    if oc get secret "$secret_name" -n "$ns" &>/dev/null; then
        if [[ "$FORCE_TOKENS" == "true" ]]; then
            log "  $ns/$secret_name: exists — overwriting (--force-tokens)"
            return 0
        elif [[ -t 0 ]]; then
            local reply=""
            read -rp "  $ns/$secret_name already exists. Overwrite? [y/N] " reply
            if [[ "$reply" =~ ^[Yy] ]]; then
                return 0
            else
                log "  $ns/$secret_name: keeping existing"
                return 1
            fi
        else
            log "  $ns/$secret_name: exists — keeping (use --force-tokens to overwrite)"
            return 1
        fi
    fi
    return 0
}

_write_secret() {
    local secret_name="$1" ns="$2"; shift 2
    oc create namespace "$ns" 2>/dev/null || true
    oc create secret generic "$secret_name" "$@" \
        -n "$ns" --dry-run=client -o yaml | oc apply -f -
}

# ---------------------------------------------------------------------------
# GitHub token for RAG indexer jobs
#
# The code indexer needs GITHUB_TOKEN for cloning repos and fetching PR
# metadata. Stored as synesis-github-token with key "token".
# ---------------------------------------------------------------------------
configure_github_token_rag() {
    local gh_token="${1:-${GITHUB_TOKEN:-}}"

    if [[ -z "$gh_token" ]]; then
        return 0
    fi

    local namespaces=(synesis-rag)
    for ns in "${namespaces[@]}"; do
        if _should_write_secret "synesis-github-token" "$ns"; then
            _write_secret "synesis-github-token" "$ns" --from-literal=token="$gh_token"
            log "  GitHub token stored in $ns/synesis-github-token"
        fi
    done
}

# ---------------------------------------------------------------------------
# HuggingFace token for model serving and RAG services
#
# KServe uses HF_TOKEN when pulling gated models from HuggingFace (hf://).
# RAG microservices (keyword-service, embedder) may need it for gated
# sentence-transformers. Prevents throttling on public models.
# ---------------------------------------------------------------------------
configure_hf_token() {
    local hf_token="${HUGGINGFACE_TOKEN:-}"

    if [[ "$HF_TOKEN" == "true" ]] && [[ -z "$hf_token" ]]; then
        if [[ -t 0 ]]; then
            log "HuggingFace token (avoids throttling, enables gated models)"
            read -rsp "  HuggingFace token (optional, press Enter to skip): " hf_token && echo ""
        else
            warn "Cannot prompt (non-interactive). Set HUGGINGFACE_TOKEN to provide HF token."
            return 0
        fi
    fi

    if [[ -z "$hf_token" ]]; then
        return 0
    fi

    local namespaces=(synesis-models synesis-rag)
    for ns in "${namespaces[@]}"; do
        if _should_write_secret "synesis-hf-token" "$ns"; then
            _write_secret "synesis-hf-token" "$ns" --from-literal=HF_TOKEN="$hf_token"
            log "  HuggingFace token stored in $ns/synesis-hf-token"
        fi
    done
}

install_milvus_operator() {
    local ns="milvus-operator"
    local release="milvus-operator"
    local repo_url="https://zilliztech.github.io/milvus-operator/"
    local chart="milvus-operator/milvus-operator"

    local ocp_values=(
        --set "securityContext.capabilities.drop[0]=ALL"
        --set "securityContext.seccompProfile.type=RuntimeDefault"
        --set "podSecurityContext.runAsUser=null"
    )

    if helm list -n "$ns" 2>/dev/null | grep -q "$release"; then
        log "  Milvus Operator already installed in $ns — upgrading"
        helm upgrade "$release" "$chart" -n "$ns" --create-namespace --wait \
            "${ocp_values[@]}" 2>&1 | while read -r line; do log "  $line"; done
    else
        log "  Adding Milvus Operator Helm repo..."
        helm repo add milvus-operator "$repo_url" 2>/dev/null || true
        helm repo update milvus-operator 2>&1 | while read -r line; do log "  $line"; done
        log "  Installing Milvus Operator..."
        helm install "$release" "$chart" \
            -n "$ns" --create-namespace --wait \
            "${ocp_values[@]}" 2>&1 | while read -r line; do log "  $line"; done
    fi

    log "  Waiting for Milvus Operator CRD..."
    for _ in $(seq 1 30); do
        if oc get crd milvus.milvus.io &>/dev/null; then
            log "  Milvus CRD available"
            break
        fi
        sleep 5
    done

    # The operator's Helm sub-charts (etcd, MinIO) include OpenShift SCC
    # resources. Grant the operator SA read/write access to SCCs so
    # reconciliation doesn't fail on OpenShift.
    log "  Granting Milvus Operator SCC access for OpenShift..."
    oc apply -f - <<'EOSCC'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: milvus-operator-scc
  labels:
    app.kubernetes.io/part-of: synesis
rules:
  - apiGroups: ["security.openshift.io"]
    resources: ["securitycontextconstraints"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete", "use"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: milvus-operator-scc
  labels:
    app.kubernetes.io/part-of: synesis
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: milvus-operator-scc
subjects:
  - kind: ServiceAccount
    name: milvus-operator
    namespace: milvus-operator
EOSCC
    log "  Milvus Operator SCC ClusterRoleBinding created"

    # Milvus v2.6 init container and image require UIDs outside the
    # namespace-allocated range. Grant anyuid to the default SA.
    log "  Granting anyuid SCC to synesis-rag default SA..."
    oc adm policy add-scc-to-user anyuid -z default -n synesis-rag 2>/dev/null || true

    # Milvus v2.6 woodpecker WAL requires S3. Create placeholder secret
    # if it doesn't exist — user must populate with real keys.
    if ! oc get secret milvus-s3-secret -n synesis-rag &>/dev/null; then
        log "  Creating placeholder milvus-s3-secret (update with real AWS keys)"
        oc create secret generic milvus-s3-secret \
            -n synesis-rag \
            --from-literal=accesskey="REPLACE_ME" \
            --from-literal=secretkey="REPLACE_ME" \
            --dry-run=client -o yaml | oc apply -f -
        log "  WARNING: Update milvus-s3-secret with real AWS keys."
        log "    See docs/MILVUS_SCALING.md for IAM user setup."
    else
        log "  milvus-s3-secret already exists"
    fi
}

main() {
    log "=== Synesis Bootstrap (mode: $MODE) ==="
    log ""

    check_prerequisites

    log ""
    log "--- Preflight: Required Operators ---"
    if [[ "$MODE" == "local" ]]; then
        verify_rhoai  || true
        verify_gpu_operator || true
    else
        log "  RHOAI / GPU Operator: skipped (api mode — no local model serving)"
    fi
    verify_keycloak_operator || true
    preflight_gate

    log ""
    log "--- Namespaces ---"
    create_namespaces

    if [[ "$MODE" == "local" ]]; then
        log ""
        log "--- Model PVC (EFS) ---"
        create_model_pvc
    else
        log ""
        log "--- Model PVC (EFS) ---"
        log "  Skipped (api mode — models served via API providers, no local weights)"
    fi

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
    log "--- GitHub Token (RAG indexer jobs) ---"
    if [[ "$GITHUB_TOKEN_FLAG" == "true" ]] || [[ -n "${GITHUB_TOKEN:-}" ]]; then
        local gh_token="${GITHUB_TOKEN:-}"
        if [[ -z "$gh_token" ]] && [[ "$GITHUB_TOKEN_FLAG" == "true" ]] && [[ -t 0 ]]; then
            log "GitHub token for RAG indexer (clone repos, fetch PR metadata)"
            read -rsp "  GitHub token (or PAT): " gh_token && echo ""
        fi
        if [[ -n "$gh_token" ]]; then
            configure_github_token_rag "$gh_token"
        else
            warn "No token provided. Set GITHUB_TOKEN or run with --ghcr-creds (same token works for both)."
        fi
    else
        log "  Skipped (use --github-token to prompt, or set GITHUB_TOKEN env var)"
    fi

    log ""
    log "--- Milvus Operator (RAG vector store) ---"
    install_milvus_operator || true

    log ""
    log "--- HuggingFace Token (gated model access) ---"
    if [[ "$HF_TOKEN" == "true" ]] || [[ -n "${HUGGINGFACE_TOKEN:-}" ]]; then
        configure_hf_token || true
    else
        log "  Skipped (use --hf-token to prompt, or set HUGGINGFACE_TOKEN)"
        log "  Recommended for gated models and to avoid rate limiting"
    fi

    log ""
    log "=== Bootstrap complete (mode: $MODE) ==="
    log ""
    log "Next steps:"
    if [[ "$MODE" == "local" ]]; then
        log "  1. Download models:      ./scripts/run-model-pipeline.sh --profile=small"
        log "  2. Build images:         ./scripts/build-images.sh --push"
        log "  3. Deploy services:      ./scripts/deploy.sh dev"
        log "  4. Deploy indexer:       ./scripts/deploy-indexer.sh"
        log ""
        log "  If models fail:          ./scripts/list-model-runtimes.sh"
    else
        log "  1. Build images:         ./scripts/build-images.sh --push"
        log "  2. Deploy services:      ./scripts/deploy.sh api"
        log "  3. Deploy indexer:       ./scripts/deploy-indexer.sh"
        log ""
        log "  No local models — all LLM traffic routes through API providers."
        log "  Configure provider API keys and model endpoints via the Admin UI,"
        log "  or set defaults before deploy (e.g. for OpenRouter):"
        log "    oc create secret generic openrouter-api-key \\"
        log "      --from-literal=api-key=sk-or-v1-YOUR_KEY \\"
        log "      -n synesis-gateway --dry-run=client -o yaml | oc apply -f -"
    fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

main "$@"
