#!/bin/sh
# ECR login + Kaniko for Manager ModelCar (download-from-HF during build).
# Args: MODEL_REPO MODEL_NAME ECR_URI IMAGE_TAG (or env: MODEL_REPO, MODEL_NAME, ECR_URI, IMAGE_TAG).
# Env: HF_TOKEN (optional), AWS_REGION.
# Context: baked-in modelcar-src (Dockerfile + download_model.py).
# IRSA provides AWS creds for ECR push.

set -e

# Accept positional args from KFP (ContainerSpec args); else use env
if [ $# -ge 4 ]; then
  export MODEL_REPO="$1"
  export MODEL_NAME="$2"
  export ECR_URI="$3"
  export IMAGE_TAG="$4"
fi

MODEL_REPO="${MODEL_REPO:?MODEL_REPO required}"
MODEL_NAME="${MODEL_NAME:-manager}"
ECR_URI="${ECR_URI:?ECR_URI required}"
IMAGE_TAG="${IMAGE_TAG:-manager}"
AWS_REGION="${AWS_REGION:-us-east-1}"
CONTEXT="${MODELCAR_CONTEXT:-/workspace/modelcar-src}"
DOCKERFILE="${CONTEXT}/Dockerfile"
DEST="${ECR_URI}:${IMAGE_TAG}"

# Use writable paths; pipeline pods may run as user with no write access to /workspace.
DOCKER_CFG="${DOCKER_CONFIG:-/tmp/.docker-kaniko}"
mkdir -p "$DOCKER_CFG"
export DOCKER_CONFIG="$DOCKER_CFG"

# Use /kaniko (created in image with chmod 777); do not override - Kaniko chowns custom dirs and fails in restricted pods.
REGISTRY="${ECR_URI%%/*}"
TOKEN=$(aws ecr get-login-password --region "$AWS_REGION")
cat > "$DOCKER_CFG/config.json" << EOF
{"auths":{"${REGISTRY}":{"username":"AWS","password":"${TOKEN}"}}}
EOF

# Kaniko with build-args for HF download stage
EXTRA_ARGS=""
[ -n "${HF_TOKEN:-}" ] && EXTRA_ARGS="${EXTRA_ARGS} --build-arg HF_TOKEN=${HF_TOKEN}"

# --single-snapshot: one snapshot at end, not per layer; reduces memory
# --no-push-cache: avoid cache layer memory overhead
# --ignore-path: skip files with security.capability xattr (UBI has newgidmap/newuidmap; lsetxattr fails in restricted pods)
/usr/local/bin/kaniko-executor \
  --single-snapshot \
  --no-push-cache \
  --compressed-caching=false \
  --snapshot-mode=redo \
  --ignore-path=/usr/bin/newuidmap \
  --ignore-path=/usr/bin/newgidmap \
  --dockerfile="$DOCKERFILE" \
  --context="dir://${CONTEXT}" \
  --build-arg "MODEL_REPO=${MODEL_REPO}" \
  --build-arg "MODEL_NAME=${MODEL_NAME}" \
  $EXTRA_ARGS \
  --destination="$DEST" \
  --verbosity=info

echo "Pushed $DEST"
