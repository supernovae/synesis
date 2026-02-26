#!/usr/bin/env bash
set -euo pipefail

# Synesis Bootstrap Script
#
# Prepares an OpenShift cluster for Synesis deployment.
# Requires: RHOAI operator + NVIDIA GPU Operator already installed.
#
# Usage: ./scripts/bootstrap.sh [--skip-milvus-operator] [--force]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

SKIP_MILVUS_OPERATOR=false
FORCE=false

for arg in "$@"; do
    case "$arg" in
        --skip-milvus-operator) SKIP_MILVUS_OPERATOR=true ;;
        --force) FORCE=true ;;
        --help|-h)
            echo "Usage: $0 [--skip-milvus-operator] [--force]"
            echo ""
            echo "Prepares an OpenShift cluster for Synesis deployment."
            echo "  --skip-milvus-operator  Skip Milvus Operator Helm install"
            echo "  --force                 Continue even if RHOAI/GPU checks fail"
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

# ---------------------------------------------------------------------------
# Milvus Operator install
#
# OpenShift-specific: must set securityContext for restricted PSA compliance.
# Also: longer timeout + retry for clusters that are autoscaling.
# ---------------------------------------------------------------------------
check_cluster_allocatable() {
    log "Checking cluster allocatable resources for Milvus Operator..."

    local total_cpu_millicores=0
    local total_mem_bytes=0

    while IFS=$'\t' read -r cpu mem; do
        [[ -z "$cpu" ]] && continue
        if [[ "$cpu" == *m ]]; then
            total_cpu_millicores=$((total_cpu_millicores + ${cpu%m}))
        else
            total_cpu_millicores=$((total_cpu_millicores + cpu * 1000))
        fi
        if [[ "$mem" == *Ki ]]; then
            total_mem_bytes=$((total_mem_bytes + ${mem%Ki} * 1024))
        elif [[ "$mem" == *Mi ]]; then
            total_mem_bytes=$((total_mem_bytes + ${mem%Mi} * 1024 * 1024))
        elif [[ "$mem" == *Gi ]]; then
            total_mem_bytes=$((total_mem_bytes + ${mem%Gi} * 1024 * 1024 * 1024))
        fi
    done < <(oc get nodes -o jsonpath='{range .items[*]}{.status.allocatable.cpu}{"\t"}{.status.allocatable.memory}{"\n"}{end}' 2>/dev/null)

    local total_cpu=$((total_cpu_millicores / 1000))
    local total_mem_gi=$((total_mem_bytes / 1024 / 1024 / 1024))

    log "  Cluster allocatable: ~${total_cpu} CPU cores, ~${total_mem_gi}Gi memory"

    if [[ "$total_cpu" -lt 2 ]]; then
        warn "Less than 2 allocatable CPU cores. Milvus Operator may not schedule."
        warn "  If the cluster is autoscaling, wait for new nodes and re-run."
        return 1
    fi

    return 0
}

dump_milvus_diagnostics() {
    log ""
    log "--- Milvus Operator Diagnostics ---"
    log "Pods:"
    oc get pods -n milvus-operator -o wide 2>/dev/null || true
    log ""
    log "Pod describe (last 40 lines):"
    oc describe pods -n milvus-operator 2>/dev/null | tail -40 || true
    log ""
    log "Recent events:"
    oc get events -n milvus-operator --sort-by='.lastTimestamp' 2>/dev/null | tail -20 || true
    log "--- End Diagnostics ---"
}

install_milvus_operator() {
    if [[ "$SKIP_MILVUS_OPERATOR" == "true" ]]; then
        log "Skipping Milvus Operator install (--skip-milvus-operator)"
        return
    fi

    if ! command -v helm &>/dev/null; then
        err "helm not found. Install helm or use --skip-milvus-operator"
        exit 1
    fi

    # Check if already installed and running
    if oc get deployment milvus-operator -n milvus-operator &>/dev/null; then
        local ready
        ready=$(oc get deployment milvus-operator -n milvus-operator -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
        if [[ "$ready" -gt 0 ]]; then
            log "Milvus Operator already installed and running (${ready} ready replicas)"
            return 0
        fi
        log "Milvus Operator deployment exists but has 0 ready replicas, will attempt fix..."
    fi

    check_cluster_allocatable || {
        warn "Cluster may not have enough resources. Attempting Milvus install anyway..."
    }

    log "Installing Milvus Operator (OpenShift-compatible)..."
    oc create namespace milvus-operator 2>/dev/null || true

    # Label the namespace for PSA.  "baseline" enforcement is sufficient --
    # the remaining "restricted" gaps (capabilities.drop) are cosmetic warnings
    # that don't block pod creation under baseline.
    oc label namespace milvus-operator \
        pod-security.kubernetes.io/enforce=baseline \
        pod-security.kubernetes.io/audit=restricted \
        pod-security.kubernetes.io/warn=restricted \
        --overwrite 2>/dev/null || true

    # Grant the nonroot-v2 SCC to the operator's service account.
    # The default restricted-v2 SCC rejects any runAsUser outside the
    # namespace's allocated UID range.  nonroot-v2 allows any non-root UID
    # which is what the operator image needs (it runs as a high UID).
    local sa_name="milvus-operator"
    log "  Granting nonroot-v2 SCC to serviceaccount $sa_name..."
    oc adm policy add-scc-to-user nonroot-v2 \
        "system:serviceaccount:milvus-operator:${sa_name}" 2>/dev/null || {
        # Service account may not exist yet on first install; grant after helm
        log "  (will grant SCC after helm install creates the service account)"
    }

    helm repo add milvus-operator https://zilliztech.github.io/milvus-operator/ 2>/dev/null || true
    helm repo update milvus-operator

    # Values file removes runAsUser (lets OpenShift assign from range),
    # keeps runAsNonRoot:true, reduces resource requests for constrained clusters.
    # Note: the chart template hardcodes container securityContext to only
    # allowPrivilegeEscalation -- capabilities.drop can't be set via values,
    # so we patch the deployment post-install.
    local values_file="$PROJECT_ROOT/base/rag/milvus/openshift-operator-values.yaml"

    if [[ ! -f "$values_file" ]]; then
        err "OpenShift values file not found: $values_file"
        exit 1
    fi

    local max_attempts=3
    local attempt=1

    while [[ $attempt -le $max_attempts ]]; do
        log "  Install attempt $attempt/$max_attempts..."

        # Helm install/upgrade (without --wait so release is recorded even if
        # pods take time to schedule on an autoscaling cluster)
        helm -n milvus-operator upgrade --install milvus-operator milvus-operator/milvus-operator \
            -f "$values_file" \
            --timeout "10m" 2>&1 || true

        # Now grant the SCC (service account exists after first helm install)
        local helm_sa
        helm_sa=$(oc get deployment milvus-operator -n milvus-operator \
            -o jsonpath='{.spec.template.spec.serviceAccountName}' 2>/dev/null || echo "milvus-operator")
        oc adm policy add-scc-to-user nonroot-v2 \
            "system:serviceaccount:milvus-operator:${helm_sa}" 2>/dev/null || true

        # Patch the container securityContext to add capabilities.drop
        # (the chart template doesn't support this via values)
        log "  Patching deployment for OpenShift SCC compliance..."
        oc patch deployment milvus-operator -n milvus-operator --type=json -p='[
          {"op":"add","path":"/spec/template/spec/containers/0/securityContext/capabilities","value":{"drop":["ALL"]}},
          {"op":"add","path":"/spec/template/spec/containers/0/securityContext/seccompProfile","value":{"type":"RuntimeDefault"}}
        ]' 2>/dev/null || true

        # Delete any stuck pods from the old (bad UID) replicaset so the
        # new rollout can proceed
        oc delete pods -n milvus-operator -l app.kubernetes.io/name=milvus-operator \
            --field-selector=status.phase!=Running 2>/dev/null || true

        log "  Waiting for deployment rollout (up to 5m)..."
        if oc rollout status deployment/milvus-operator -n milvus-operator --timeout=300s 2>&1; then
            log "  Milvus Operator installed and running"
            return 0
        fi

        warn "Attempt $attempt: deployment not ready yet"
        dump_milvus_diagnostics

        if [[ $attempt -lt $max_attempts ]]; then
            local wait_seconds=$((30 * attempt))
            log "  Waiting ${wait_seconds}s before retry..."
            sleep "$wait_seconds"
        fi

        attempt=$((attempt + 1))
    done

    err "Milvus Operator install failed after $max_attempts attempts."
    err ""
    err "  The deployment could not reach a ready state. Common causes:"
    err ""
    err "    1. RESOURCE PRESSURE: Cluster is out of CPU/memory."
    err "       Check: oc describe nodes | grep -A5 'Allocated resources'"
    err "       Fix:   Add nodes or wait for autoscaler to provision them."
    err ""
    err "    2. IMAGE PULL FAILURE: Cannot pull milvusdb/milvus-operator image."
    err "       Check: oc get events -n milvus-operator | grep -i pull"
    err "       Fix:   Verify internet access or mirror the image internally."
    err ""
    err "    3. POD SECURITY: Pod rejected by admission controller."
    err "       Check: oc get events -n milvus-operator | grep -i secur"
    err "       Fix:   The values file should handle this, but check for SCC issues."
    err ""
    err "  Quick debug:"
    err "    oc get pods -n milvus-operator -o wide"
    err "    oc describe pod -n milvus-operator -l app.kubernetes.io/name=milvus-operator"
    err "    oc logs -n milvus-operator -l app.kubernetes.io/name=milvus-operator"
    err ""
    err "  To retry later: ./scripts/bootstrap.sh --skip-milvus-operator"
    err "  Then manually: helm -n milvus-operator upgrade --install milvus-operator \\"
    err "    milvus-operator/milvus-operator -f base/rag/milvus/openshift-operator-values.yaml"

    if [[ "$FORCE" == "true" ]]; then
        warn "Continuing (--force)."
    else
        exit 1
    fi
}

create_namespaces() {
    log "Creating Synesis namespaces..."
    local namespaces=(synesis-models synesis-gateway synesis-planner synesis-rag)
    for ns in "${namespaces[@]}"; do
        oc create namespace "$ns" 2>/dev/null || log "  Namespace $ns already exists"
        oc label namespace "$ns" app.kubernetes.io/part-of=synesis --overwrite
    done
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
    log "--- Milvus Operator ---"
    install_milvus_operator

    log ""
    log "--- Namespaces ---"
    create_namespaces

    log ""
    log "=== Bootstrap complete ==="
    log ""
    log "Next steps:"
    log "  1. Upload models to S3 storage (or configure HuggingFace download)"
    log "  2. Update base/model-serving/model-storage-secret.yaml with your S3 credentials"
    log "  3. Update base/gateway/litellm-route.yaml with your cluster domain"
    log "  4. Run: ./scripts/deploy.sh dev"
}

main "$@"
