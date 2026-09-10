#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

case "${1:---quick}" in
    --quick|--full) ;;
    *) echo "usage: ./scripts/quality-check.sh [--quick|--full]" >&2; exit 2 ;;
esac

uvx ruff check base/ scripts/ tests/
uvx ruff format --check base/ scripts/ tests/
npm run lint
shellcheck --severity=warning --shell=bash scripts/*.sh .githooks/pre-commit .githooks/pre-push
uvx yamllint -c .yamllint.yml .github/ base/rag/indexer/crawl_policy.yaml
python3 scripts/check-doc-reference-integrity.py

if [ "${1:---quick}" = "--full" ]; then
    npm run build
    npm test
    python3 -m unittest discover -s tests/dependencies -v
    PYTHONPATH=base/rag/indexer uv run --isolated --python 3.12 \
        --with-requirements base/rag/indexer/requirements.lock --with pytest \
        --no-project python -m pytest base/rag/indexer/tests -q
fi
