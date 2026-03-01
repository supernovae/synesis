#!/bin/sh
# ECR login + Buildah for Manager ModelCar — PVC path (model pre-downloaded).
# Red Hat stack. Logical layering: metadata first, then model shards (~20GB each).
# Args: ECR_URI::IMAGE_TAG::MODEL_NAME or $1 $2 $3
# Env: CONTEXT_DIR, AWS_REGION.

set -e

# Support both formats
if [ -n "$1" ] && case "$1" in *::*::*) true ;; *) false ;; esac; then
  ECR_URI="${1%%::*}"
  rest="${1#*::}"
  IMAGE_TAG="${rest%%::*}"
  MODEL_NAME="${rest#*::}"
  export ECR_URI IMAGE_TAG MODEL_NAME
elif [ $# -ge 3 ]; then
  export ECR_URI="$1" && export IMAGE_TAG="$2" && export MODEL_NAME="$3"
elif [ -n "$1" ] && case "$1" in *dkr.ecr*) true ;; *) false ;; esac; then
  export ECR_URI="$1" IMAGE_TAG="manager" MODEL_NAME="manager"
fi

MODEL_NAME="${MODEL_NAME:-manager}"
if [ -z "${ECR_URI:-}" ]; then
  echo "ERROR: ECR_URI required. Received: argc=$# argv1='${1:-}'" >&2
  exit 1
fi
IMAGE_TAG="${IMAGE_TAG:-manager}"

case "$ECR_URI" in
  *dkr.ecr*) ;;
  *)
    echo "ERROR: ECR_URI must be an AWS ECR URI. Got: '$ECR_URI'" >&2
    exit 1
    ;;
esac

DEST="${ECR_URI}:${IMAGE_TAG}"
CONTEXT_DIR="${CONTEXT_DIR:-/data}"
AWS_REGION="${AWS_REGION:-us-east-1}"
DOCKERFILE="${CONTEXT_DIR}/Dockerfile"

if [ ! -d "${CONTEXT_DIR}/models" ]; then
  echo "ERROR: ${CONTEXT_DIR}/models not found. Run download task first." >&2
  exit 1
fi

# Logical layering: metadata first (one layer), then model shards ~20GB each.
# ECR max 50GB; 20GB = manageable, benefits parallel pull on deploy.
MAX_LAYER_GB=20
MAX_LAYER_BYTES=$((MAX_LAYER_GB * 1024 * 1024 * 1024))

cd "$CONTEXT_DIR"
# Layer 1: metadata (config, tokenizer, etc.) — small, cache-friendly
METADATA=$(find models -type f \( \
  -name 'config.json' -o -name 'tokenizer.json' -o -name 'tokenizer_config.json' \
  -o -name 'generation_config.json' -o -name 'special_tokens_map.json' \
  -o -name '*.model' -o -name '*.py' -o -name '*.tiktoken' -o -name 'merges.txt' \
  -o -name 'vocab.json' \) -print 2>/dev/null | tr '\n' ' ')
# Layers 2+: model data (safetensors, bin) — group to 20GB
SHARDS=$(find models -type f \( -name '*.safetensors' -o -name '*.bin' \) -print0 2>/dev/null | xargs -0 du -b 2>/dev/null | sort -rn | awk -v max="$MAX_LAYER_BYTES" '
  { size=$1; path=$2; if (path=="") next }
  total+size > max && total>0 { print group; group=""; total=0 }
  { group=(group=="" ? path : group " " path); total+=size }
  END { if (group!="") print group }
')
# Other files (params.json, etc.)
OTHER=$(find models -type f ! -name 'Dockerfile*' ! -name 'config.json' ! -name 'tokenizer*.json' ! -name 'tokenizer_config.json' ! -name 'generation_config.json' ! -name 'special_tokens_map.json' ! -name '*.model' ! -name '*.py' ! -name '*.tiktoken' ! -name 'merges.txt' ! -name 'vocab.json' ! -name '*.safetensors' ! -name '*.bin' -print0 2>/dev/null | xargs -0 du -b 2>/dev/null | sort -rn | awk -v max="$MAX_LAYER_BYTES" '
  { size=$1; path=$2; if (path=="") next }
  total+size > max && total>0 { print group; group=""; total=0 }
  { group=(group=="" ? path : group " " path); total+=size }
  END { if (group!="") print group }
')

{
  echo "ARG MODEL_NAME=model"
  echo "FROM registry.access.redhat.com/ubi9/ubi-minimal:latest"
  echo "ARG MODEL_NAME"
  if [ -n "$METADATA" ]; then
    echo "COPY $METADATA /models/"
  fi
  echo "$SHARDS" | while IFS= read -r line; do
    [ -n "$line" ] && echo "COPY $line /models/"
  done
  echo "$OTHER" | while IFS= read -r line; do
    [ -n "$line" ] && echo "COPY $line /models/"
  done
  echo "WORKDIR /models"
  echo "LABEL org.opencontainers.image.title=\"Synesis ModelCar: \${MODEL_NAME}\""
  echo "LABEL com.redhat.rhaiis.modelcar=\"true\""
  echo "LABEL com.redhat.rhaiis.model-format=\"vllm\""
  echo "ENV MODEL_PATH=/models"
} > "$DOCKERFILE"

DOCKER_CFG="${DOCKER_CONFIG:-/tmp/.docker-buildah}"
mkdir -p "$DOCKER_CFG"
export DOCKER_CONFIG="$DOCKER_CFG"
REGISTRY="${ECR_URI%%/*}"
TOKEN=$(aws ecr get-login-password --region "$AWS_REGION")
echo "{\"auths\":{\"${REGISTRY}\":{\"username\":\"AWS\",\"password\":\"${TOKEN}\"}}}" > "$DOCKER_CFG/config.json"

# Buildah build and push. --layers=false to avoid caching (we want fresh); storage in tmp
buildah bud --build-arg "MODEL_NAME=${MODEL_NAME}" \
  -f "$DOCKERFILE" \
  -t "$DEST" \
  "$CONTEXT_DIR"
buildah push "$DEST" "docker://$DEST"

echo "Pushed $DEST"
