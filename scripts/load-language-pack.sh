#!/usr/bin/env bash
set -euo pipefail

# Synesis Language Pack Loader
#
# Triggers RAG ingestion for a specified language pack by creating
# a Kubernetes Job from the job template.
#
# Usage: ./scripts/load-language-pack.sh <language>
#   e.g.: ./scripts/load-language-pack.sh bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

LANGUAGE="${1:-}"
INGESTOR_IMAGE="${SYNESIS_INGESTOR_IMAGE:-synesis-ingestor:latest}"

if [[ -z "$LANGUAGE" ]]; then
    echo "Usage: $0 <language>"
    echo ""
    echo "Available language packs:"
    for pack in "$PROJECT_ROOT"/base/rag/language-packs/*/; do
        name=$(basename "$pack")
        [[ "$name" == "_template" ]] && continue
        echo "  - $name"
    done
    exit 1
fi

PACK_DIR="$PROJECT_ROOT/base/rag/language-packs/$LANGUAGE"

if [[ ! -d "$PACK_DIR" ]]; then
    echo "ERROR: Language pack not found: $PACK_DIR"
    echo "Create one by copying base/rag/language-packs/_template/"
    exit 1
fi

if [[ ! -f "$PACK_DIR/manifest.yaml" ]]; then
    echo "ERROR: No manifest.yaml in $PACK_DIR"
    exit 1
fi

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

log "=== Loading language pack: $LANGUAGE ==="

log "Creating ConfigMap from language pack..."
oc create configmap "language-pack-$LANGUAGE" \
    --from-file="$PACK_DIR/" \
    -n synesis-rag \
    --dry-run=client -o yaml | oc apply -f -

JOB_NAME="ingest-${LANGUAGE}-$(date +%s)"

log "Creating ingestion job: $JOB_NAME"

oc delete job -n synesis-rag -l "synesis.io/language-pack=$LANGUAGE" --ignore-not-found

cat <<EOF | oc apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB_NAME
  namespace: synesis-rag
  labels:
    app.kubernetes.io/part-of: synesis
    app.kubernetes.io/component: rag-ingestion
    synesis.io/language-pack: $LANGUAGE
spec:
  backoffLimit: 3
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: rag-ingestor
        app.kubernetes.io/part-of: synesis
        synesis.io/language-pack: $LANGUAGE
    spec:
      restartPolicy: OnFailure
      containers:
        - name: ingestor
          image: $INGESTOR_IMAGE
          args:
            - --pack
            - /data/language-packs/$LANGUAGE
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: "2"
              memory: 2Gi
          volumeMounts:
            - name: language-packs
              mountPath: /data/language-packs/$LANGUAGE
              readOnly: true
      volumes:
        - name: language-packs
          configMap:
            name: language-pack-$LANGUAGE
EOF

log "Job created. Monitoring..."
oc wait --for=condition=complete "job/$JOB_NAME" -n synesis-rag --timeout=600s || {
    log "WARNING: Job did not complete within timeout"
    log "Check logs: oc logs -n synesis-rag job/$JOB_NAME"
    exit 1
}

log ""
log "=== Language pack '$LANGUAGE' loaded successfully ==="
