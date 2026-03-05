#!/usr/bin/env bash
set -euo pipefail

# Synesis Domain / Runbook Knowledge Loader Trigger
#
# Creates/updates the sources ConfigMap and runs the indexer Job.
# Indexes Red Hat/OpenShift runbooks from GitHub (openshift/runbooks, red-hat-storage/ocs-sop).
#
# Usage:
#   ./scripts/index-domain.sh
#   ./scripts/index-domain.sh --repo "openshift/runbooks"
#   GITHUB_TOKEN=xxx ./scripts/index-domain.sh  # Higher rate limit

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

INDEXER_IMAGE="${SYNESIS_DOMAIN_INDEXER_IMAGE:-synesis-indexer-domain:latest}"
NAMESPACE="synesis-rag"
REPO_FILTER=""
FORCE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo) REPO_FILTER="$2"; shift 2 ;;
        --force) FORCE="--force"; shift ;;
        --image) INDEXER_IMAGE="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

SOURCES_FILE="$PROJECT_ROOT/base/rag/indexers/domain/sources.yaml"

if [[ ! -f "$SOURCES_FILE" ]]; then
    echo "ERROR: Sources file not found: $SOURCES_FILE"
    exit 1
fi

log "=== Synesis Domain Knowledge Loader ==="
log "Image: $INDEXER_IMAGE"
[[ -n "$REPO_FILTER" ]] && log "Repo filter: $REPO_FILTER"
[[ -n "$GITHUB_TOKEN" ]] && log "GitHub token: set (higher rate limit)"

log "Creating/updating sources ConfigMap..."
oc create configmap domain-indexer-sources \
    --from-file=sources.yaml="$SOURCES_FILE" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | oc apply -f -

JOB_NAME="index-domain-$(date +%s)"

log "Cleaning up previous indexer jobs..."
oc delete job -n "$NAMESPACE" -l app.kubernetes.io/component=rag-indexer-domain --ignore-not-found

log "Creating indexer job: $JOB_NAME"

# Build job manifest (args vary by options)
ARGS_BLOCK="            - --sources
            - /data/sources.yaml"
[[ -n "$REPO_FILTER" ]] && ARGS_BLOCK="$ARGS_BLOCK
            - --repo
            - $REPO_FILTER"
[[ -n "$FORCE" ]] && ARGS_BLOCK="$ARGS_BLOCK
            - --force"

cat <<EOF | oc apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB_NAME
  namespace: $NAMESPACE
  labels:
    app.kubernetes.io/part-of: synesis
    app.kubernetes.io/component: rag-indexer-domain
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: indexer-domain
        app.kubernetes.io/part-of: synesis
    spec:
      restartPolicy: OnFailure
      containers:
        - name: indexer
          image: $INDEXER_IMAGE
          args:
$ARGS_BLOCK
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
            name: domain-indexer-sources
EOF

log "Job created. Monitoring..."
oc wait --for=condition=complete "job/$JOB_NAME" -n "$NAMESPACE" --timeout=900s || {
    log "WARNING: Job did not complete within timeout"
    log "Check logs: oc logs -n $NAMESPACE job/$JOB_NAME"
    exit 1
}

log ""
log "=== Domain knowledge indexing complete ==="
