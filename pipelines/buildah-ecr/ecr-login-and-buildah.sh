#!/bin/sh
# ECR login + Buildah for Executor ModelCar (NVFP4 quantized model on PVC).
# Red Hat stack. Same logical layering as manager.
# Args: $1=model_context, $2=ecr_uri, $3=image_tag
# Env: MODEL_CONTEXT, ECR_URI, IMAGE_TAG, AWS_REGION.

set -e

export BUILDAH_ISOLATION=chroot
export BUILDAH_DRIVER="${BUILDAH_DRIVER:-overlay}"

MODEL_CONTEXT="${1:-${MODEL_CONTEXT:-/data/executor-model}}"
ECR_URI="${2:-${ECR_URI:?ECR_URI required}}"
IMAGE_TAG="${3:-${IMAGE_TAG:-executor-nvfp4}}"
AWS_REGION="${AWS_REGION:-us-east-1}"
DEST="${ECR_URI}:${IMAGE_TAG}"

DOCKER_CFG="${DOCKER_CONFIG:-/tmp/.docker-buildah}"
mkdir -p "$DOCKER_CFG"
export DOCKER_CONFIG="$DOCKER_CFG"
REGISTRY="${ECR_URI%%/*}"
TOKEN=$(aws ecr get-login-password --region "$AWS_REGION")
echo "{\"auths\":{\"${REGISTRY}\":{\"username\":\"AWS\",\"password\":\"${TOKEN}\"}}}" > "$DOCKER_CFG/config.json"

if echo "$MODEL_CONTEXT" | grep -q '^s3://'; then
  echo "ERROR: Buildah does not support s3:// context. Use dir context." >&2
  exit 1
fi

# Generate Dockerfile with logical layering. 10GB = universal (ECR Public, GHCR).
GENERATED_DF="${MODEL_CONTEXT}/Dockerfile.generated"
MAX_LAYER_GB=10
MAX_LAYER_BYTES=$((MAX_LAYER_GB * 1024 * 1024 * 1024))

cd "$MODEL_CONTEXT"
METADATA=$(find . -type f ! -name 'Dockerfile*' \( \
  -name 'config.json' -o -name 'tokenizer.json' -o -name 'tokenizer_config.json' \
  -o -name 'generation_config.json' -o -name 'special_tokens_map.json' \
  -o -name '*.model' -o -name '*.py' -o -name '*.tiktoken' -o -name 'merges.txt' \
  -o -name 'vocab.json' \) -print 2>/dev/null | sed 's|^\./||' | tr '\n' ' ')
SHARDS=$(find . -type f ! -name 'Dockerfile*' \( -name '*.safetensors' -o -name '*.bin' \) -print0 2>/dev/null | xargs -0 du -b 2>/dev/null | sort -rn | awk -v max="$MAX_LAYER_BYTES" '
  { size=$1; path=$2; if (path=="") next; sub(/^\.\//,"",path); if (path=="") next }
  total+size > max && total>0 { print group; group=""; total=0 }
  { group=(group=="" ? path : group " " path); total+=size }
  END { if (group!="") print group }
')
OTHER=$(find . -type f ! -name 'Dockerfile*' ! -name 'config.json' ! -name 'tokenizer*.json' ! -name 'tokenizer_config.json' ! -name 'generation_config.json' ! -name 'special_tokens_map.json' ! -name '*.model' ! -name '*.py' ! -name '*.tiktoken' ! -name 'merges.txt' ! -name 'vocab.json' ! -name '*.safetensors' ! -name '*.bin' -print0 2>/dev/null | xargs -0 du -b 2>/dev/null | sort -rn | awk -v max="$MAX_LAYER_BYTES" '
  { size=$1; path=$2; if (path=="") next; sub(/^\.\//,"",path); if (path=="") next }
  total+size > max && total>0 { print group; group=""; total=0 }
  { group=(group=="" ? path : group " " path); total+=size }
  END { if (group!="") print group }
')

{
  echo "FROM registry.access.redhat.com/ubi9/ubi-minimal:latest"
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
  echo "LABEL org.opencontainers.image.title=\"Synesis ModelCar (NVFP4)\""
  echo "LABEL com.redhat.rhaiis.modelcar=\"true\""
  echo "ENV MODEL_PATH=/models"
} > "$GENERATED_DF"

buildah bud --isolation=chroot --storage-driver="${BUILDAH_DRIVER:-overlay}" -f "$GENERATED_DF" -t "$DEST" "$MODEL_CONTEXT"
buildah push "$DEST" "docker://$DEST"

echo "Pushed $DEST"
