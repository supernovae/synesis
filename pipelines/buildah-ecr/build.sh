#!/usr/bin/env bash
# Build and push buildah-ecr image to ECR.
# Red Hat stack: Buildah + AWS CLI for ModelCar builds.
# Run from repo root. Requires ECR_URI.
#
#   export ECR_URI="123456789012.dkr.ecr.us-east-1.amazonaws.com/synesis-models"
#   ./pipelines/buildah-ecr/build.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ECR_URI="${ECR_URI:?Set ECR_URI, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/synesis-models}"

IMAGE="${ECR_URI}:buildah-ecr"

cd "$REPO_ROOT"
podman build --platform linux/amd64 -f pipelines/buildah-ecr/Containerfile -t "$IMAGE" pipelines/buildah-ecr/
podman push "$IMAGE"
echo "Pushed $IMAGE"
