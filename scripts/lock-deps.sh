#!/usr/bin/env bash
set -euo pipefail

# Refresh the optional ingestion environment, or check declared requirements
# against its existing pins. New upstream releases alone do not make it stale.
# Usage: ./scripts/lock-deps.sh [--check]

case "${1:-}" in
    ""|--check) ;;
    --help|-h) echo "usage: ./scripts/lock-deps.sh [--check]"; exit 0 ;;
    *) echo "usage: ./scripts/lock-deps.sh [--check]" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
    echo "usage: ./scripts/lock-deps.sh [--check]" >&2
    exit 2
fi
command -v uv >/dev/null || { echo "uv is required" >&2; exit 1; }
cd "$(dirname "$0")/.."

source_dir=base/rag/indexer
lock="$source_dir/requirements.lock"
temporary="$(mktemp)"
trap 'rm -f "$temporary"' EXIT

if [ "${1:-}" = "--check" ]; then
    # Seed resolution: retain compatible selected versions and detect changed
    # requirements, including removed dependencies and their orphaned children.
    cp "$lock" "$temporary"
fi
uv pip compile "$source_dir/requirements.txt" \
    --python-version 3.12 --python-platform x86_64-manylinux_2_34 \
    --generate-hashes --no-header --quiet --output-file "$temporary"

if [ "${1:-}" = "--check" ]; then
    # Compare dependency/hash lines, not generated comments or whitespace.
    if ! diff -u <(sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d' "$lock") \
                 <(sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d' "$temporary"); then
        echo "STALE: $lock (refresh with ./scripts/lock-deps.sh)" >&2
        exit 1
    fi
    echo "OK: $lock"
else
    cp "$temporary" "$lock"
    echo "Updated $lock"
fi
