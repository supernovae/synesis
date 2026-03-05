#!/usr/bin/env bash
# Clean old model data from a per-role PVC to free space before downloading a new model.
#
# Reads models.yaml for PVC-to-deployment mapping.
#
# Usage:
#   ./scripts/cleanup-model-pvc.sh --role=router
#   ./scripts/cleanup-model-pvc.sh --role=critic
#   ./scripts/cleanup-model-pvc.sh --role=coder
#   ./scripts/cleanup-model-pvc.sh --role=general
#
# After cleanup, re-run the pipeline to download the new model:
#   ./scripts/run-model-pipeline.sh --role=router

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MODELS_YAML="$PROJECT_ROOT/models.yaml"
NS="${SYNESIS_NS:-synesis-models}"

# Use project venv if available (has PyYAML); fall back to system python3
PYTHON="${PROJECT_ROOT}/.venv/bin/python3"
[[ -x "$PYTHON" ]] || PYTHON="python3"

log() { echo "[$(date +%H:%M:%S)] $*"; }
warn() { echo "[$(date +%H:%M:%S)] WARN: $*" >&2; }

ROLE=""

for arg in "$@"; do
    case "$arg" in
        --role=*) ROLE="${arg#--role=}" ;;
        -h|--help)
            echo "Usage: $0 --role=<router|general|coder|critic>"
            exit 0
            ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

if [[ -z "$ROLE" ]]; then
    echo "ERROR: Specify --role=<router|general|coder|critic>"
    echo "Usage: $0 --role=<router|general|coder|critic>"
    exit 1
fi

ROLE_CONFIG=$("$PYTHON" -c "
import yaml, sys
with open('$MODELS_YAML') as f:
    cfg = yaml.safe_load(f)
role_def = cfg.get('roles', {}).get('$ROLE')
if not role_def:
    print('ERROR: Unknown role $ROLE', file=sys.stderr)
    sys.exit(1)
pvc = role_def.get('pvc_name', '')
subpath = role_def.get('pvc_subpath', '')
deploy = role_def.get('deployment_name', '')
if not pvc:
    print('ERROR: Role $ROLE has no pvc_name', file=sys.stderr)
    sys.exit(1)
print(f'{pvc}|{subpath}|{deploy}')
")
PVC_NAME=$(echo "$ROLE_CONFIG" | cut -d'|' -f1)
CLEAN_PATH="/data/$(echo "$ROLE_CONFIG" | cut -d'|' -f2)"
DEPLOYMENT=$(echo "$ROLE_CONFIG" | cut -d'|' -f3)

JOB_NAME="synesis-cleanup-${PVC_NAME}-$(date +%s)"

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

log "Cleanup complete. Re-download: ./scripts/run-model-pipeline.sh --role=$ROLE"
