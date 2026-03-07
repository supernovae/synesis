#!/usr/bin/env bash
set -euo pipefail

# Synesis Knowledge Base Indexer Trigger
#
# Loads curated ADR/architecture markdown documents from the container image
# into the synesis_catalog Milvus collection.  Documents are bundled in the
# image at build time — no ConfigMap or volume mount needed.
#
# Usage:
#   ./scripts/index-knowledge-base.sh
#   ./scripts/index-knowledge-base.sh --force     # re-embed all chunks
#   ./scripts/index-knowledge-base.sh --dry-run   # list files, don't index
#   ./scripts/index-knowledge-base.sh --image ghcr.io/…/indexer-knowledge-base:sha-abc

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INDEXER_IMAGE="${SYNESIS_KB_INDEXER_IMAGE:-synesis-indexer-knowledge-base:latest}"
NAMESPACE="synesis-rag"
EXTRA_ARGS=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force)   EXTRA_ARGS="$EXTRA_ARGS --force"; shift ;;
        --dry-run) EXTRA_ARGS="$EXTRA_ARGS --dry-run"; shift ;;
        --image)   INDEXER_IMAGE="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }

log "=== Synesis Knowledge Base Indexer ==="
log "Image: $INDEXER_IMAGE"

JOB_NAME="index-knowledge-base-$(date +%s)"

log "Cleaning up previous knowledge-base indexer jobs..."
oc delete job -n "$NAMESPACE" -l app.kubernetes.io/component=rag-indexer-knowledge-base --ignore-not-found

log "Creating indexer job: $JOB_NAME"

ARGS_BLOCK="            - --path
            - /data/knowledge-base"

if [[ -n "$EXTRA_ARGS" ]]; then
    for arg in $EXTRA_ARGS; do
        ARGS_BLOCK="$ARGS_BLOCK
            - $arg"
    done
fi

cat <<EOF | oc apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB_NAME
  namespace: $NAMESPACE
  labels:
    app.kubernetes.io/part-of: synesis
    app.kubernetes.io/component: rag-indexer-knowledge-base
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: indexer-knowledge-base
        app.kubernetes.io/part-of: synesis
    spec:
      restartPolicy: OnFailure
      imagePullSecrets:
        - name: ghcr-pull-secret
      containers:
        - name: indexer
          image: $INDEXER_IMAGE
          args:
$ARGS_BLOCK
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: "1"
              memory: 1Gi
EOF

log "Job created. Monitoring..."
oc wait --for=condition=complete "job/$JOB_NAME" -n "$NAMESPACE" --timeout=300s || {
    log "WARNING: Job did not complete within timeout"
    log "Check logs: oc logs -n $NAMESPACE job/$JOB_NAME"
    exit 1
}

log ""
log "=== Knowledge base indexing complete ==="
