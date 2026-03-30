#!/usr/bin/env bash
set -euo pipefail

echo "[verify-gates] Running TypeScript typecheck..."
npm run typecheck

echo "[verify-gates] Running planner-ts test suite..."
npm test

echo "[verify-gates] Running optional Bun smoke checks..."
npm run bun:smoke

echo "[verify-gates] All configured gates passed."
