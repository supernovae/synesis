#!/usr/bin/env bash
set -euo pipefail

echo "[verify-gates] Running TypeScript typecheck..."
npm run typecheck

echo "[verify-gates] Running planner-ts test suite..."
npm test

echo "[verify-gates] Running optional Bun smoke checks..."
npm run bun:smoke

if [[ "${SYNESIS_PLANNER_TS_COMPARE_PY_BASELINE:-false}" == "true" ]]; then
  echo "[verify-gates] Running Python baseline comparator mode..."
  SYNESIS_PLANNER_TS_COMPARE_PY_BASELINE=true npm test
else
  echo "[verify-gates] Skipping Python baseline compare (set SYNESIS_PLANNER_TS_COMPARE_PY_BASELINE=true to enable)."
fi

echo "[verify-gates] All configured gates passed."
