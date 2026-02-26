#!/usr/bin/env bash
set -euo pipefail

# Synesis Code Repository Indexer Trigger
#
# Creates/updates the sources ConfigMap and runs the indexer Job.
#
# Usage:
#   ./scripts/index-code.sh                     # index all languages
#   ./scripts/index-code.sh --language python    # index only Python
#   ./scripts/index-code.sh --repo tiangolo/fastapi --language python

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

INDEXER_IMAGE="${SYNESIS_CODE_INDEXER_IMAGE:-synesis-indexer-code:latest}"
NAMESPACE="synesis-rag"
LANGUAGE=""
REPO=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --language) LANGUAGE="$2"; shift 2 ;;
        --repo) REPO="$2"; shift 2 ;;
        --image) INDEXER_IMAGE="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

SOURCES_FILE="$PROJECT_ROOT/base/rag/indexers/code/sources.yaml"

if [[ ! -f "$SOURCES_FILE" ]]; then
    echo "ERROR: Sources file not found: $SOURCES_FILE"
    exit 1
fi

log "=== Synesis Code Repository Indexer ==="
log "Image: $INDEXER_IMAGE"
[[ -n "$LANGUAGE" ]] && log "Language filter: $LANGUAGE"
[[ -n "$REPO" ]] && log "Repo filter: $REPO"

log "Creating/updating sources ConfigMap..."
oc create configmap code-indexer-sources \
    --from-file=sources.yaml="$SOURCES_FILE" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | oc apply -f -

JOB_NAME="index-code-$(date +%s)"
EXTRA_ARGS=""
[[ -n "$LANGUAGE" ]] && EXTRA_ARGS="$EXTRA_ARGS --language $LANGUAGE"
[[ -n "$REPO" ]] && EXTRA_ARGS="$EXTRA_ARGS --repo $REPO"

log "Cleaning up previous indexer jobs..."
oc delete job -n "$NAMESPACE" -l app.kubernetes.io/component=rag-indexer-code --ignore-not-found

log "Creating indexer job: $JOB_NAME"

GITHUB_SECRET_REF=""
if oc get secret synesis-github-token -n "$NAMESPACE" &>/dev/null; then
    GITHUB_SECRET_REF='
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: synesis-github-token
                  key: token'
    log "GitHub token secret found -- PR extraction enabled"
else
    log "No GitHub token secret -- using git log fallback for patterns"
fi

cat <<EOF | oc apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB_NAME
  namespace: $NAMESPACE
  labels:
    app.kubernetes.io/part-of: synesis
    app.kubernetes.io/component: rag-indexer-code
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 7200
  template:
    metadata:
      labels:
        app.kubernetes.io/name: indexer-code
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
          env:$GITHUB_SECRET_REF
            - name: CLONE_DIR
              value: /tmp/synesis-repos
          resources:
            requests:
              cpu: "1"
              memory: 2Gi
            limits:
              cpu: "4"
              memory: 8Gi
          volumeMounts:
            - name: sources
              mountPath: /data/sources.yaml
              subPath: sources.yaml
              readOnly: true
            - name: clone-cache
              mountPath: /tmp/synesis-repos
      volumes:
        - name: sources
          configMap:
            name: code-indexer-sources
        - name: clone-cache
          emptyDir:
            sizeLimit: 50Gi
EOF

log "Job created. Monitoring..."
oc wait --for=condition=complete "job/$JOB_NAME" -n "$NAMESPACE" --timeout=3600s || {
    log "WARNING: Job did not complete within timeout"
    log "Check logs: oc logs -n $NAMESPACE job/$JOB_NAME"
    exit 1
}

log ""
log "=== Code repository indexing complete ==="
