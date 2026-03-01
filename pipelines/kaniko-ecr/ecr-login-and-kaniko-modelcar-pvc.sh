#!/bin/sh
# ECR login + Kaniko for Manager ModelCar — PVC path (model pre-downloaded).
# Args: ECR_URI IMAGE_TAG MODEL_NAME (order chosen so ECR_URI always has dkr.ecr)
# Env: CONTEXT_DIR, AWS_REGION.

set -e

# Support both formats: (1) ECR_URI::IMAGE_TAG::MODEL_NAME (single param, avoids DSP binding bugs)
# or (2) $1 $2 $3 as separate args
if [ -n "$1" ] && case "$1" in *::*::*) true ;; *) false ;; esac; then
  ECR_URI="${1%%::*}"
  rest="${1#*::}"
  IMAGE_TAG="${rest%%::*}"
  MODEL_NAME="${rest#*::}"
  export ECR_URI IMAGE_TAG MODEL_NAME
elif [ $# -ge 3 ]; then
  export ECR_URI="$1" && export IMAGE_TAG="$2" && export MODEL_NAME="$3"
elif [ -n "$1" ] && case "$1" in *dkr.ecr*) true ;; *) false ;; esac; then
  # Fallback: single arg that looks like ECR URI (delimiters lost?)
  export ECR_URI="$1" IMAGE_TAG="manager" MODEL_NAME="manager"
fi

MODEL_NAME="${MODEL_NAME:-manager}"
if [ -z "${ECR_URI:-}" ]; then
  echo "ERROR: ECR_URI required. Received: argc=$# argv1='${1:-}'" >&2
  exit 1
fi
IMAGE_TAG="${IMAGE_TAG:-manager}"

# Fail fast if ECR_URI looks wrong (e.g. "manager" -> Docker Hub instead of ECR)
case "$ECR_URI" in
  *dkr.ecr*) ;;
  *)
    echo "ERROR: ECR_URI must be an AWS ECR URI (e.g. 123456789012.dkr.ecr.region.amazonaws.com/repo). Got: '$ECR_URI'" >&2
    echo "HINT: Pass ecr_uri when running the pipeline: run-pipelines.py manager-split-build-only --ecr-uri YOUR_ECR_URI" >&2
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

# ECR max layer size is ~50 GiB. Split model into multiple COPY layers, each under 45 GiB.
MAX_LAYER_GB=45
MAX_LAYER_BYTES=$((MAX_LAYER_GB * 1024 * 1024 * 1024))
COPY_GROUPS=$(cd "$CONTEXT_DIR" && find models -type f -print0 | xargs -0 du -b | sort -rn | awk -v max="$MAX_LAYER_BYTES" '
  { size=$1; path=$2; if (path=="") next }
  total+size > max && total>0 { print group; group=""; total=0 }
  { group=(group=="" ? path : group " " path); total+=size }
  END { if (group!="") print group }
')

{
  echo "ARG MODEL_NAME=model"
  echo "FROM registry.access.redhat.com/ubi9/ubi-minimal:latest"
  echo "ARG MODEL_NAME"
  echo "$COPY_GROUPS" | while IFS= read -r line; do
    [ -n "$line" ] && echo "COPY $line /models/"
  done
  echo "WORKDIR /models"
  echo "LABEL org.opencontainers.image.title=\"Synesis ModelCar: \${MODEL_NAME}\""
  echo "LABEL com.redhat.rhaiis.modelcar=\"true\""
  echo "LABEL com.redhat.rhaiis.model-format=\"vllm\""
  echo "ENV MODEL_PATH=/models"
} > "$DOCKERFILE"

# MODEL_NAME passed via --build-arg to Kaniko; no sed needed (avoids / in values breaking sed)

DOCKER_CFG="${DOCKER_CONFIG:-/tmp/.docker-kaniko}"
mkdir -p "$DOCKER_CFG"
export DOCKER_CONFIG="$DOCKER_CFG"
REGISTRY="${ECR_URI%%/*}"
TOKEN=$(aws ecr get-login-password --region "$AWS_REGION")
echo "{\"auths\":{\"${REGISTRY}\":{\"username\":\"AWS\",\"password\":\"${TOKEN}\"}}}" > "$DOCKER_CFG/config.json"

/usr/local/bin/kaniko-executor \
  --single-snapshot \
  --no-push-cache \
  --compressed-caching=false \
  --snapshot-mode=redo \
  --ignore-path=/usr/bin/newuidmap \
  --ignore-path=/usr/bin/newgidmap \
  --dockerfile="$DOCKERFILE" \
  --context="dir://${CONTEXT_DIR}" \
  --build-arg "MODEL_NAME=${MODEL_NAME}" \
  --destination="$DEST" \
  --verbosity=info

echo "Pushed $DEST"
