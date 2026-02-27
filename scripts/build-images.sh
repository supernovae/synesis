#!/usr/bin/env bash
set -euo pipefail

# Synesis Image Builder
#
# Builds all custom container images and optionally pushes to a registry.
#
# Usage:
#   ./scripts/build-images.sh                            # build all
#   ./scripts/build-images.sh --push                     # build + push
#   ./scripts/build-images.sh --push --tag v0.1.0        # build + push with version tag
#   ./scripts/build-images.sh --only planner,admin       # build subset
#   ./scripts/build-images.sh --list                     # list images and exit
#
# Environment:
#   SYNESIS_REGISTRY   Override the registry prefix (default: ghcr.io/bymiller/synesis)
#   CONTAINER_ENGINE   Force podman or docker (auto-detected if unset)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

REGISTRY="${SYNESIS_REGISTRY:-ghcr.io/supernovae/synesis}"
TAG="latest"
PUSH=false
ONLY=""
LIST_ONLY=false
PLATFORM=""

for arg in "$@"; do
    case "$arg" in
        --push)    PUSH=true ;;
        --list)    LIST_ONLY=true ;;
        --tag=*)   TAG="${arg#--tag=}" ;;
        --tag)     shift_next=tag ;;
        --only=*)  ONLY="${arg#--only=}" ;;
        --only)    shift_next=only ;;
        --platform=*) PLATFORM="${arg#--platform=}" ;;
        --platform)   shift_next=platform ;;
        --help|-h)
            sed -n '3,12p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            if [[ "${shift_next:-}" == "tag" ]]; then
                TAG="$arg"; shift_next=""
            elif [[ "${shift_next:-}" == "only" ]]; then
                ONLY="$arg"; shift_next=""
            elif [[ "${shift_next:-}" == "platform" ]]; then
                PLATFORM="$arg"; shift_next=""
            else
                echo "Unknown argument: $arg" >&2
                exit 1
            fi
            ;;
    esac
done

# --- Container engine detection ---

if [[ -n "${CONTAINER_ENGINE:-}" ]]; then
    ENGINE="$CONTAINER_ENGINE"
elif command -v podman &>/dev/null; then
    ENGINE="podman"
elif command -v docker &>/dev/null; then
    ENGINE="docker"
else
    echo "ERROR: Neither podman nor docker found in PATH." >&2
    exit 1
fi

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }

# --- Image definitions ---
# Format: name|dockerfile_relative_to_project|build_context_relative_to_project

IMAGES=(
    "planner|base/planner/Dockerfile|base/planner"
    "admin|base/admin/Dockerfile|base/admin"
    "lsp-gateway|base/lsp/gateway/Dockerfile|base/lsp/gateway"
    "sandbox|base/sandbox/image/Dockerfile|base/sandbox/image"
    "bge-reranker|base/planner/bge-reranker/Dockerfile|base/planner/bge-reranker"
    "ingestor|base/rag/ingestion/Dockerfile|base/rag/ingestion"
    "indexer-code|base/rag/indexers/code/Dockerfile|base/rag"
    "indexer-apispec|base/rag/indexers/apispec/Dockerfile|base/rag"
    "indexer-architecture|base/rag/indexers/architecture/Dockerfile|base/rag"
    "indexer-license|base/rag/indexers/license/Dockerfile|base/rag"
)

if [[ "$LIST_ONLY" == "true" ]]; then
    printf "%-25s %s\n" "IMAGE" "FULL NAME"
    printf "%-25s %s\n" "-----" "---------"
    for entry in "${IMAGES[@]}"; do
        IFS='|' read -r name _ _ <<< "$entry"
        printf "%-25s %s\n" "$name" "$REGISTRY/$name:$TAG"
    done
    exit 0
fi

# --- Filter images if --only is set ---

if [[ -n "$ONLY" ]]; then
    IFS=',' read -ra ONLY_LIST <<< "$ONLY"
    FILTERED=()
    for entry in "${IMAGES[@]}"; do
        IFS='|' read -r name _ _ <<< "$entry"
        for filter in "${ONLY_LIST[@]}"; do
            if [[ "$name" == "$filter" ]]; then
                FILTERED+=("$entry")
                break
            fi
        done
    done
    if [[ ${#FILTERED[@]} -eq 0 ]]; then
        echo "ERROR: No images matched --only=$ONLY" >&2
        echo "Available: $(printf '%s\n' "${IMAGES[@]}" | cut -d'|' -f1 | tr '\n' ',' | sed 's/,$//')" >&2
        exit 1
    fi
    IMAGES=("${FILTERED[@]}")
fi

# --- Build ---

PLATFORM_FLAG=""
if [[ -n "$PLATFORM" ]]; then
    PLATFORM_FLAG="--platform=$PLATFORM"
fi

log "=== Synesis Image Builder ==="
log "Engine:   $ENGINE"
log "Registry: $REGISTRY"
log "Tag:      $TAG"
log "Push:     $PUSH"
log "Images:   ${#IMAGES[@]}"
log ""

FAILED=()
SUCCEEDED=()

for entry in "${IMAGES[@]}"; do
    IFS='|' read -r name dockerfile context <<< "$entry"

    full_image="$REGISTRY/$name"
    log "--- Building $name ---"
    log "  Dockerfile: $dockerfile"
    log "  Context:    $context"
    log "  Image:      $full_image:$TAG"

    if ! $ENGINE build \
        "$PLATFORM_FLAG" \
        -f "$PROJECT_ROOT/$dockerfile" \
        -t "$full_image:$TAG" \
        "$PROJECT_ROOT/$context" 2>&1; then
        log "  FAILED: $name"
        FAILED+=("$name")
        continue
    fi

    if [[ "$TAG" != "latest" ]]; then
        $ENGINE tag "$full_image:$TAG" "$full_image:latest"
    fi

    SUCCEEDED+=("$name")
    log "  OK: $full_image:$TAG"

    if [[ "$PUSH" == "true" ]]; then
        log "  Pushing $full_image:$TAG..."
        if ! $ENGINE push "$full_image:$TAG" 2>&1; then
            log "  PUSH FAILED: $name"
            FAILED+=("$name (push)")
            continue
        fi
        if [[ "$TAG" != "latest" ]]; then
            $ENGINE push "$full_image:latest" 2>&1 || true
        fi
        log "  Pushed: $full_image:$TAG"
    fi

    log ""
done

log "=== Build Summary ==="
log "  Succeeded: ${#SUCCEEDED[@]} (${SUCCEEDED[*]:-none})"

if [[ ${#FAILED[@]} -gt 0 ]]; then
    log "  Failed:    ${#FAILED[@]} (${FAILED[*]})"
    log ""
    log "To retry failed images:"
    log "  $0 --only=$(IFS=,; echo "${FAILED[*]}") ${PUSH:+--push} --tag $TAG"
    exit 1
fi

if [[ "$PUSH" == "true" ]]; then
    log ""
    log "Images pushed to $REGISTRY"
    log ""
    log "To pull on OpenShift (if repo is private):"
    log "  oc create secret docker-registry ghcr-pull-secret \\"
    log "    --docker-server=ghcr.io \\"
    log "    --docker-username=<github-user> \\"
    log "    --docker-password=<ghcr-token> \\"
    log "    -n <namespace>"
    log "  oc secrets link default ghcr-pull-secret --for=pull -n <namespace>"
fi

log ""
log "Done."
