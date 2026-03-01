#!/usr/bin/env bash
# =============================================================================
# Mirror Synesis Models to Amazon ECR (ModelCar / OCI pattern)
# =============================================================================
#
# Pulls models from HuggingFace, builds OCI ModelCar images, pushes to ECR.
# Run from a jump host with: podman (or docker), aws cli, network access to HF + ECR.
#
# Prerequisites:
#   - AWS CLI configured (profile, env, or IRSA)
#   - Docker
#   - ECR repos exist: synesis-models (or per-model repos)
#   - HF_TOKEN for gated models (optional for public)
#
# Usage:
#   export ECR_REGISTRY=123456789012.dkr.ecr.us-east-1.amazonaws.com
#   export AWS_REGION=us-east-1
#   export HF_TOKEN=hf_xxx   # optional
#   ./scripts/mirror-models-to-ecr.sh
#
# Or with profile:
#   AWS_PROFILE=my-profile ./scripts/mirror-models-to-ecr.sh
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELCAR_DIR="$REPO_ROOT/base/model-serving/modelcar"

# --- Config (env override) ---
ECR_REGISTRY="${ECR_REGISTRY:-}"
AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPO_PREFIX="${ECR_REPO_PREFIX:-synesis-models}"
HF_TOKEN="${HF_TOKEN:-}"
BUILD_PLATFORM="${BUILD_PLATFORM:-linux/amd64}"

# Model definitions: role|hf_repo|image_tag
# Blackwell single-GPU: Executor=DeepSeek-R1-Distill-70B (FP8 fits 96GB); Manager=Qwen3.5-35B-A3B
# For NVFP4 efficiency: pre-quantize with llm-compressor (see docs/MODEL_SELECTION.md)
MODELS=(
  "executor|nm-testing/DeepSeek-R1-Distill-Llama-70B-FP8-Dynamic|executor"
  "manager|nightmedia/Qwen3.5-35B-A3B-Text|manager"
)

# Legacy: add supervisor/critic for non-Blackwell: "supervisor|RedHatAI/Qwen3-8B-FP8-dynamic|supervisor"

log() { echo "[$(date +%H:%M:%S)] $*"; }
err() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }

die() { err "$*"; exit 1; }

# --- Container CLI (podman or docker) ---
CONTAINER_CLI="${CONTAINER_CLI:-$(command -v podman 2>/dev/null || command -v docker 2>/dev/null || echo docker)}"

# --- ECR login ---
ecr_login() {
  if [[ -z "$ECR_REGISTRY" ]]; then
    die "ECR_REGISTRY required. Example: 123456789012.dkr.ecr.us-east-1.amazonaws.com"
  fi
  log "Logging into ECR (using $CONTAINER_CLI)..."
  aws ecr get-login-password --region "$AWS_REGION" | "$CONTAINER_CLI" login --username AWS --password-stdin "$ECR_REGISTRY" || die "ECR login failed"
}

# --- Ensure ECR repo exists ---
ensure_ecr_repo() {
  local repo_name="$1"
  if aws ecr describe-repositories --repository-names "$repo_name" --region "$AWS_REGION" &>/dev/null; then
    log "ECR repo $repo_name exists"
  else
    log "Creating ECR repo $repo_name"
    aws ecr create-repository --repository-name "$repo_name" --region "$AWS_REGION" --image-scanning-configuration scanOnPush=true
  fi
}

# --- Build and push a single model ---
build_and_push() {
  local role="$1"
  local hf_repo="$2"
  local tag="$3"
  local image="${ECR_REGISTRY}/${ECR_REPO_PREFIX}:${tag}"

  log "Building $role -> $image (from $hf_repo)"
  "$CONTAINER_CLI" build \
    --platform "$BUILD_PLATFORM" \
    -f "$MODELCAR_DIR/Dockerfile" \
    --build-arg "MODEL_REPO=$hf_repo" \
    --build-arg "MODEL_NAME=$role" \
    ${HF_TOKEN:+--build-arg "HF_TOKEN=$HF_TOKEN"} \
    -t "$image" \
    "$MODELCAR_DIR"

  log "Pushing $image"
  "$CONTAINER_CLI" push "$image"
}

# --- Main ---
main() {
  log "Synesis Model Mirror -> ECR"
  log "ECR_REGISTRY=$ECR_REGISTRY AWS_REGION=$AWS_REGION"

  [[ -d "$MODELCAR_DIR" ]] || die "ModelCar dir not found: $MODELCAR_DIR"
  [[ -f "$MODELCAR_DIR/Dockerfile" ]] || die "Dockerfile not found"

  ecr_login
  ensure_ecr_repo "$ECR_REPO_PREFIX"

  for entry in "${MODELS[@]}"; do
    IFS='|' read -r role hf_repo tag <<< "$entry"
    build_and_push "$role" "$hf_repo" "$tag"
  done

  log "Done. Images at ${ECR_REGISTRY}/${ECR_REPO_PREFIX}:<tag>"
}

main "$@"
