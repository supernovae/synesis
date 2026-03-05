#!/usr/bin/env bash
# ONE-TIME MIGRATION: Remove old model deployments, PVCs, and pipeline artifacts
# from the pre-v1 layout (2 shared deployments, 2 PVCs) so deploy.sh dev starts
# clean with the new per-role layout (4 PVCs, 3 deployments).
#
# Safe to run multiple times — all commands use --ignore-not-found.
#
# After running this, use:
#   ./scripts/run-model-pipeline.sh --profile=small   # download models
#   ./scripts/deploy.sh dev                            # deploy everything
#
# Delete this script once migration is complete.

set -euo pipefail

NS="${SYNESIS_NS:-synesis-models}"

log()  { echo "[$(date +%H:%M:%S)] $*"; }
warn() { echo "[$(date +%H:%M:%S)] WARN: $*" >&2; }

log "=== Synesis v1 Model Migration ==="
log "Namespace: $NS"
log ""

# -------------------------------------------------------------------------
# 1. Delete old model deployments
# -------------------------------------------------------------------------
log "--- Step 1: Delete old model deployments ---"

for deploy in synesis-supervisor-critic synesis-executor; do
    if oc get deployment "$deploy" -n "$NS" &>/dev/null; then
        log "  Scaling down $deploy..."
        oc scale deployment "$deploy" -n "$NS" --replicas=0 2>/dev/null || true
        sleep 2
        log "  Deleting deployment $deploy..."
        oc delete deployment "$deploy" -n "$NS" --ignore-not-found
    else
        log "  $deploy not found (already removed or never deployed)"
    fi
done

# Also delete old services and routes
for svc in synesis-supervisor synesis-critic synesis-executor; do
    oc delete service "$svc" -n "$NS" --ignore-not-found 2>/dev/null && log "  Deleted service $svc" || true
done

oc delete route synesis-executor-api -n "$NS" --ignore-not-found 2>/dev/null && log "  Deleted route synesis-executor-api" || true

log ""

# -------------------------------------------------------------------------
# 2. Delete old PVCs
# -------------------------------------------------------------------------
log "--- Step 2: Delete old PVCs ---"

for pvc in modelcar-build-pvc executor-build-pvc; do
    if oc get pvc "$pvc" -n "$NS" &>/dev/null; then
        log "  Deleting PVC $pvc..."
        oc delete pvc "$pvc" -n "$NS" --ignore-not-found
    else
        log "  $pvc not found (already removed)"
    fi
done

# Also check the old synesis namespace for stale PVCs
for old_ns in synesis; do
    for pvc in modelcar-build-pvc executor-build-pvc; do
        if oc get pvc "$pvc" -n "$old_ns" &>/dev/null 2>/dev/null; then
            log "  Deleting stale PVC $pvc in namespace $old_ns..."
            oc delete pvc "$pvc" -n "$old_ns" --ignore-not-found
        fi
    done
done

log ""

# -------------------------------------------------------------------------
# 3. Delete old KFP pipeline runs (if Data Science Pipelines is available)
# -------------------------------------------------------------------------
log "--- Step 3: Clean old pipeline runs ---"

if oc get crd datasciencepipelinesapplications.datasciencepipelines.opendatahub.io &>/dev/null 2>/dev/null; then
    OLD_JOBS=$(oc get jobs -n "$NS" -o name 2>/dev/null | grep -E "manager-modelcar|executor-pipeline|synesis-cleanup" || true)
    if [[ -n "$OLD_JOBS" ]]; then
        log "  Deleting old pipeline jobs..."
        echo "$OLD_JOBS" | xargs -r oc delete -n "$NS" --ignore-not-found 2>/dev/null || true
    else
        log "  No old pipeline jobs found"
    fi
else
    log "  Data Science Pipelines not installed; skipping pipeline cleanup"
fi

log ""

# -------------------------------------------------------------------------
# 4. Delete old InferenceServices (if any exist from earlier KServe approach)
# -------------------------------------------------------------------------
log "--- Step 4: Clean old InferenceServices ---"

for isvc in synesis-supervisor synesis-executor; do
    oc delete inferenceservice "$isvc" -n "$NS" --ignore-not-found 2>/dev/null && log "  Deleted InferenceService $isvc" || true
done

log ""

# -------------------------------------------------------------------------
# 5. Summary
# -------------------------------------------------------------------------
log "=== Migration complete ==="
log ""
log "Old artifacts removed:"
log "  - Deployments: synesis-supervisor-critic, synesis-executor"
log "  - PVCs: modelcar-build-pvc (120Gi), executor-build-pvc (50Gi)"
log "  - Services, routes, and pipeline jobs"
log ""
log "Next steps:"
log "  1. Download models:  ./scripts/run-model-pipeline.sh --profile=small"
log "  2. Deploy:           ./scripts/deploy.sh dev"
log ""
log "New layout will create:"
log "  - PVCs: synesis-router-pvc (25Gi), synesis-coder-pvc (200Gi), synesis-critic-pvc (100Gi)"
log "  - Deployments: synesis-supervisor-critic (router), synesis-executor (critic), synesis-coder (coder)"
log "  - Summarizer: InferenceService via hf:// (no PVC)"
