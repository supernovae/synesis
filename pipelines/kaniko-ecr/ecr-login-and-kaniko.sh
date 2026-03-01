#!/bin/sh
# ECR login + Kaniko for IRSA-based pipeline.
# Env: MODEL_CONTEXT, ECR_URI, IMAGE_TAG, AWS_REGION (IRSA provides AWS_*).
# Or args: $1=model_context, $2=ecr_uri, $3=image_tag (optional).
# CONTAINERFILE_PATH overrides baked-in ModelCar Containerfile path.

set -e

MODEL_CONTEXT="${1:-${MODEL_CONTEXT:-/workspace/model}}"
ECR_URI="${2:-${ECR_URI:?ECR_URI required}}"
IMAGE_TAG="${3:-${IMAGE_TAG:-executor-nvfp4}}"
AWS_REGION="${AWS_REGION:-us-east-1}"
CONTAINERFILE="${CONTAINERFILE_PATH:-/workspace/Containerfile.modelcar}"
DEST="${ECR_URI}:${IMAGE_TAG}"

# Use writable paths; pipeline pods may run as user with no write access to /workspace.
DOCKER_CFG="${DOCKER_CONFIG:-/tmp/.docker-kaniko}"
mkdir -p "$DOCKER_CFG"
export DOCKER_CONFIG="$DOCKER_CFG"
# Use default /kaniko (created in image with chmod 777).
# Use IRSA credentials to get ECR token and write Docker config for Kaniko
REGISTRY="${ECR_URI%%/*}"
TOKEN=$(aws ecr get-login-password --region "$AWS_REGION")
cat > "$DOCKER_CFG/config.json" << EOF
{"auths":{"${REGISTRY}":{"username":"AWS","password":"${TOKEN}"}}}
EOF

# Run Kaniko (context can be dir:// or s3://)
if echo "$MODEL_CONTEXT" | grep -q '^s3://'; then
  CONTEXT="s3://${MODEL_CONTEXT#s3://}"
  DOCKERFILE_GENERATED=""
else
  CONTEXT="dir://${MODEL_CONTEXT}"
  # ECR max layer size ~50 GiB. Generate split Dockerfile for dir context to stay under limit.
  GENERATED_DF="${MODEL_CONTEXT}/Dockerfile.generated"
  MAX_LAYER_GB=45
  MAX_LAYER_BYTES=$((MAX_LAYER_GB * 1024 * 1024 * 1024))
  if [ -d "$MODEL_CONTEXT" ]; then
    COPY_GROUPS=$(cd "$MODEL_CONTEXT" && find . -type f ! -name 'Dockerfile*' -print0 | xargs -0 du -b 2>/dev/null | sort -rn | awk -v max="$MAX_LAYER_BYTES" '
      { size=$1; path=$2; if (path=="" || path~/Dockerfile/) next; sub(/^\.\//,"",path); if (path=="") next }
      total+size > max && total>0 { print group; group=""; total=0 }
      { group=(group=="" ? path : group " " path); total+=size }
      END { if (group!="") print group }
    ')
    {
      echo "FROM registry.access.redhat.com/ubi9/ubi-minimal:latest"
      echo "$COPY_GROUPS" | while IFS= read -r line; do
        [ -n "$line" ] && echo "COPY $line /models/"
      done
      echo "WORKDIR /models"
      echo "LABEL org.opencontainers.image.title=\"Synesis ModelCar (NVFP4)\""
      echo "LABEL com.redhat.rhaiis.modelcar=\"true\""
      echo "ENV MODEL_PATH=/models"
    } > "$GENERATED_DF"
    CONTAINERFILE="$GENERATED_DF"
  fi
fi

/usr/local/bin/kaniko-executor \
  --single-snapshot \
  --no-push-cache \
  --compressed-caching=false \
  --snapshot-mode=redo \
  --ignore-path=/usr/bin/newuidmap \
  --ignore-path=/usr/bin/newgidmap \
  --dockerfile="$CONTAINERFILE" \
  --context="$CONTEXT" \
  --destination="$DEST" \
  --verbosity=info

echo "Pushed $DEST"
