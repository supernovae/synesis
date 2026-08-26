#!/usr/bin/env bash
set -euo pipefail

# Synesis Dependency Locker
#
# Compiles every service's requirements.txt into a fully-resolved
# requirements.lock with SHA-256 hashes using `uv pip compile`.
#
# Lockfiles are compiled in dependency order so downstream services
# can be constrained to the versions already pinned in their base image.
#
# Usage:
#   ./scripts/lock-deps.sh               # recompile all lockfiles
#   ./scripts/lock-deps.sh admin         # recompile one service
#   ./scripts/lock-deps.sh --check       # exit non-zero if any lockfile is stale
#   ./scripts/lock-deps.sh --check --changed origin/main
#                                      # check only services affected by changed
#                                      # requirement inputs, plus dependents
#
# Prerequisites: uv >= 0.5 (https://docs.astral.sh/uv/)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

PYTHON_VERSION="3.12"
# Synesis Python images are UBI 10 based; target that glibc floor so uv can
# resolve packages that only ship newer manylinux wheels.
PLATFORM="x86_64-manylinux_2_34"

CHECK_ONLY=false
CHANGED_ONLY=false
BASE_REF=""
ONLY=""
CHECK_ALL=false
AFFECTED_SERVICES=""

while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
        --check)   CHECK_ONLY=true ;;
        --changed)
            CHANGED_ONLY=true
            if [ "${2:-}" ] && [[ "${2:-}" != --* ]]; then
                BASE_REF="$2"
                shift
            fi
            ;;
        --base-ref)
            BASE_REF="${2:-}"
            [ -n "$BASE_REF" ] || die "--base-ref requires a git ref or SHA"
            shift
            ;;
        --help|-h)
            sed -n '3,18p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)  ONLY="$arg" ;;
    esac
    shift
done

log() { echo "[lock-deps] $*"; }
die() { echo "[lock-deps] ERROR: $*" >&2; exit 1; }

command -v uv &>/dev/null || die "uv not found — install from https://docs.astral.sh/uv/"

# Keep local hook/check runs from depending on a user-global uv cache location.
# CI can still override UV_CACHE_DIR explicitly if it wants a shared cache.
if [ -z "${UV_CACHE_DIR:-}" ]; then
    export UV_CACHE_DIR="${TMPDIR:-/tmp}/synesis-uv-cache"
fi

# ---------------------------------------------------------------------------
# Service definitions — ordered by dependency tier.
#
# Each entry: "name|requirements_dir|constraint_name"
#
# constraint_name references another entry whose lockfile is passed via -c
# to keep versions compatible across image layers. Empty = standalone.
# ---------------------------------------------------------------------------

SERVICES=(
    # Tier 0: base images (no constraints)
    "base-api|base/images/base-api|"

    # Tier 1: base-ml (constrained by base-api)
    "base-ml|base/images/base-ml|base-api"

    # Tier 2: services on base-api
    "admin|base/admin|base-api"
    "ast-mcp|base/ast-mcp|base-api"
    "preprocess-service|base/rag/preprocess-service|base-api"
    "corpus-benchmarks|benchmarks/corpus|base-api"
    "curator|tools/curator|base-api"

    # Tier 2: services on base-ml
    "gliner-service|base/rag/gliner-service|base-ml"

    # Standalone (own venv or non-UBI base)
    "indexer|base/rag/indexer|"
    "nornic-retrieval-benchmark|benchmarks/retrieval|"
    "prompt-evaluation|tests/prompts|"
)

DEPENDENTS_OF() {
    local target="$1"
    local entry
    for entry in "${SERVICES[@]}"; do
        local n _d c
        IFS='|' read -r n _d c <<< "$entry"
        if [ "$c" = "$target" ]; then
            echo "$n"
        fi
    done
}

# Resolve the lockfile path for a named service.
lock_path_for() {
    local target="$1"
    local entry
    for entry in "${SERVICES[@]}"; do
        local n d _c
        IFS='|' read -r n d _c <<< "$entry"
        if [ "$n" = "$target" ]; then
            echo "$PROJECT_ROOT/$d/requirements.lock"
            return
        fi
    done
}

has_packages() {
    grep -qE '^[a-zA-Z]' "$1" 2>/dev/null
}

mark_service_and_dependents() {
    local target="$1"
    local dep
    case " $AFFECTED_SERVICES " in
        *" $target "*) return 0 ;;
    esac
    if [ -z "$AFFECTED_SERVICES" ]; then
        AFFECTED_SERVICES="$target"
    else
        AFFECTED_SERVICES="$AFFECTED_SERVICES $target"
    fi
    while IFS= read -r dep; do
        [ -n "$dep" ] || continue
        mark_service_and_dependents "$dep"
    done < <(DEPENDENTS_OF "$target")
}

service_is_affected() {
    local target="$1"
    if [ "$CHANGED_ONLY" != "true" ] || [ "$CHECK_ALL" = "true" ]; then
        return 0
    fi
    case " $AFFECTED_SERVICES " in
        *" $target "*) return 0 ;;
        *) return 1 ;;
    esac
}

changed_files() {
    if [ -n "$BASE_REF" ]; then
        git diff --name-only "$BASE_REF"...HEAD
    else
        git diff --name-only HEAD
    fi
}

resolve_changed_services() {
    if [ "$CHANGED_ONLY" != "true" ]; then
        return 0
    fi
    git rev-parse --is-inside-work-tree &>/dev/null || die "--changed requires a git worktree"

    local file entry name dir
    while IFS= read -r file; do
        [ -n "$file" ] || continue

        case "$file" in
            scripts/lock-deps.sh|.github/workflows/security.yml)
                CHECK_ALL=true
                return 0
                ;;
        esac

        for entry in "${SERVICES[@]}"; do
            IFS='|' read -r name dir _constraint <<< "$entry"
            case "$file" in
                "$dir/requirements.txt"|"$dir/requirements.lock"|"$dir/requirements.overrides.txt")
                    mark_service_and_dependents "$name"
                    ;;
            esac
        done
    done < <(changed_files)
}

common_args() {
    echo "--generate-hashes"
    echo "--python-version"
    echo "$PYTHON_VERSION"
    echo "--python-platform"
    echo "$PLATFORM"
    echo "--no-header"
    echo "--annotation-style"
    echo "line"
    echo "--custom-compile-command"
    echo "./scripts/lock-deps.sh"
}

compile_one() {
    local name="$1" dir="$2" constraint_name="$3"
    local src="$PROJECT_ROOT/$dir/requirements.txt"
    local out="$PROJECT_ROOT/$dir/requirements.lock"

    if [ ! -f "$src" ]; then
        log "SKIP $name — no requirements.txt at $dir"
        return 0
    fi

    if ! has_packages "$src"; then
        log "SKIP $name — requirements.txt has no packages"
        return 0
    fi

    local args=()
    args+=( --generate-hashes )
    args+=( --python-version "$PYTHON_VERSION" )
    args+=( --python-platform "$PLATFORM" )
    args+=( --no-header )
    args+=( --annotation-style line )
    args+=( --custom-compile-command "./scripts/lock-deps.sh" )

    if [ -n "$constraint_name" ]; then
        local constraint_lock
        constraint_lock="$(lock_path_for "$constraint_name")"
        if [ -n "$constraint_lock" ] && [ -f "$constraint_lock" ]; then
            args+=( -c "$constraint_lock" )
        else
            log "WARN $name — constraint $constraint_name lockfile not found, compiling without constraint"
        fi
    fi

    local overrides="$PROJECT_ROOT/$dir/requirements.overrides.txt"
    if [ -f "$overrides" ]; then
        args+=( --overrides "$overrides" )
    fi

    log "Compiling $name ($dir/requirements.txt)"
    # Compile to a temp file: `uv pip compile -o` against an existing lockfile
    # reuses that file as constraints, so in-place writes never fully refresh.
    local tmp
    tmp="$(mktemp)"
    uv pip compile "$src" "${args[@]}" -o "$tmp" 2>&1 \
        || { rm -f "$tmp"; die "Failed to compile $name"; }
    mv "$tmp" "$out"

    log "  -> $dir/requirements.lock"
}

check_one() {
    local name="$1" dir="$2" constraint_name="$3"
    local src="$PROJECT_ROOT/$dir/requirements.txt"
    local lock="$PROJECT_ROOT/$dir/requirements.lock"

    if [ ! -f "$src" ] || ! has_packages "$src"; then
        return 0
    fi

    if [ ! -f "$lock" ]; then
        log "STALE $name — requirements.lock missing"
        return 1
    fi

    local args=()
    args+=( --generate-hashes )
    args+=( --python-version "$PYTHON_VERSION" )
    args+=( --python-platform "$PLATFORM" )
    args+=( --no-header )
    args+=( --annotation-style line )
    args+=( --custom-compile-command "./scripts/lock-deps.sh" )

    if [ -n "$constraint_name" ]; then
        local constraint_lock
        constraint_lock="$(lock_path_for "$constraint_name")"
        if [ -n "$constraint_lock" ] && [ -f "$constraint_lock" ]; then
            args+=( -c "$constraint_lock" )
        fi
    fi

    local overrides="$PROJECT_ROOT/$dir/requirements.overrides.txt"
    if [ -f "$overrides" ]; then
        args+=( --overrides "$overrides" )
    fi

    local tmp compile_log
    tmp="$(mktemp)"
    compile_log="$(mktemp)"
    if ! uv pip compile "$src" "${args[@]}" -o "$tmp" >"$compile_log" 2>&1; then
        log "ERROR $name — failed to compile requirements.lock"
        sed 's/^/[lock-deps]   /' "$compile_log" >&2
        CHECK_FAILED=1
        rm -f "$tmp" "$compile_log"
        return 1
    fi
    rm -f "$compile_log"

    if ! diff -q "$lock" "$tmp" &>/dev/null; then
        log "STALE $name — requirements.lock differs from compiled output"
        rm -f "$tmp"
        return 1
    fi

    rm -f "$tmp"
    return 0
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

STALE=0
CHECK_FAILED=0

resolve_changed_services

if [ "$CHANGED_ONLY" = "true" ] && [ "$CHECK_ALL" != "true" ] && [ -z "$AFFECTED_SERVICES" ]; then
    log "No changed Python dependency inputs; skipping lockfile freshness check."
    exit 0
fi

if [ "$CHANGED_ONLY" = "true" ]; then
    if [ "$CHECK_ALL" = "true" ]; then
        log "Shared lockfile tooling changed; checking all lockfiles."
    else
        log "Checking changed lockfile set: $AFFECTED_SERVICES"
    fi
fi

for entry in "${SERVICES[@]}"; do
    IFS='|' read -r name dir constraint <<< "$entry"

    if [ -n "$ONLY" ] && [ "$name" != "$ONLY" ]; then
        continue
    fi

    if ! service_is_affected "$name"; then
        continue
    fi

    if [ "$CHECK_ONLY" = "true" ]; then
        check_one "$name" "$dir" "$constraint" || STALE=1
    else
        compile_one "$name" "$dir" "$constraint"
    fi
done

if [ "$CHECK_ONLY" = "true" ]; then
    if [ "$STALE" -eq 1 ]; then
        if [ "$CHECK_FAILED" -eq 1 ]; then
            die "Lockfile freshness check failed before comparison; see compile errors above"
        fi
        die "Stale lockfiles detected — run ./scripts/lock-deps.sh and commit the results"
    fi
    log "All lockfiles are up to date."
else
    log "Done."
fi
