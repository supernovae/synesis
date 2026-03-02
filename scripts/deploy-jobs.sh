#!/usr/bin/env bash
set -euo pipefail

# Deploy RAG indexer CronJobs and Jobs.
#
# Run separately from deploy.sh so test deploys don't trigger indexer reloads.
# Prereq: deploy.sh has been run (Milvus, embedder, planner, etc. must exist).
#
# Usage: ./scripts/deploy-jobs.sh [dev|staging|prod]
#   Default: dev
#
# CronJobs are suspended in dev; run indexers manually via:
#   ./scripts/load-language-pack.sh bash
#   ./scripts/index-domain.sh
#   ./scripts/index-code.sh
#   etc.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

ENV="${1:-dev}"
if [[ ! "$ENV" =~ ^(dev|staging|prod)$ ]]; then
    echo "Usage: $0 [dev|staging|prod]"
    exit 1
fi

# Jobs overlay is dev-focused (CronJobs suspended). Staging/prod use main deploy.
JOBS_OVERLAY="$PROJECT_ROOT/overlays/jobs"
if [[ ! -d "$JOBS_OVERLAY" ]]; then
    echo "ERROR: Jobs overlay not found: $JOBS_OVERLAY" >&2
    exit 1
fi

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }

log "=== Deploying RAG indexer Jobs and CronJobs ($ENV) ==="
log ""

oc create namespace synesis-rag 2>/dev/null || true
log "Applying indexer CronJobs and Jobs..."
kustomize build "$JOBS_OVERLAY" 2>/dev/null | oc apply -f -
log ""
log "Done. CronJobs are suspended in dev; run ./scripts/index-*.sh to trigger manually."
