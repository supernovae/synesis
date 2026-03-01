#!/usr/bin/env bash
# Build and push kaniko-ecr image to ECR.
# Run from repo root. Requires ECR_URI.
#
#   export ECR_URI="123456789012.dkr.ecr.us-east-1.amazonaws.com/synesis-models"
#   ./pipelines/kaniko-ecr/build.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ECR_URI="${ECR_URI:?Set ECR_URI, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/synesis-models}"

# Same repo, tag kaniko-ecr (e.g. byron-ai-registry:kaniko-ecr)
IMAGE="${ECR_URI}:kaniko-ecr"

cd "$REPO_ROOT"
# Use linux/amd64 so image runs on x86_64 OpenShift/ROSA nodes (Apple Silicon builds arm64 by default).
podman build --platform linux/amd64 -f pipelines/kaniko-ecr/Containerfile -t "$IMAGE" pipelines/kaniko-ecr/
podman push "$IMAGE"
echo "Pushed $IMAGE"
