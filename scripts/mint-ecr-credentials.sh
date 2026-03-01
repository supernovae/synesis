#!/usr/bin/env bash
# =============================================================================
# Mint fresh AWS credentials and push to cluster for pipeline ECR build.
#
# Use when your existing secret has expired (SSO/temporary creds). Mints new
# credentials and updates aws-ecr-credentials in-cluster so the pipeline can
# push to ECR immediately.
#
# Usage:
#   export DS_PROJECT=synesis
#
#   # Option A: Assume role (max 12h) — good for CI/service accounts
#   export ROLE_ARN=arn:aws:iam::660250927410:role/your-ecr-push-role
#   ./scripts/mint-ecr-credentials.sh
#
#   # Option B: Use current SSO — run after aws sso login
#   aws sso login
#   ./scripts/mint-ecr-credentials.sh
#
# IAM user keys (AKIA...) don't expire — use those for long-lived; no minting.
# =============================================================================

set -euo pipefail

DS_PROJECT="${DS_PROJECT:-}"
ROLE_ARN="${ROLE_ARN:-}"
ROLE_SESSION_NAME="${ROLE_SESSION_NAME:-ecr-pipeline-$(date +%s)}"
DURATION_SECONDS="${DURATION_SECONDS:-43200}"   # 12h max for assume-role

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -n "$DS_PROJECT" ]] || die "Set DS_PROJECT (e.g. export DS_PROJECT=synesis)"
export AWS_REGION="${AWS_REGION:-us-east-1}"

echo "Minting fresh credentials..."

if [[ -n "$ROLE_ARN" ]]; then
  # Assume role with max duration (12h)
  CREDS=$(aws sts assume-role \
    --role-arn "$ROLE_ARN" \
    --role-session-name "$ROLE_SESSION_NAME" \
    --duration-seconds "$DURATION_SECONDS" \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' \
    --output text 2>/dev/null) || die "Assume role failed. Check ROLE_ARN and trust policy."

  AWS_ACCESS_KEY_ID=$(echo "$CREDS" | awk '{print $1}')
  AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | awk '{print $2}')
  AWS_SESSION_TOKEN=$(echo "$CREDS" | awk '{print $3}')
  echo "Assumed role $ROLE_ARN (valid ~12h)"
else
  # Use current profile (SSO or static)
  if [[ -z "${AWS_ACCESS_KEY_ID:-}" ]] && command -v aws &>/dev/null; then
    eval "$(aws configure export-credentials --format env 2>/dev/null)" || true
  fi
  if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
    die "No creds. Run: aws sso login && eval \$(aws configure export-credentials --format env)"
  fi
  echo "Using current profile (SSO or IAM)"
fi

# Verify we can call STS
AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-}" aws sts get-caller-identity --query 'Arn' --output text

echo "Updating secrets in namespace $DS_PROJECT..."

oc create secret generic aws-ecr-credentials -n "$DS_PROJECT" \
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  --dry-run=client -o yaml | oc apply -f -

if [[ -n "${AWS_SESSION_TOKEN:-}" ]]; then
  oc create secret generic aws-ecr-session-token -n "$DS_PROJECT" \
    --from-literal=AWS_SESSION_TOKEN="$AWS_SESSION_TOKEN" \
    --dry-run=client -o yaml | oc apply -f -
  echo "Created aws-ecr-session-token (expires with credentials)"
else
  oc delete secret aws-ecr-session-token -n "$DS_PROJECT" 2>/dev/null || true
fi

echo "Done. Run your pipeline now."
