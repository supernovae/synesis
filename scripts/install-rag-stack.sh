#!/usr/bin/env bash
set -euo pipefail

# Synesis RAG Stack Installer
#
# Applies the Milvus Operator CR + embedder in synesis-rag.
# Requires: Milvus Operator already installed (bootstrap.sh handles this).
#
# Use this for standalone RAG infra setup. deploy.sh applies this
# as part of the full stack; deploy-indexer.sh handles the indexer CronJob separately.
#
# Usage: ./scripts/install-rag-stack.sh [--wait]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RAG_DIR="$PROJECT_ROOT/base/rag"
WAIT_FOR_READY=false

for arg in "$@"; do
    case "$arg" in
        --wait) WAIT_FOR_READY=true ;;
        --help|-h)
            echo "Usage: $0 [--wait]"
            echo ""
            echo "Applies Milvus Operator CR + embedder."
            echo "  --wait  Wait for Milvus CR to become Healthy and embedder to be ready"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 1
            ;;
    esac
done

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }
err() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2; }

# Prerequisites
if ! command -v oc &>/dev/null; then
    err "oc CLI required. Install OpenShift CLI and run 'oc login'."
    exit 1
fi
if ! oc whoami &>/dev/null; then
    err "Not logged into a cluster. Run 'oc login' first."
    exit 1
fi
if ! command -v kustomize &>/dev/null; then
    err "kustomize required. Install kustomize or kubectl with kustomize support."
    exit 1
fi

if ! oc get crd milvus.milvus.io &>/dev/null; then
    err "Milvus Operator CRD not found. Run ./scripts/bootstrap.sh first to install the operator."
    exit 1
fi

log "=== Installing Synesis RAG Stack ==="
log ""

log "Applying base/rag manifests..."
if ! kustomize build "$RAG_DIR" | oc apply -f -; then
    err "Failed to apply RAG manifests"
    exit 1
fi

log ""
log "RAG stack applied. Components:"
log "  - Milvus CR 'synesis' (operator-managed, service: synesis-milvus:19530)"
log "  - embedder (TEI for embeddings)"
log ""

if [[ "$WAIT_FOR_READY" == "true" ]]; then
    log "Waiting for Milvus CR to become Healthy..."
    ns="synesis-rag"

    for i in $(seq 1 30); do
        STATUS=$(oc get milvus synesis -n "$ns" -o jsonpath='{.status.status}' 2>/dev/null || echo "")
        if [[ "$STATUS" == "Healthy" ]]; then
            log "  Milvus CR is Healthy"
            break
        fi
        log "  Milvus status: ${STATUS:-Pending} (attempt $i/30)"
        sleep 10
    done
    if [[ "$STATUS" != "Healthy" ]]; then
        log "WARNING: Milvus CR status is '$STATUS' after 5 min."
        log "  Check: oc get milvus synesis -n $ns -o yaml"
    fi

    if oc get deployment embedder -n "$ns" &>/dev/null; then
        log "  Waiting for $ns/embedder..."
        oc rollout status deployment/embedder -n "$ns" --timeout=300s || {
            log "WARNING: Rollout timeout for $ns/embedder"
        }
    fi
fi

log ""
log "=== RAG stack install complete ==="
log ""
log "Next steps:"
log "  1. Deploy indexer:           ./scripts/deploy-indexer.sh"
log "  2. Load knowledge:           ./scripts/load-language-pack.sh bash"
log "  3. Run full deploy:          ./scripts/deploy.sh dev"
log ""
