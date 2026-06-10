#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
[generate-model-configs] retired

Synesis .1 removed models.yaml-driven profile generation.
Model routing is now DB-first through Synesis Admin:
  - Seed providers at startup (no API keys by default)
  - Assign role -> provider/model in Model Registry
  - Runtime routes read directly from the admin registry

Self-hosted vLLM model weight management is operator-owned pending a
first-class model manager. The retired KFP model-download flow has been
removed.

For deployment verification use:
  - Admin UI: Models -> Model Registry / Providers
  - API: GET /api/v1/models/roles and GET /api/v1/provider-governance
EOF
