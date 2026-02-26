#!/usr/bin/env bash
set -euo pipefail

# Synesis Model Downloader
#
# Downloads all models defined in models.yaml from HuggingFace
# using the `hf` CLI. Reads the single source of truth so model
# changes in models.yaml automatically flow through.
#
# Prerequisites:
#   uv tool install huggingface-hub
#   hf auth login  (for gated models like Llama)
#
# Usage:
#   ./scripts/download-models.sh                    # Download all models
#   ./scripts/download-models.sh --model coder      # Download only the coder model
#   ./scripts/download-models.sh --dir /data/models  # Custom download directory

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MODELS_FILE="$PROJECT_ROOT/models.yaml"
DOWNLOAD_DIR="${HOME}/synesis-models"
TARGET_MODEL=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --model)   TARGET_MODEL="$2"; shift 2 ;;
        --model=*) TARGET_MODEL="${1#*=}"; shift ;;
        --dir)     DOWNLOAD_DIR="$2"; shift 2 ;;
        --dir=*)   DOWNLOAD_DIR="${1#*=}"; shift ;;
        --help|-h)
            echo "Usage: $0 [--model <name>] [--dir <path>]"
            echo ""
            echo "Downloads models defined in models.yaml from HuggingFace."
            echo ""
            echo "Options:"
            echo "  --model <name>  Download only this model (coder, supervisor, embedder)"
            echo "  --dir <path>    Download directory (default: ~/synesis-models)"
            echo ""
            echo "Prerequisites:"
            echo "  uv tool install huggingface-hub"
            echo "  hf auth login  (for gated models like Llama)"
            exit 0
            ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

log()  { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }
err()  { echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2; }

if [[ ! -f "$MODELS_FILE" ]]; then
    err "models.yaml not found at: $MODELS_FILE"
    exit 1
fi

check_prerequisites() {
    if ! command -v uv &>/dev/null; then
        err "'uv' not found. Install from: https://docs.astral.sh/uv/"
        exit 1
    fi

    if ! command -v hf &>/dev/null; then
        err "'hf' CLI not found."
        err "Install with: uv tool install huggingface-hub"
        exit 1
    fi
}

# Helper: run a Python snippet with pyyaml available via uv's ephemeral env.
# No system-level pyyaml install needed.
pyaml() {
    uv run --with pyyaml -- python3 "$@"
}

download_models() {
    # Parse models.yaml and emit one JSON line per model
    pyaml -c "
import yaml, json, sys
with open('$MODELS_FILE') as f:
    config = yaml.safe_load(f)
target = '$TARGET_MODEL'
found = False
for key, model in config.get('models', {}).items():
    if target and key != target:
        continue
    found = True
    print(json.dumps({
        'key': key,
        'repo': model['huggingface_repo'],
        'tokenizer_repo': model.get('tokenizer_repo', ''),
        'name': model['name'],
        'display_name': model.get('display_name', model['name']),
        'role': model.get('role', ''),
        's3_path': model.get('s3_path', f\"models/{model['name']}/\"),
    }))
if target and not found:
    available = ', '.join(config.get('models', {}).keys())
    print(json.dumps({'error': f\"Model '{target}' not found. Available: {available}\"}))
    sys.exit(1)
" | while IFS= read -r model_json; do
        # Check for error from parser
        local has_error
        has_error=$(echo "$model_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if 'error' in d else 'no')" 2>/dev/null || echo "no")
        if [[ "$has_error" == "yes" ]]; then
            err "$(echo "$model_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['error'])")"
            exit 1
        fi

        local repo tokenizer_repo display_name role s3_path local_dir
        repo=$(echo "$model_json"          | python3 -c "import json,sys; print(json.load(sys.stdin)['repo'])")
        tokenizer_repo=$(echo "$model_json"| python3 -c "import json,sys; print(json.load(sys.stdin)['tokenizer_repo'])")
        display_name=$(echo "$model_json"  | python3 -c "import json,sys; print(json.load(sys.stdin)['display_name'])")
        role=$(echo "$model_json"          | python3 -c "import json,sys; print(json.load(sys.stdin)['role'])")
        s3_path=$(echo "$model_json"       | python3 -c "import json,sys; print(json.load(sys.stdin)['s3_path'])")

        local_dir="$DOWNLOAD_DIR/${s3_path%/}"

        log ""
        log "============================================================"
        log "Model:     $display_name"
        log "Repo:      $repo"
        log "Role:      $role"
        log "Local dir: $local_dir"
        log "S3 path:   $s3_path"
        log "============================================================"

        mkdir -p "$local_dir"

        log "Downloading $repo..."
        if ! hf download "$repo" --local-dir "$local_dir"; then
            err "Failed to download $repo"
            err ""
            err "  If 'Repository not found': this is a gated model."
            err "  1. Accept the license: https://huggingface.co/$repo"
            err "  2. Log in: hf auth login"
            err "  3. Re-run this script"
            exit 1
        fi

        # Download tokenizer from base model if it differs from the quantized model
        if [[ -n "$tokenizer_repo" ]] && [[ "$tokenizer_repo" != "$repo" ]]; then
            local tokenizer_dir="$local_dir/tokenizer"
            mkdir -p "$tokenizer_dir"
            log "Downloading tokenizer from $tokenizer_repo..."
            hf download "$tokenizer_repo" \
                --include "tokenizer*" "special_tokens*" "vocab*" "merges*" \
                --local-dir "$tokenizer_dir"
        fi

        log "Done: $display_name"
    done
}

main() {
    log "=== Synesis Model Downloader ==="
    log "Reading models from: $MODELS_FILE"
    log "Download directory:  $DOWNLOAD_DIR"
    if [[ -n "$TARGET_MODEL" ]]; then
        log "Target model:       $TARGET_MODEL"
    fi
    log ""

    check_prerequisites
    download_models

    log ""
    log "=== Download complete ==="
    log ""
    log "Models saved to: $DOWNLOAD_DIR"
    log ""
    log "Directory structure:"
    find "$DOWNLOAD_DIR" -maxdepth 3 -type d 2>/dev/null | head -20 || true
    log ""
    log "Total size:"
    du -sh "$DOWNLOAD_DIR" 2>/dev/null || true
    log ""
    log "Next: upload to S3 with ./scripts/upload-models-s3.sh"
}

main
