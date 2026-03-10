#!/usr/bin/env bash
# Build and push model-pvc-download image to ECR.
# Used by manager/executor pipelines (download to PVC).
#   export ECR_URI="123456789012.dkr.ecr.us-east-1.amazonaws.com/synesis-models"
#   ./pipelines/model-pvc-download/build.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ECR_URI="${ECR_URI:?Set ECR_URI}"

IMAGE="${ECR_URI}:model-pvc-download"

cd "$REPO_ROOT"
podman build --platform linux/amd64 -f pipelines/model-pvc-download/Containerfile -t "$IMAGE" pipelines/model-pvc-download/
podman push "$IMAGE"
echo "Pushed $IMAGE"
