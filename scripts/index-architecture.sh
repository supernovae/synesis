#!/usr/bin/env bash
set -euo pipefail

# Synesis Architecture Whitepaper Indexer Trigger
#
# Creates/updates the sources ConfigMap and runs the indexer Job.
#
# Usage:
#   ./scripts/index-architecture.sh
#   ./scripts/index-architecture.sh --document "AWS Well-Architected Framework"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

INDEXER_IMAGE="${SYNESIS_ARCH_INDEXER_IMAGE:-synesis-indexer-architecture:latest}"
NAMESPACE="synesis-rag"
DOCUMENT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --document) DOCUMENT="$2"; shift 2 ;;
        --image) INDEXER_IMAGE="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

SOURCES_FILE="$PROJECT_ROOT/base/rag/indexers/architecture/sources.yaml"

if [[ ! -f "$SOURCES_FILE" ]]; then
    echo "ERROR: Sources file not found: $SOURCES_FILE"
    exit 1
fi

log "=== Synesis Architecture Whitepaper Indexer ==="
log "Image: $INDEXER_IMAGE"
[[ -n "$DOCUMENT" ]] && log "Document filter: $DOCUMENT"

log "Creating/updating sources ConfigMap..."
oc create configmap architecture-indexer-sources \
    --from-file=sources.yaml="$SOURCES_FILE" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | oc apply -f -

JOB_NAME="index-architecture-$(date +%s)"
EXTRA_ARGS=""
[[ -n "$DOCUMENT" ]] && EXTRA_ARGS="--document \"$DOCUMENT\""

log "Cleaning up previous indexer jobs..."
oc delete job -n "$NAMESPACE" -l app.kubernetes.io/component=rag-indexer-architecture --ignore-not-found

log "Creating indexer job: $JOB_NAME"

cat <<EOF | oc apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB_NAME
  namespace: $NAMESPACE
  labels:
    app.kubernetes.io/part-of: synesis
    app.kubernetes.io/component: rag-indexer-architecture
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: indexer-architecture
        app.kubernetes.io/part-of: synesis
    spec:
      restartPolicy: OnFailure
      containers:
        - name: indexer
          image: $INDEXER_IMAGE
          args:
            - --sources
            - /data/sources.yaml
            $EXTRA_ARGS
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: "2"
              memory: 2Gi
          volumeMounts:
            - name: sources
              mountPath: /data/sources.yaml
              subPath: sources.yaml
              readOnly: true
      volumes:
        - name: sources
          configMap:
            name: architecture-indexer-sources
EOF

log "Job created. Monitoring..."
oc wait --for=condition=complete "job/$JOB_NAME" -n "$NAMESPACE" --timeout=600s || {
    log "WARNING: Job did not complete within timeout"
    log "Check logs: oc logs -n $NAMESPACE job/$JOB_NAME"
    exit 1
}

log ""
log "=== Architecture whitepaper indexing complete ==="
