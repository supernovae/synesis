#!/usr/bin/env bash
# Synesis Prompt Test Suite Runner
#
# Usage:
#   ./tests/prompts/run-test-suite.sh                    # Full suite against default endpoint
#   ./tests/prompts/run-test-suite.sh --dry-run           # Validate + show plan
#   ./tests/prompts/run-test-suite.sh --category knowledge trivial
#   ./tests/prompts/run-test-suite.sh --ids know-01 conv-01a conv-01b
#   SYNESIS_API_URL=http://localhost:8000 ./tests/prompts/run-test-suite.sh
#
# Environment:
#   SYNESIS_API_URL   API base URL (default: https://synesis-api.apps.openshiftdemo.dev)
#   SYNESIS_API_KEY   API key (default: sk-synesis-test)
#   SYNESIS_MODEL     Model name (default: synesis-agent)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if command -v uv &>/dev/null; then
  exec uv run --with "httpx>=0.27" --with "pyyaml>=6.0" \
    python "$SCRIPT_DIR/run_test_suite.py" "$@"
else
  exec python3 "$SCRIPT_DIR/run_test_suite.py" "$@"
fi
