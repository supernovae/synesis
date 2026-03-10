#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Clean RAG: Drop and recreate Milvus collection, then re-index all sources
# ============================================================================
#
# Use this after schema changes (e.g., SCHEMA_VERSION bump) or when you want
# a fresh start with clean, consistent data.
#
# What it does:
#   1. Connects to Milvus and drops synesis_catalog
#   2. Recreates the collection with the current schema (v4)
#   3. Optionally triggers re-indexing of all source groups
#
# What it does NOT do:
#   - Touch model deployments, LiteLLM, or Open WebUI
#   - Delete Milvus itself (just the collection data)
#   - Modify any source YAML configs
#
# Prerequisites:
#   - Milvus running in synesis-rag namespace
#   - Embedder running in synesis-rag namespace
#   - oc CLI authenticated (for cluster mode)
#   - pymilvus installed (for local mode)
#
# Usage:
#   Cluster mode (runs indexer jobs on OpenShift):
#     ./scripts/clean-rag.sh [--env dev|staging|prod] [--reindex] [--dry-run]
#
#   Local mode (connects to Milvus directly, useful for dev):
#     ./scripts/clean-rag.sh --local [--milvus-uri URI] [--reindex] [--dry-run]
#
# DELETE THIS SCRIPT if it becomes part of standard operations — use
# deploy-indexer.sh for routine re-indexing instead.
# ============================================================================

DRY_RUN=false
REINDEX=false
LOCAL_MODE=false
ENV="dev"
MILVUS_URI=""

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        --reindex) REINDEX=true ;;
        --local) LOCAL_MODE=true ;;
        --env=*) ENV="${arg#--env=}" ;;
        --milvus-uri=*) MILVUS_URI="${arg#--milvus-uri=}" ;;
        --help|-h)
            echo "Usage: $0 [--env dev|staging|prod] [--reindex] [--local] [--milvus-uri URI] [--dry-run]"
            echo ""
            echo "Drop and recreate Milvus synesis_catalog collection."
            echo "  --env ENV       Target environment (default: dev)"
            echo "  --reindex       After dropping, trigger re-indexing of all source groups"
            echo "  --local         Use local pymilvus connection instead of oc exec"
            echo "  --milvus-uri    Milvus URI for local mode (default: http://localhost:19530)"
            echo "  --dry-run       Show what would be done without making changes"
            exit 0
            ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

log()  { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }
warn() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $*" >&2; }

run() {
    if [[ "$DRY_RUN" == "true" ]]; then
        log "  [DRY-RUN] $*"
    else
        "$@"
    fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COLLECTION="synesis_catalog"

log "=== Clean RAG: Drop and Recreate $COLLECTION ==="
log ""

if [[ "$DRY_RUN" == "true" ]]; then
    log "*** DRY RUN MODE — no changes will be made ***"
    log ""
fi

# -----------------------------------------------------------------------
# Step 1: Verify current schema version
# -----------------------------------------------------------------------
log "Step 1: Verifying schema version..."

SCHEMA_PY="$PROJECT_ROOT/base/rag/indexer/app/schema.py"
if [[ -f "$SCHEMA_PY" ]]; then
    SCHEMA_VERSION=$(grep "^SCHEMA_VERSION" "$SCHEMA_PY" | head -1 | tr -dc '0-9')
    log "  Schema version: v$SCHEMA_VERSION"
else
    warn "schema.py not found at $SCHEMA_PY"
    SCHEMA_VERSION="?"
fi

log ""

# -----------------------------------------------------------------------
# Step 2: Drop the collection
# -----------------------------------------------------------------------
log "Step 2: Dropping collection '$COLLECTION'..."

if [[ "$LOCAL_MODE" == "true" ]]; then
    MILVUS_URI="${MILVUS_URI:-http://localhost:19530}"
    log "  Mode: local (pymilvus → $MILVUS_URI)"

    if [[ "$DRY_RUN" == "true" ]]; then
        log "  [DRY-RUN] Would drop '$COLLECTION' via pymilvus"
    else
        python3 -c "
from pymilvus import MilvusClient
client = MilvusClient(uri='${MILVUS_URI}')
collections = client.list_collections()
if '${COLLECTION}' in collections:
    desc = client.describe_collection('${COLLECTION}')
    fields = [f.get('name', '') for f in desc.get('fields', [])]
    count = client.get_collection_stats('${COLLECTION}').get('row_count', '?')
    print(f'  Found: {len(fields)} fields, {count} rows')
    client.drop_collection('${COLLECTION}')
    print(f'  Dropped: ${COLLECTION}')
else:
    print(f'  Collection ${COLLECTION} does not exist (nothing to drop)')
"
    fi
else
    log "  Mode: cluster (oc exec → synesis-rag namespace)"

    if ! command -v oc &>/dev/null; then
        log "ERROR: oc CLI not found. Use --local for direct pymilvus connection."
        exit 1
    fi

    MILVUS_POD=$(oc get pods -n synesis-rag \
        -l app.kubernetes.io/instance=synesis,app.kubernetes.io/name=milvus \
        --field-selector=status.phase=Running \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

    if [[ -z "$MILVUS_POD" ]]; then
        warn "No running Milvus pod found in synesis-rag"
        log "  Check: oc get pods -n synesis-rag -l app.kubernetes.io/name=milvus"
        exit 1
    fi

    log "  Milvus pod: $MILVUS_POD"

    if [[ "$DRY_RUN" == "true" ]]; then
        log "  [DRY-RUN] Would drop '$COLLECTION' via oc exec"
    else
        # Use the Milvus REST API to drop the collection
        oc exec "$MILVUS_POD" -n synesis-rag -- \
            curl -sf http://localhost:19530/v2/vectordb/collections/drop \
            -H "Content-Type: application/json" \
            -d "{\"collectionName\": \"${COLLECTION}\"}" \
            2>/dev/null || log "  Collection may not exist (OK)"
        log "  Dropped (or was already absent)"
    fi
fi

log ""

# -----------------------------------------------------------------------
# Step 3: Recreate collection with current schema
# -----------------------------------------------------------------------
log "Step 3: Recreating collection with schema v$SCHEMA_VERSION..."

if [[ "$LOCAL_MODE" == "true" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
        log "  [DRY-RUN] Would recreate '$COLLECTION' via ensure_synesis_catalog()"
    else
        PYTHONPATH="$PROJECT_ROOT/base/rag/indexer" python3 -c "
import sys
sys.path.insert(0, '${PROJECT_ROOT}/base/rag/indexer')
from app.schema import ensure_synesis_catalog, SCHEMA_VERSION, EXPECTED_FIELDS
client = ensure_synesis_catalog(uri='${MILVUS_URI}')
print(f'  Created: ${COLLECTION} v{SCHEMA_VERSION}')
print(f'  Fields: {len(EXPECTED_FIELDS)}')
print(f'  Fields: {sorted(EXPECTED_FIELDS)}')
"
    fi
else
    log "  Collection will be auto-created on first indexer run"
    log "  (ensure_synesis_catalog() in schema.py handles this)"
fi

log ""

# -----------------------------------------------------------------------
# Step 4: Print schema summary
# -----------------------------------------------------------------------
log "Step 4: Current schema (v$SCHEMA_VERSION):"
log ""
log "  Fields:"
log "    Identity:       chunk_id, doc_id, chunk_index"
log "    Content:        text (8192B), context_prefix (512B), chunk_summary (1024B)"
log "    Structure:      heading_path, section, document_name"
log "    Classification: source_type, handler, domain, tags, keywords"
log "    Provenance:     origin_type, authority (partition key), source_url"
log "    Vector:         embedding (384-dim, COSINE, HNSW)"
log ""
log "  Removed in v4:   intended_roles (Router owns all retrieval)"
log "  Chunking:        heading_aware_split (600w/80w overlap, 8192B cap)"
log "                   chunk_text_simple (4000 char paragraphs)"
log ""

# -----------------------------------------------------------------------
# Step 5: Re-index (optional)
# -----------------------------------------------------------------------
if [[ "$REINDEX" == "true" ]]; then
    log "Step 5: Triggering re-indexing of all source groups..."
    log ""

    INDEXER_GROUPS=(
        docs
        code
        apispec
        license
        research
        epistemic
        epistemic-band2
        epistemic-developer
    )

    if [[ "$LOCAL_MODE" == "true" ]]; then
        log "  Local re-indexing (sequential)..."
        for group in "${INDEXER_GROUPS[@]}"; do
            SOURCE_FILE="$PROJECT_ROOT/base/rag/indexer/sources-${group}.yaml"
            if [[ -f "$SOURCE_FILE" ]]; then
                log "  Indexing: $group"
                if [[ "$DRY_RUN" != "true" ]]; then
                    MILVUS_URI="${MILVUS_URI}" \
                    PYTHONPATH="$PROJECT_ROOT/base/rag/indexer" \
                    python3 -m app --sources "$SOURCE_FILE" \
                        --milvus-uri "${MILVUS_URI}" \
                        2>&1 | while IFS= read -r line; do log "    $line"; done || \
                        warn "Indexing failed for $group"
                fi
            else
                warn "Source file not found: $SOURCE_FILE"
            fi
        done
    else
        log "  Cluster re-indexing (one-shot jobs via deploy-indexer.sh)..."
        for group in "${INDEXER_GROUPS[@]}"; do
            log "  Triggering: $group"
            run "$SCRIPT_DIR/deploy-indexer.sh" "$ENV" --run "$group"
        done

        log ""
        log "  Jobs created. Monitor with:"
        log "    oc get jobs -n synesis-rag -l app.kubernetes.io/component=rag-indexer"
        log "    oc logs -n synesis-rag -l app.kubernetes.io/component=rag-indexer -f"
    fi
else
    log "Step 5: Re-indexing skipped (use --reindex to trigger)"
    log ""
    log "  To re-index manually:"
    log "    Cluster:  ./scripts/deploy-indexer.sh $ENV --run docs"
    log "    Local:    cd base/rag/indexer && python -m app --sources sources-docs.yaml"
fi

log ""

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
log "=== Clean RAG Complete ==="
log ""
log "  Collection: $COLLECTION"
log "  Schema:     v$SCHEMA_VERSION"
log "  Status:     dropped and recreated (empty)"
if [[ "$REINDEX" == "true" ]]; then
    log "  Reindex:    triggered for ${#INDEXER_GROUPS[@]} source groups"
else
    log "  Reindex:    not triggered (run with --reindex)"
fi
log ""
log "  Verify collection:"
if [[ "$LOCAL_MODE" == "true" ]]; then
    log "    python3 -c \"from pymilvus import MilvusClient; c = MilvusClient(uri='${MILVUS_URI}'); print(c.describe_collection('$COLLECTION'))\""
else
    log "    oc exec <milvus-pod> -n synesis-rag -- curl -s http://localhost:19530/v2/vectordb/collections/describe -d '{\"collectionName\": \"$COLLECTION\"}'"
fi
log ""
