#!/usr/bin/env bash
# =============================================================================
# Sync current AWS credentials to aws-ecr-credentials secret in-cluster.
# The pipeline runs IN the cluster and uses this secret — your laptop STS/SSO
# token is never used unless you run this script after 'aws sso login' (or similar).
#
# Usage:
#   aws sso login
#   eval $(aws configure export-credentials --format env)
#   export DS_PROJECT=synesis
#   ./scripts/sync-ecr-credentials.sh
#
# For long-lived builds: use IAM user keys (AKIA...), not SSO — SSO tokens expire.
# =============================================================================

set -euo pipefail

DS_PROJECT="${DS_PROJECT:-}"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -n "$DS_PROJECT" ]] || die "Set DS_PROJECT (e.g. export DS_PROJECT=synesis)"

# Resolve credentials from env or AWS config
export AWS_REGION="${AWS_REGION:-us-east-1}"

# Ensure we have creds (aws sts get-caller-identity will fail if not)
if ! aws sts get-caller-identity &>/dev/null; then
  die "No valid AWS credentials. Run 'aws sso login' or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY."
fi

# SSO/session tokens expire — warn if we detect them
if [[ -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
  # Could be long-term (AKIA...) or session (ASIA...)
  if [[ "$AWS_ACCESS_KEY_ID" == ASIA* ]]; then
    echo "Note: Using session credentials (ASIA...). These expire — sync again after re-auth."
  fi
fi

# Export creds into env if not set (works for SSO after aws sso login)
if [[ -z "${AWS_ACCESS_KEY_ID:-}" ]] && command -v aws &>/dev/null; then
  eval "$(aws configure export-credentials --format env 2>/dev/null)" || true
fi

if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  die "No creds. Run: aws sso login && eval \$(aws configure export-credentials --format env)"
fi

echo "Syncing aws-ecr-credentials to namespace $DS_PROJECT..."

# Base secret (required)
oc create secret generic aws-ecr-credentials -n "$DS_PROJECT" \
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  --dry-run=client -o yaml | oc apply -f -

# Session token (optional; for SSO/assumed-role) — pipeline mounts separately
if [[ -n "${AWS_SESSION_TOKEN:-}" ]]; then
  oc create secret generic aws-ecr-session-token -n "$DS_PROJECT" \
    --from-literal=AWS_SESSION_TOKEN="$AWS_SESSION_TOKEN" \
    --dry-run=client -o yaml | oc apply -f -
  echo "Also created aws-ecr-session-token (SSO). Re-sync after 'aws sso login' when it expires."
else
  oc delete secret aws-ecr-session-token -n "$DS_PROJECT" 2>/dev/null || true
fi

echo "Done. Pipeline uses these credentials for ECR push (not your laptop)."
