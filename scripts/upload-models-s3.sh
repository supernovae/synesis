#!/usr/bin/env bash
set -euo pipefail

# Synesis S3 Model Uploader
#
# Uploads locally downloaded models to S3-compatible storage.
# Reads models.yaml for S3 paths so changes there automatically flow through.
#
# Supports: AWS S3, MinIO, any S3-compatible endpoint.
#
# Prerequisites:
#   - aws cli (pip install awscli) or mc (MinIO client)
#   - Models already downloaded via ./scripts/download-models.sh
#
# Usage:
#   ./scripts/upload-models-s3.sh                          # Upload all models
#   ./scripts/upload-models-s3.sh --model coder            # Upload only coder
#   ./scripts/upload-models-s3.sh --endpoint http://minio:9000  # Custom endpoint
#   ./scripts/upload-models-s3.sh --use-mc                 # Use MinIO client instead of aws cli

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MODELS_FILE="$PROJECT_ROOT/models.yaml"
DOWNLOAD_DIR="${HOME}/synesis-models"
TARGET_MODEL=""
S3_ENDPOINT=""
S3_BUCKET=""
USE_MC=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --model)       TARGET_MODEL="$2"; shift 2 ;;
        --model=*)     TARGET_MODEL="${1#*=}"; shift ;;
        --dir)         DOWNLOAD_DIR="$2"; shift 2 ;;
        --dir=*)       DOWNLOAD_DIR="${1#*=}"; shift ;;
        --endpoint)    S3_ENDPOINT="$2"; shift 2 ;;
        --endpoint=*)  S3_ENDPOINT="${1#*=}"; shift ;;
        --bucket)      S3_BUCKET="$2"; shift 2 ;;
        --bucket=*)    S3_BUCKET="${1#*=}"; shift ;;
        --use-mc)      USE_MC=true; shift ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Uploads downloaded models to S3-compatible storage."
            echo ""
            echo "Options:"
            echo "  --model <name>       Upload only this model (coder, supervisor, embedder)"
            echo "  --dir <path>         Local model directory (default: ~/synesis-models)"
            echo "  --endpoint <url>     S3 endpoint URL (reads from models.yaml if not set)"
            echo "  --bucket <name>      S3 bucket name (reads from models.yaml if not set)"
            echo "  --use-mc             Use MinIO client (mc) instead of aws cli"
            echo ""
            echo "Environment variables:"
            echo "  AWS_ACCESS_KEY_ID      S3 access key"
            echo "  AWS_SECRET_ACCESS_KEY  S3 secret key"
            echo "  AWS_DEFAULT_REGION     S3 region (default: us-east-1)"
            exit 0
            ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }
err() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2; }
warn() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $*" >&2; }

if [[ ! -f "$MODELS_FILE" ]]; then
    err "models.yaml not found at: $MODELS_FILE"
    exit 1
fi

# Helper: run Python with pyyaml via uv's ephemeral env
pyaml() {
    uv run --with pyyaml -- python3 "$@"
}

# Parse storage config from models.yaml
read_storage_config() {
    pyaml -c "
import yaml, json, sys
with open('$MODELS_FILE') as f:
    config = yaml.safe_load(f)
storage = config.get('storage', {})
print(json.dumps(storage))
"
}

STORAGE_JSON=$(read_storage_config)

if [[ -z "$S3_BUCKET" ]]; then
    S3_BUCKET=$(echo "$STORAGE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('bucket','synesis-models'))")
fi
if [[ -z "$S3_ENDPOINT" ]]; then
    S3_ENDPOINT=$(echo "$STORAGE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('endpoint',''))")
fi

check_credentials() {
    if [[ "$USE_MC" == "true" ]]; then
        if [[ -z "${AWS_ACCESS_KEY_ID:-}" ]] || [[ -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
            err "MinIO client (mc) requires explicit credentials."
            err "  export AWS_ACCESS_KEY_ID=minioadmin"
            err "  export AWS_SECRET_ACCESS_KEY=minioadmin"
            exit 1
        fi
        return
    fi

    # Try existing AWS session first (SAML, SSO, instance profile, env vars)
    if aws sts get-caller-identity &>/dev/null; then
        local identity
        identity=$(aws sts get-caller-identity --output text --query 'Arn' 2>/dev/null || echo "unknown")
        log "Authenticated as: $identity"
        return
    fi

    err "No valid AWS session found."
    err ""
    err "Authenticate using one of:"
    err "  aws sso login              # AWS SSO / IAM Identity Center"
    err "  saml2aws login             # SAML federation"
    err "  aws configure              # Static credentials"
    err ""
    err "Or set environment variables:"
    err "  export AWS_ACCESS_KEY_ID=your-access-key"
    err "  export AWS_SECRET_ACCESS_KEY=your-secret-key"
    err ""
    err "For MinIO on-cluster:"
    err "  oc port-forward svc/minio 9000:9000 -n synesis-models"
    err "  $0 --use-mc --endpoint http://localhost:9000"
    exit 1
}

upload_with_aws() {
    local local_path="$1"
    local s3_path="$2"

    local endpoint_flag=""
    if [[ -n "$S3_ENDPOINT" ]]; then
        endpoint_flag="--endpoint-url $S3_ENDPOINT"
    fi

    log "  aws s3 sync $local_path -> s3://$S3_BUCKET/$s3_path"
    # shellcheck disable=SC2086
    aws s3 sync "$local_path" "s3://${S3_BUCKET}/${s3_path}" \
        $endpoint_flag \
        --no-progress \
        --only-show-errors
}

upload_with_mc() {
    local local_path="$1"
    local s3_path="$2"

    mc alias set synesis "$S3_ENDPOINT" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" 2>/dev/null || true

    log "  mc mirror $local_path -> synesis/$S3_BUCKET/$s3_path"
    mc mirror --overwrite "$local_path" "synesis/${S3_BUCKET}/${s3_path}"
}

upload_model() {
    local local_path="$1"
    local s3_path="$2"

    if [[ "$USE_MC" == "true" ]]; then
        upload_with_mc "$local_path" "$s3_path"
    else
        upload_with_aws "$local_path" "$s3_path"
    fi
}

upload_models() {
    pyaml -c "
import yaml, json, sys
with open('$MODELS_FILE') as f:
    config = yaml.safe_load(f)
models = config.get('models', {})
target = '$TARGET_MODEL'
for key, model in models.items():
    if target and key != target:
        continue
    print(json.dumps({'key': key, 'name': model['name'], 's3_path': model.get('s3_path', f\"models/{model['name']}/\"), 'display_name': model.get('display_name', model['name'])}))
" | while IFS= read -r model_json; do
        local s3_path display_name local_path
        s3_path=$(echo "$model_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['s3_path'])")
        display_name=$(echo "$model_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['display_name'])")
        local_path="$DOWNLOAD_DIR/${s3_path%/}"

        log ""
        log "Uploading: $display_name"
        log "  From: $local_path"
        log "  To:   s3://$S3_BUCKET/$s3_path"

        if [[ ! -d "$local_path" ]]; then
            warn "Local path not found: $local_path"
            warn "  Run ./scripts/download-models.sh first"
            continue
        fi

        local size
        size=$(du -sh "$local_path" 2>/dev/null | cut -f1 || echo "unknown")
        log "  Size: $size"

        upload_model "$local_path" "$s3_path"
        log "  Done: $display_name"
    done
}

main() {
    log "=== Synesis S3 Model Uploader ==="
    log "Models file: $MODELS_FILE"
    log "Local dir:   $DOWNLOAD_DIR"
    log "S3 bucket:   $S3_BUCKET"
    log "S3 endpoint: ${S3_ENDPOINT:-<default AWS>}"
    log "Client:      $(if [[ "$USE_MC" == "true" ]]; then echo "mc (MinIO)"; else echo "aws cli"; fi)"
    if [[ -n "$TARGET_MODEL" ]]; then
        log "Target:      $TARGET_MODEL"
    fi
    log ""

    check_credentials

    if [[ "$USE_MC" == "true" ]]; then
        command -v mc &>/dev/null || { err "mc (MinIO client) not found. Install from https://min.io/docs/minio/linux/reference/minio-mc.html"; exit 1; }
    else
        command -v aws &>/dev/null || { err "aws cli not found. Install with: pip install awscli"; exit 1; }
    fi

    upload_models

    log ""
    log "=== Upload complete ==="
    log ""
    log "Verify with:"
    if [[ "$USE_MC" == "true" ]]; then
        log "  mc ls synesis/$S3_BUCKET/models/"
    else
        local ef=""
        [[ -n "$S3_ENDPOINT" ]] && ef="--endpoint-url $S3_ENDPOINT"
        log "  aws s3 ls s3://$S3_BUCKET/models/ $ef"
    fi
    log ""
    log "Next: update base/model-serving/model-storage-secret.yaml with your S3 credentials"
    log "Then: ./scripts/deploy.sh dev"
}

main
