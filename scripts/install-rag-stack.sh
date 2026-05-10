#!/usr/bin/env bash
set -euo pipefail

# Synesis RAG Stack Installer (deprecated)
#
# RAG infrastructure is managed by the Synesis Helm chart. This script is kept
# only to point older runbooks at the supported install path.
#
# Usage: ./scripts/install-rag-stack.sh [--wait]

WAIT_FOR_READY=false

for arg in "$@"; do
    case "$arg" in
        --wait) WAIT_FOR_READY=true ;;
        --help|-h)
            echo "Usage: $0 [--wait]"
            echo ""
            echo "Deprecated. RAG resources are installed and upgraded through Helm:"
            echo "  helm upgrade --install synesis ./charts/synesis -f my-synesis-values.yaml"
            echo ""
            echo "Enable indexer jobs in Helm values:"
            echo "  jobs.indexer.enabled=true"
            echo "  jobs.indexer.queue.enabled=true"
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

log "=== Synesis RAG Stack ==="
log ""
err "Direct RAG manifest installation is deprecated."
err "Install or upgrade Synesis through Helm instead:"
err "  helm upgrade --install synesis ./charts/synesis -f my-synesis-values.yaml"
err ""
err "Configure RAG and indexer resources in Helm values. For example:"
err "  jobs.indexer.enabled=true"
err "  jobs.indexer.queue.enabled=true"

if [[ "$WAIT_FOR_READY" == "true" ]]; then
    if ! command -v oc &>/dev/null; then
        err "oc CLI required for --wait."
        exit 1
    fi
    ns="synesis-rag"
    log ""
    log "Waiting for existing Helm-managed RAG workloads..."

    if oc get deployment synesis-nornicdb -n "$ns" &>/dev/null; then
        log "  Waiting for $ns/synesis-nornicdb..."
        oc rollout status deployment/synesis-nornicdb -n "$ns" --timeout=300s || {
            log "WARNING: Rollout timeout for $ns/synesis-nornicdb"
        }
    fi

    if oc get deployment embedder -n "$ns" &>/dev/null; then
        log "  Waiting for $ns/embedder..."
        oc rollout status deployment/embedder -n "$ns" --timeout=300s || {
            log "WARNING: Rollout timeout for $ns/embedder"
        }
    fi
fi

exit 1
