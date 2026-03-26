#!/usr/bin/env bash
set -euo pipefail

if ! command -v bun >/dev/null 2>&1; then
  echo "[bun-smoke] Bun not installed; skipping compatibility smoke checks."
  exit 0
fi

echo "[bun-smoke] Bun version: $(bun --version)"
echo "[bun-smoke] Running typecheck under Bun runtime..."
bun run typecheck

echo "[bun-smoke] Running test suite under Bun runtime..."
bun test

echo "[bun-smoke] Bun compatibility smoke checks passed."
