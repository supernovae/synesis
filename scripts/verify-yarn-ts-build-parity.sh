#!/usr/bin/env bash
# Mirrors base/yarn-ts/Containerfile compile steps so CI and local runs catch
# missing workspace packages before docker build (e.g. @synesis/mcp-tools).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
npm ci --ignore-scripts
npm run build --workspace=packages/synesis-telemetry
npm run build --workspace=packages/synesis-context-trust
npm run build --workspace=packages/synesis-manifest
npm run build --workspace=packages/synesis-mcp-tools
npm run build --workspace=packages/synesis-upper-harness
npm run build --workspace=base/yarn-ts
echo "ok: yarn-ts build parity (Containerfile order)"
