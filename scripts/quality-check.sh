#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

mode="${1:---quick}"

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "quality-check: missing required command: $1" >&2
        exit 1
    fi
}

run() {
    echo "quality-check: $*"
    "$@"
}

require_cmd uvx
require_cmd shellcheck
require_cmd npm

export UV_CACHE_DIR="${UV_CACHE_DIR:-${TMPDIR:-/tmp}/synesis-uv-cache}"
export UV_TOOL_DIR="${UV_TOOL_DIR:-${TMPDIR:-/tmp}/synesis-uv-tools}"
mkdir -p "$UV_CACHE_DIR" "$UV_TOOL_DIR"

run uvx ruff check base/ --output-format=github
run uvx ruff format --check base/
run python3 scripts/check-authz-coverage.py
run python3 scripts/check-json-schema-contract-parity.py
run npm run lint

shell_files=()
while IFS= read -r file; do
    shell_files+=("$file")
done < <(
    find scripts base \
        -path '*/.venv/*' -prune -o \
        -path '*/.test-venv/*' -prune -o \
        -path '*/node_modules/*' -prune -o \
        -path '*/.work/*' -prune -o \
        -name '*.sh' -type f -print
)
if [ "${#shell_files[@]}" -gt 0 ]; then
    run shellcheck --severity=warning --shell=bash "${shell_files[@]}"
fi

yaml_files=()
while IFS= read -r file; do
    yaml_files+=("$file")
done < <(
    while IFS= read -r file; do
        [ -f "$file" ] && printf '%s\n' "$file"
    done < <(git ls-files base overlays | grep -E '\.ya?ml$' || true)
)
if [ "${#yaml_files[@]}" -gt 0 ]; then
    run uvx yamllint -c .yamllint.yml "${yaml_files[@]}"
fi
run python3 scripts/check-doc-reference-integrity.py

if [ "$mode" = "--full" ]; then
    run npm run build -w packages/synesis-telemetry
    run npm run build -w packages/synesis-context-trust
    run npm run build -w packages/synesis-manifest
    run npm run build -w packages/synesis-mcp-tools
    run npm run build -w packages/synesis-agent-orchestration
    run npm run build -w packages/synesis-upper-harness
    run npm run typecheck -w base/yarn-ts
    run npm run test -w base/yarn-ts

    (
        cd base/admin/frontend
        run npm run lint
        run npm run build
        run npm test
    )
elif [ "$mode" != "--quick" ]; then
    echo "usage: ./scripts/quality-check.sh [--quick|--full]" >&2
    exit 2
fi
