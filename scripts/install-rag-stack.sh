#!/usr/bin/env bash
set -euo pipefail

# Synesis RAG Stack Installer
#
# Installs Milvus (etcd + standalone) + embedder + indexers in synesis-rag.
# Use this for standalone RAG setup or before full deploy.
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
            echo "Installs Milvus (etcd + standalone) + embedder + indexers."
            echo "  --wait  Wait for etcd, milvus-standalone, and embedder to be ready"
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

log "=== Installing Synesis RAG Stack ==="
log ""

# Apply RAG base
log "Applying base/rag manifests..."
if ! kustomize build "$RAG_DIR" | oc apply -f -; then
    err "Failed to apply RAG manifests"
    exit 1
fi

log ""
log "RAG stack applied. Components:"
log "  - etcd-deployment (metadata for Milvus)"
log "  - milvus-standalone (vector store, service: synesis-milvus:19530)"
log "  - embedder (TEI for embeddings)"
log "  - indexers (code, apispec, architecture, license)"
log ""

if [[ "$WAIT_FOR_READY" == "true" ]]; then
    log "Waiting for rollouts..."
    ns="synesis-rag"

    for deploy in etcd-deployment milvus-standalone embedder; do
        if oc get deployment "$deploy" -n "$ns" &>/dev/null; then
            log "  Waiting for $ns/$deploy..."
            oc rollout status deployment/"$deploy" -n "$ns" --timeout=300s || {
                log "WARNING: Rollout timeout for $ns/$deploy"
            }
        fi
    done
fi

log ""
log "=== RAG stack install complete ==="
log ""
log "Next steps:"
log "  1. Load a language pack:  ./scripts/load-language-pack.sh bash"
log "  2. Run full deploy:      ./scripts/deploy.sh dev"
log ""
