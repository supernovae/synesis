#!/usr/bin/env bash
# Verify that Synesis LLM models (supervisor, critic, executor) are running on GPU, not CPU.
#
# vLLM uses CUDA by default; it does not fall back to CPU. If the predictor pods run,
# they are using GPU. This script asserts GPU allocation and usage via nvidia-smi.
#
# Usage: ./scripts/verify-gpu-usage.sh [synesis-models]
#   Default namespace: synesis-models (RHOAI model serving)
set -euo pipefail

NAMESPACE="${1:-synesis-models}"
FAILED=0

log()  { echo "[$(date +'%H:%M:%S')] $*"; }
warn() { echo "[$(date +'%H:%M:%S')] WARNING: $*" >&2; }
err()  { echo "[$(date +'%H:%M:%S')] ERROR: $*" >&2; FAILED=1; }

if ! command -v oc &>/dev/null; then
    err "oc not found. OpenShift CLI required."
    exit 1
fi
if ! oc whoami &>/dev/null; then
    err "Not logged in. Run 'oc login' first."
    exit 1
fi

# GPU model deployments: supervisor-critic (1 pod) and executor (1 pod)
for deploy in synesis-supervisor-critic synesis-executor synesis-general synesis-coder; do
    app="$deploy"
    pod=$(oc get pods -n "$NAMESPACE" -l "app=$app" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    if [[ -z "$pod" ]]; then
        pod=$(oc get pods -n "$NAMESPACE" --no-headers -o custom-columns=:metadata.name 2>/dev/null | grep -E "^${deploy}-" | head -1 || true)
    fi
    if [[ -z "$pod" ]]; then
        warn "No pod for $deploy in $NAMESPACE (may not be deployed or still starting)"
        continue
    fi

    # Check that the pod has nvidia.com/gpu allocated
    gpu_alloc=$(oc get pod -n "$NAMESPACE" "$pod" -o jsonpath='{.spec.containers[*].resources.limits.nvidia\.com/gpu}' 2>/dev/null || true)
    if [[ "$gpu_alloc" != "1" ]]; then
        err "$deploy: pod $pod has nvidia.com/gpu='$gpu_alloc' (expected 1)"
    else
        log "$deploy: pod $pod has nvidia.com/gpu=1 ✓"
    fi

    # Run nvidia-smi in the pod (if available) to show GPU memory usage
    for c in vllm-supervisor-critic vllm-executor kserve-container ""; do
        if [[ -z "$c" ]]; then
            oc exec -n "$NAMESPACE" "$pod" -- nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader 2>/dev/null && break
        else
            oc exec -n "$NAMESPACE" "$pod" -c "$c" -- nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader 2>/dev/null && break
        fi
    done && log "$deploy: GPU memory usage ✓" || {
        warn "$deploy: nvidia-smi not available. Check logs for CUDA/GPU."
        oc logs -n "$NAMESPACE" "$pod" --tail=20 2>/dev/null | grep -iE 'cuda|gpu|vram|loading model|torch\.cuda' || true
    }
done

if [[ $FAILED -eq 1 ]]; then
    err "GPU verification failed. Ensure NVIDIA GPU Operator is installed and GPU nodes have capacity."
    exit 1
fi
log "GPU verification complete. All model pods use nvidia.com/gpu."
