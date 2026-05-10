#!/usr/bin/env bash
set -euo pipefail

# Operate the Synesis RAG Indexer (queue mode).
#
# The indexer runs as a single CronJob that claims work from the admin
# service's ingestion queue (PostgreSQL-backed).  Content is added via
# the admin UI or the bootstrap API; the indexer processes whatever is
# pending — no ConfigMaps or sources.yaml required.
#
# Usage:
#   ./scripts/deploy-indexer.sh            # Inspect Helm-managed CronJob
#   ./scripts/deploy-indexer.sh --run      # One-shot: create a Job now

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }
warn() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $*" >&2; }

RUN_NOW=false
CRONJOB_NAME="synesis-indexer-queue"
NAMESPACE="${SYNESIS_RAG_NAMESPACE:-synesis-rag}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --run) RUN_NOW=true; shift ;;
        --namespace)
            NAMESPACE="${2:-}"
            if [[ -z "$NAMESPACE" ]]; then echo "ERROR: --namespace requires a value"; exit 1; fi
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [--run] [--namespace <name>]"
            echo ""
            echo "  (no args)  Inspect the Helm-managed indexer CronJob"
            echo "  --run      Create a one-shot Job from the queue CronJob"
            echo "  --namespace <name>  RAG namespace (default: synesis-rag)"
            echo ""
            echo "CronJob creation and configuration are managed by Helm values:"
            echo "  jobs.indexer.enabled=true"
            echo "  jobs.indexer.queue.enabled=true"
            exit 0
            ;;
        *)
            echo "Unknown arg: $1"; exit 1 ;;
    esac
done

# ── Pre-flight: verify NornicDB and embedder ─────────────────────────
log "=== Synesis RAG Indexer (queue mode) ==="
log ""
log "Checking RAG dependencies..."

NORNIC_READY=$(oc get deployment synesis-nornicdb -n "$NAMESPACE" \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
if [[ "$NORNIC_READY" -gt 0 ]] 2>/dev/null; then
    log "  NornicDB: running ($NORNIC_READY replicas)"
else
    warn "NornicDB is not running in $NAMESPACE."
    warn "  Install or upgrade the Synesis Helm release first."
    exit 1
fi

EMBEDDER_READY=$(oc get deployment embedder -n "$NAMESPACE" \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
if [[ "$EMBEDDER_READY" -gt 0 ]] 2>/dev/null; then
    log "  Embedder: running ($EMBEDDER_READY replicas)"
else
    EMBEDDER_PODS=$(oc get pods -n "$NAMESPACE" \
        -l app.kubernetes.io/name=embedder --no-headers 2>&1 | grep -c Running || true)
    if [[ "$EMBEDDER_PODS" -gt 0 ]] 2>/dev/null; then
        log "  Embedder: running ($EMBEDDER_PODS pods)"
    else
        warn "Embedder is not running in $NAMESPACE."
        warn "  Install or upgrade the Synesis Helm release first."
        exit 1
    fi
fi

log ""
if ! oc get cronjob "$CRONJOB_NAME" -n "$NAMESPACE" &>/dev/null; then
    warn "CronJob $NAMESPACE/$CRONJOB_NAME was not found."
    warn "Enable the indexer in Helm values and upgrade the release:"
    warn "  jobs.indexer.enabled=true"
    warn "  jobs.indexer.queue.enabled=true"
    warn "  helm upgrade synesis ./charts/synesis -f my-synesis-values.yaml"
    exit 1
fi

# ── One-shot run ──────────────────────────────────────────────────────
if $RUN_NOW; then
    JOB_NAME="${CRONJOB_NAME}-manual-$(date +%s)"
    log ""
    log "Creating one-shot Job '$JOB_NAME'..."
    oc create job "$JOB_NAME" --from=cronjob/"$CRONJOB_NAME" -n "$NAMESPACE"

    log "Job created. Monitor with:"
    log "  oc logs -n $NAMESPACE -l synesis.io/indexer-group=queue -f"
else
    log ""
    log "CronJob in $NAMESPACE:"
    oc get cronjob "$CRONJOB_NAME" -n "$NAMESPACE"
    log ""
    log "To process pending items now:"
    log "  kubectl create job --from=cronjob/$CRONJOB_NAME ${CRONJOB_NAME}-manual -n $NAMESPACE"
    log ""
    log "To add content to the queue:"
    log "  - Admin UI: RAG Pipeline > Ingestion Queue"
    log "  - Bootstrap: curl -X POST http://synesis-admin.synesis-admin.svc:8080/api/v1/ingestion/bootstrap -F file=@bootstrap/corpus/docs.yaml"
fi
