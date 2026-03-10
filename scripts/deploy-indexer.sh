#!/usr/bin/env bash
set -euo pipefail

# Deploy the Unified RAG Indexer CronJobs.
#
# Builds the correct overlay for the target environment and applies it.
# Each overlay sets the GHCR image path, environment-specific schedules,
# and (for dev) suspends CronJobs so they only run via --run.
#
# Usage: ./scripts/deploy-indexer.sh [dev|staging|prod]
#   Default: dev
#
# One-shot run:
#   ./scripts/deploy-indexer.sh dev --run docs
#   ./scripts/deploy-indexer.sh dev --run code
#   ./scripts/deploy-indexer.sh dev --run apispec
#   ./scripts/deploy-indexer.sh dev --run license
#   ./scripts/deploy-indexer.sh dev --run research
#   ./scripts/deploy-indexer.sh dev --run epistemic
#   ./scripts/deploy-indexer.sh dev --run epistemic-band2
#   ./scripts/deploy-indexer.sh dev --run epistemic-developer

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }
warn() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $*" >&2; }

ENV="${1:-dev}"
RUN_GROUP=""

shift || true
while [[ $# -gt 0 ]]; do
    case "$1" in
        --run)
            RUN_GROUP="$2"
            shift 2
            ;;
        *)
            echo "Unknown arg: $1"
            exit 1
            ;;
    esac
done

if [[ ! "$ENV" =~ ^(dev|staging|prod)$ ]]; then
    echo "Usage: $0 [dev|staging|prod] [--run docs|code|apispec|license|research|epistemic|epistemic-band2|epistemic-developer]"
    exit 1
fi

# Map environment to overlay directory
case "$ENV" in
    dev)     OVERLAY_DIR="$PROJECT_ROOT/overlays/jobs" ;;
    staging) OVERLAY_DIR="$PROJECT_ROOT/overlays/jobs-staging" ;;
    prod)    OVERLAY_DIR="$PROJECT_ROOT/overlays/jobs-prod" ;;
esac

# Pre-flight: verify Milvus and embedder are running
log "=== Deploying Unified RAG Indexer ($ENV) ==="
log ""
log "Checking RAG dependencies..."

if oc get pods -n synesis-rag -l app.kubernetes.io/instance=synesis,app.kubernetes.io/name=milvus --no-headers 2>/dev/null | grep -q Running; then
    log "  Milvus: running (operator-managed)"
else
    warn "Milvus is not running in synesis-rag."
    warn "  Deploy services first: ./scripts/deploy.sh $ENV"
    warn "  Check Milvus CR: oc get milvus synesis -n synesis-rag"
    exit 1
fi

if oc get pods -n synesis-rag -l app.kubernetes.io/name=embedder --no-headers 2>/dev/null | grep -q Running; then
    log "  Embedder: running"
else
    warn "Embedder is not running in synesis-rag."
    warn "  Deploy services first: ./scripts/deploy.sh $ENV"
    exit 1
fi

log ""

if [[ -n "$RUN_GROUP" ]]; then
    # One-shot: create a Job from the CronJob
    CRONJOB_NAME="synesis-indexer-${RUN_GROUP}"
    log "Creating one-shot Job from CronJob '$CRONJOB_NAME'..."

    # Apply manifests first to ensure CronJob exists with correct image
    oc create namespace synesis-rag 2>/dev/null || true
    kustomize build "$OVERLAY_DIR" 2>/dev/null | oc apply -f -

    oc create job "${CRONJOB_NAME}-manual-$(date +%s)" \
        --from=cronjob/"$CRONJOB_NAME" \
        -n synesis-rag

    log "Job created. Monitor with:"
    log "  oc get jobs -n synesis-rag -l synesis.io/indexer-group=$RUN_GROUP"
    log "  oc logs -n synesis-rag -l synesis.io/indexer-group=$RUN_GROUP -f"
else
    # Deploy CronJobs
    oc create namespace synesis-rag 2>/dev/null || true
    log "Applying unified indexer CronJobs ($ENV overlay)..."
    kustomize build "$OVERLAY_DIR" 2>/dev/null | oc apply -f -

    log ""
    log "Done. CronJobs deployed:"
    oc get cronjobs -n synesis-rag -l app.kubernetes.io/component=rag-indexer --no-headers 2>/dev/null || true

    if [[ "$ENV" == "dev" ]]; then
        log ""
        log "CronJobs are suspended in dev. For manual one-shot runs:"
        log "  ./scripts/deploy-indexer.sh dev --run docs"
        log "  ./scripts/deploy-indexer.sh dev --run code"
        log "  ./scripts/deploy-indexer.sh dev --run apispec"
        log "  ./scripts/deploy-indexer.sh dev --run license"
        log "  ./scripts/deploy-indexer.sh dev --run research"
        log "  ./scripts/deploy-indexer.sh dev --run epistemic"
        log "  ./scripts/deploy-indexer.sh dev --run epistemic-band2"
        log "  ./scripts/deploy-indexer.sh dev --run epistemic-developer"
    fi
fi
