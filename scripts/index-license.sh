#!/usr/bin/env bash
set -euo pipefail

# Synesis License Compliance Indexer Trigger
#
# Creates/updates the sources and compatibility ConfigMaps and runs the indexer Job.
#
# Usage:
#   ./scripts/index-license.sh
#   ./scripts/index-license.sh --license MIT
#   ./scripts/index-license.sh --force

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

INDEXER_IMAGE="${SYNESIS_LICENSE_INDEXER_IMAGE:-synesis-indexer-license:latest}"
NAMESPACE="synesis-rag"
LICENSE_FILTER=""
FORCE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --license) LICENSE_FILTER="$2"; shift 2 ;;
        --force) FORCE="--force"; shift ;;
        --image) INDEXER_IMAGE="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

SOURCES_FILE="$PROJECT_ROOT/base/rag/indexers/license/sources.yaml"
COMPAT_FILE="$PROJECT_ROOT/base/rag/indexers/license/compatibility.yaml"

if [[ ! -f "$SOURCES_FILE" ]]; then
    echo "ERROR: Sources file not found: $SOURCES_FILE"
    exit 1
fi

if [[ ! -f "$COMPAT_FILE" ]]; then
    echo "ERROR: Compatibility file not found: $COMPAT_FILE"
    exit 1
fi

log "=== Synesis License Compliance Indexer ==="
log "Image: $INDEXER_IMAGE"
[[ -n "$LICENSE_FILTER" ]] && log "License filter: $LICENSE_FILTER"
[[ -n "$FORCE" ]] && log "Force re-index: yes"

log "Creating/updating sources ConfigMap..."
oc create configmap license-indexer-sources \
    --from-file=sources.yaml="$SOURCES_FILE" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | oc apply -f -

log "Creating/updating compatibility ConfigMap..."
oc create configmap license-indexer-compatibility \
    --from-file=compatibility.yaml="$COMPAT_FILE" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | oc apply -f -

JOB_NAME="index-license-$(date +%s)"
EXTRA_ARGS="$FORCE"
[[ -n "$LICENSE_FILTER" ]] && EXTRA_ARGS="$EXTRA_ARGS --license \"$LICENSE_FILTER\""

log "Cleaning up previous indexer jobs..."
oc delete job -n "$NAMESPACE" -l app.kubernetes.io/component=rag-indexer-license --ignore-not-found

log "Creating indexer job: $JOB_NAME"

cat <<EOF | oc apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB_NAME
  namespace: $NAMESPACE
  labels:
    app.kubernetes.io/part-of: synesis
    app.kubernetes.io/component: rag-indexer-license
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: indexer-license
        app.kubernetes.io/part-of: synesis
    spec:
      restartPolicy: OnFailure
      containers:
        - name: indexer
          image: $INDEXER_IMAGE
          args:
            - --sources
            - /data/sources.yaml
            - --compat
            - /data/compatibility.yaml
            $EXTRA_ARGS
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: "1"
              memory: 1Gi
          volumeMounts:
            - name: sources
              mountPath: /data/sources.yaml
              subPath: sources.yaml
              readOnly: true
            - name: compatibility
              mountPath: /data/compatibility.yaml
              subPath: compatibility.yaml
              readOnly: true
      volumes:
        - name: sources
          configMap:
            name: license-indexer-sources
        - name: compatibility
          configMap:
            name: license-indexer-compatibility
EOF

log "Job created. Monitoring..."
oc wait --for=condition=complete "job/$JOB_NAME" -n "$NAMESPACE" --timeout=600s || {
    log "WARNING: Job did not complete within timeout"
    log "Check logs: oc logs -n $NAMESPACE job/$JOB_NAME"
    exit 1
}

log ""
log "=== License compliance indexing complete ==="
