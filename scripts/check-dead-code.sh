#!/usr/bin/env bash
# Dead-code scan: vulture at 100% confidence on Synesis app packages.
# Excludes base/planner/app/main.py (vulture false positives on async SSE generator CFG).
#
# Usage (from repo root):
#   uv sync --group dev
#   ./scripts/check-dead-code.sh
#
# Optional — coverage for synesis_telemetry (telemetry unit tests only):
#   PYTHONPATH=base/images/base-api/synesis-telemetry \
#     uv run --group dev pytest base/planner/tests/test_telemetry.py \
#     -q --cov=synesis_telemetry --cov-report=term --cov-config=pyproject.toml

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_ROOTS=(
  base/admin/app
  base/lsp/gateway/app
  base/mcp/app
  base/planner/bge-reranker/app
  base/rag/gliner-service/app
  base/rag/indexer/app
  base/rag/keyword-service/app
  base/rag/preprocess-service/app
  base/rag/spam-service/app
  base/yarn/app
  base/images/base-api/synesis-telemetry/synesis_telemetry
)

for d in "${APP_ROOTS[@]}"; do
  echo "vulture: $d"
  uv run vulture "$d" --min-confidence 100
done

echo "vulture: base/planner/app (excluding main.py — SSE generator control-flow)"
uv run vulture base/planner/app --min-confidence 100 --exclude main.py

echo "vulture: OK"
