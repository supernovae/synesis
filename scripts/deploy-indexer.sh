#!/usr/bin/env bash
set -euo pipefail

# Deploy the Synesis RAG Indexer (queue mode).
#
# The indexer runs as a single CronJob that claims work from the admin
# service's ingestion queue (PostgreSQL-backed).  Content is added via
# the admin UI or the bootstrap API; the indexer processes whatever is
# pending — no ConfigMaps or sources.yaml required.
#
# Usage:
#   ./scripts/deploy-indexer.sh            # Apply the CronJob (via Kustomize)
#   ./scripts/deploy-indexer.sh --run      # One-shot: create a Job now
#
# The base manifest uses image name synesis-indexer (placeholder). Kustomize
# overlays resolve it to a real registry (default: ghcr.io/supernovae/synesis/indexer).
# Override with:
#   SYNESIS_INDEXER_OVERLAY=/path/to/overlays/jobs-prod ./scripts/deploy-indexer.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
INDEXER_OVERLAY="${SYNESIS_INDEXER_OVERLAY:-$PROJECT_ROOT/overlays/jobs}"

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }
warn() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $*" >&2; }

RUN_NOW=false
S3_BUCKET="${SYNESIS_INGESTION_S3_BUCKET:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --run) RUN_NOW=true; shift ;;
        --s3-bucket)
            S3_BUCKET="${2:-}"
            if [[ -z "$S3_BUCKET" ]]; then echo "ERROR: --s3-bucket requires a value"; exit 1; fi
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [--run] [--s3-bucket <name>]"
            echo ""
            echo "  (no args)  Apply indexer CronJobs (oc apply -k on Kustomize overlay)"
            echo "  --run      Also create a one-shot Job for the queue CronJob"
            echo "  --s3-bucket <name>  Set SYNESIS_INGESTION_S3_BUCKET on staged CronJobs"
            echo ""
            echo "  SYNESIS_INDEXER_OVERLAY  Kustomize dir (default: overlays/jobs)"
            echo "  SYNESIS_INGESTION_S3_BUCKET  Same as --s3-bucket if set in environment"
            exit 0
            ;;
        *)
            echo "Unknown arg: $1"; exit 1 ;;
    esac
done

CRONJOB_NAME="synesis-indexer-queue"
NAMESPACE="synesis-rag"

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
    warn "  Deploy services first: ./scripts/deploy.sh"
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
        warn "  Deploy services first: ./scripts/deploy.sh"
        exit 1
    fi
fi

# ── Apply CronJob manifest ────────────────────────────────────────────
log ""
oc create namespace "$NAMESPACE" 2>/dev/null || true

if [[ ! -f "$INDEXER_OVERLAY/kustomization.yaml" ]]; then
    warn "Kustomize overlay not found: $INDEXER_OVERLAY"
    warn "Set SYNESIS_INDEXER_OVERLAY to overlays/jobs, jobs-staging, or jobs-prod."
    exit 1
fi

log "Applying indexer CronJobs (overlay: $INDEXER_OVERLAY)..."
oc apply -k "$INDEXER_OVERLAY"

if [[ -n "$S3_BUCKET" ]]; then
    log "Patching staged CronJobs with SYNESIS_INGESTION_S3_BUCKET=$S3_BUCKET ..."
    for cj in synesis-indexer-staged-fetch synesis-indexer-staged-normalize synesis-indexer-staged-enrich; do
        if oc get cronjob "$cj" -n "$NAMESPACE" &>/dev/null; then
            oc set env "cronjob/$cj" -n "$NAMESPACE" "SYNESIS_INGESTION_S3_BUCKET=$S3_BUCKET" || true
            log "  Patched $cj"
        fi
    done
fi

log ""
log "CronJobs in $NAMESPACE:"
oc get cronjobs -n "$NAMESPACE" -l 'app.kubernetes.io/part-of=synesis' --no-headers 2>/dev/null || true
oc get cronjob "$CRONJOB_NAME" -n "$NAMESPACE" --no-headers 2>/dev/null || true

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
    log "To process pending items now:"
    log "  ./scripts/deploy-indexer.sh --run"
    log ""
    log "To add content to the queue:"
    log "  - Admin UI: RAG Pipeline > Ingestion Queue"
    log "  - Bootstrap: curl -X POST http://synesis-admin.synesis-admin.svc:8080/api/v1/ingestion/bootstrap -F file=@bootstrap/corpus/docs.yaml"
fi
