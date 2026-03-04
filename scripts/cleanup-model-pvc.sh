#!/usr/bin/env bash
# Clean old model data from modelcar-build-pvc to free space before downloading a new model.
#
# Use when switching models (e.g. Qwen3.5-35B-A3B → Qwen2.5-32B-Instruct).
# Scales down supervisor-critic, deletes PVC contents, scales back up.
#
# Usage: ./scripts/cleanup-model-pvc.sh [modelcar-build-pvc|executor-build-pvc]
#   Default: modelcar-build-pvc (manager/supervisor model)
#
# After cleanup, re-run the pipeline to download the new model:
#   ./scripts/run-pipelines.sh manager

set -euo pipefail

PVC_NAME="${1:-modelcar-build-pvc}"
NS="${SYNESIS_NS:-synesis-models}"
JOB_NAME="synesis-cleanup-${PVC_NAME}-$(date +%s)"

case "$PVC_NAME" in
    modelcar-build-pvc)
        DEPLOYMENT="synesis-supervisor-critic-predictor"
        CLEAN_PATH="/data/models"
        ;;
    executor-build-pvc)
        DEPLOYMENT="synesis-executor-predictor"
        CLEAN_PATH="/data/executor-model"
        ;;
    *)
        echo "Unknown PVC. Use modelcar-build-pvc or executor-build-pvc."
        exit 1
        ;;
esac

log() { echo "[$(date +%H:%M:%S)] $*"; }
warn() { echo "[$(date +%H:%M:%S)] WARN: $*" >&2; }

log "Cleaning $PVC_NAME in $NS (path: $CLEAN_PATH)"

# Scale down deployment so we can mount the PVC
if oc get deployment "$DEPLOYMENT" -n "$NS" &>/dev/null; then
    REPLICAS=$(oc get deployment "$DEPLOYMENT" -n "$NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")
    log "Scaling down $DEPLOYMENT (replicas=$REPLICAS)..."
    oc scale deployment "$DEPLOYMENT" -n "$NS" --replicas=0
    log "Waiting for pod to terminate..."
    oc rollout status deployment/"$DEPLOYMENT" -n "$NS" --timeout=120s 2>/dev/null || sleep 10
else
    warn "Deployment $DEPLOYMENT not found; PVC may already be free."
fi

# Run cleanup job
log "Creating cleanup job $JOB_NAME..."
cat <<EOF | oc apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB_NAME
  namespace: $NS
spec:
  ttlSecondsAfterFinished: 300
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      volumes:
        - name: pvc
          persistentVolumeClaim:
            claimName: $PVC_NAME
      containers:
        - name: cleanup
          image: registry.redhat.io/ubi9/ubi-minimal:9.4
          command: ["/bin/sh", "-c"]
          args:
            - |
              echo "Removing $CLEAN_PATH..."
              rm -rf ${CLEAN_PATH}/*
              rm -rf ${CLEAN_PATH}/.[!.]* 2>/dev/null || true
              echo "Done. Freed space on $PVC_NAME"
          volumeMounts:
            - name: pvc
              mountPath: /data
EOF

log "Waiting for job to complete..."
oc wait --for=condition=complete job/"$JOB_NAME" -n "$NS" --timeout=120s 2>/dev/null || {
    log "Job may still be running. Check: oc get job $JOB_NAME -n $NS"
    oc logs job/"$JOB_NAME" -n "$NS" -f 2>/dev/null || true
}

# Scale deployment back up
if oc get deployment "$DEPLOYMENT" -n "$NS" &>/dev/null; then
    log "Scaling $DEPLOYMENT back up (replicas=${REPLICAS:-1})..."
    oc scale deployment "$DEPLOYMENT" -n "$NS" --replicas="${REPLICAS:-1}"
fi

log "Cleanup complete. Re-download: ./scripts/run-pipelines.sh manager (or executor)"
