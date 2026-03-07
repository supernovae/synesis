#!/usr/bin/env bash
set -euo pipefail

# Deploy RAG indexer CronJobs and Jobs.
#
# Run separately from deploy.sh so CronJobs only start after Milvus and other
# RAG dependencies are confirmed healthy.
#
# Usage: ./scripts/deploy-jobs.sh [dev|staging|prod]
#   Default: dev
#
# Environment behavior:
#   dev      — CronJobs suspended; run indexers manually via scripts/index-*.sh
#   staging  — CronJobs active, bi-weekly schedule
#   prod     — CronJobs active, weekly schedule (base defaults)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

ENV="${1:-dev}"
if [[ ! "$ENV" =~ ^(dev|staging|prod)$ ]]; then
    echo "Usage: $0 [dev|staging|prod]"
    exit 1
fi

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }
warn() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $*" >&2; }

# Select overlay based on environment
case "$ENV" in
    dev)     JOBS_OVERLAY="$PROJECT_ROOT/overlays/jobs" ;;
    staging) JOBS_OVERLAY="$PROJECT_ROOT/overlays/jobs-staging" ;;
    prod)    JOBS_OVERLAY="$PROJECT_ROOT/overlays/jobs-prod" ;;
esac

if [[ ! -d "$JOBS_OVERLAY" ]]; then
    echo "ERROR: Jobs overlay not found: $JOBS_OVERLAY" >&2
    exit 1
fi

log "=== Deploying RAG indexer CronJobs ($ENV) ==="
log ""

# Pre-flight: verify Milvus is running before creating CronJobs
log "Checking Milvus health..."
if oc get pods -n synesis-rag -l app=milvus-standalone --no-headers 2>/dev/null | grep -q Running; then
    log "  Milvus: running"
else
    warn "Milvus is not running in synesis-rag."
    warn "  Deploy services first: ./scripts/deploy.sh $ENV"
    warn "  Then re-run:           ./scripts/deploy-jobs.sh $ENV"
    exit 1
fi

# Pre-flight: verify embedder is running
if oc get pods -n synesis-rag -l app=embedder --no-headers 2>/dev/null | grep -q Running; then
    log "  Embedder: running"
else
    warn "Embedder is not running in synesis-rag."
    warn "  Deploy services first: ./scripts/deploy.sh $ENV"
    exit 1
fi

log ""
oc create namespace synesis-rag 2>/dev/null || true
log "Applying indexer CronJobs ($ENV overlay)..."
kustomize build "$JOBS_OVERLAY" 2>/dev/null | oc apply -f -

log ""
if [[ "$ENV" == "dev" ]]; then
    log "Done. CronJobs are suspended in dev."
    log "  Run indexers manually:"
    log "    ./scripts/load-language-pack.sh bash"
    log "    ./scripts/index-domain.sh"
    log "    ./scripts/index-code.sh"
    log "    ./scripts/index-knowledge-base.sh"
else
    log "Done. CronJobs are active ($ENV schedule)."
    log "  View: oc get cronjobs -n synesis-rag"
fi
