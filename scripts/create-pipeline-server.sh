#!/usr/bin/env bash
# =============================================================================
# Create Data Science Pipeline Server (DSPA) with S3 bucket — no UI keys needed
# =============================================================================
#
# Uses IRSA: pipeline SA gets S3 access via IAM role. No access key/secret.
# Ensure your bucket policy allows the pipeline SA's IRSA role.
#
# Usage:
#   export DS_PROJECT=your-data-science-project
#   export S3_BUCKET=byron-ai-d8a35264-rhoai-data
#   export AWS_REGION=us-east-1
#
#   ./scripts/create-pipeline-server.sh
#
# With static keys (if IRSA not set up):
#   export USE_S3_CREDENTIALS=true
#   export AWS_ACCESS_KEY_ID=...
#   export AWS_SECRET_ACCESS_KEY=...
#   ./scripts/create-pipeline-server.sh
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DSPA_DIR="$REPO_ROOT/base/model-serving/pipeline-server"

DS_PROJECT="${DS_PROJECT:-}"
S3_BUCKET="${S3_BUCKET:-byron-ai-d8a35264-rhoai-data}"
S3_HOST="${S3_HOST:-s3.us-east-1.amazonaws.com}"
AWS_REGION="${AWS_REGION:-us-east-1}"
DSPA_NAME="${DSPA_NAME:-default-pipeline-server}"
USE_S3_CREDENTIALS="${USE_S3_CREDENTIALS:-false}"
S3_CREDENTIALS_SECRET="${S3_CREDENTIALS_SECRET:-aws-s3-creds}"

log() { echo "[$(date +%H:%M:%S)] $*"; }
err() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }
die() { err "$*"; exit 1; }

main() {
  [[ -n "$DS_PROJECT" ]] || die "DS_PROJECT required (your Data Science Project namespace)"
  [[ -n "$S3_BUCKET" ]] || die "S3_BUCKET required (e.g. byron-ai-d8a35264-rhoai-data)"
  [[ -f "$DSPA_DIR/dspa-s3.yaml" ]] || die "DSPA template not found: $DSPA_DIR/dspa-s3.yaml"

  log "Creating pipeline server in $DS_PROJECT with bucket $S3_BUCKET (IRSA)"

  # envsubst needs plain vars; no ${VAR:-default} in template
  export DS_PROJECT S3_BUCKET S3_HOST AWS_REGION DSPA_NAME S3_CREDENTIALS_SECRET

  if [[ "$USE_S3_CREDENTIALS" == "true" ]]; then
    [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]] || \
      die "USE_S3_CREDENTIALS=true requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
    log "Creating S3 credentials secret $S3_CREDENTIALS_SECRET"
    oc create secret generic "$S3_CREDENTIALS_SECRET" -n "$DS_PROJECT" \
      --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
      --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
      --dry-run=client -o yaml | oc apply -f -
    envsubst < "$DSPA_DIR/dspa-s3-with-credentials.yaml" | oc apply -f -
  else
    envsubst < "$DSPA_DIR/dspa-s3.yaml" | oc apply -f -
  fi

  log "Done. Pipeline server will provision. Check status: oc get dspa -n $DS_PROJECT"
}

main "$@"
