#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# load-bootstrap.sh — Authenticate to the Synesis admin API and upload all
# bootstrap corpus YAML files into the ingestion queue.
#
# Usage:
#   ./scripts/load-bootstrap.sh [OPTIONS]
#
# Options:
#   -u, --username   Admin username           (default: admin, or $SYNESIS_ADMIN_USER)
#   -p, --password   Admin password           (default: admin, or $SYNESIS_ADMIN_PASSWORD)
#   -t, --token      Bearer token             (or $SYNESIS_ADMIN_TOKEN — skips /auth/login)
#   -a, --admin-url  Admin service base URL   (default: $SYNESIS_ADMIN_URL or https://synesis-admin.apps.openshiftdemo.dev)
#   -d, --dir        Bootstrap corpus dir     (default: bootstrap/corpus)
#   -s, --status     Status override          (default: pending)
#   --dry-run        Print commands without executing
#   -h, --help       Show this help
#
# Keycloak: /api/v1/auth/login (username/password) is disabled. Use -t / SYNESIS_ADMIN_TOKEN with
#   a Personal Access Token from the admin UI (syn-...) or a Keycloak access_token for synesis-admin.
#   Uploads still use Authorization: Bearer — same as before; only how you obtain the token changes.
#
# Examples:
#   # Default (public route)
#   ./scripts/load-bootstrap.sh
#
#   # With explicit credentials: use straight SINGLE QUOTES '...' around the password
#   # (not backticks `...` — those run a command, not quoting — and not bare text with !)
#   ./scripts/load-bootstrap.sh -u admin -p 's3cret'
#   # Or use an env var (no shell interpolation in the value if you export carefully):
#   export SYNESIS_ADMIN_PASSWORD='your$Complex!Pass'
#   ./scripts/load-bootstrap.sh
#
#   # Keycloak / PAT (no local login on the admin API)
#   export SYNESIS_ADMIN_TOKEN='syn-...'   # created in Admin → Personal Access Tokens
#   ./scripts/load-bootstrap.sh
#
#   # Local development
#   ./scripts/load-bootstrap.sh -a http://localhost:8000
#
#   # In-cluster URL
#   ./scripts/load-bootstrap.sh -a http://synesis-admin.synesis-admin.svc:8000
#
#   # Only a specific file
#   echo bootstrap/corpus/code.yaml | ./scripts/load-bootstrap.sh --dir -
# ---------------------------------------------------------------------------

ADMIN_URL="${SYNESIS_ADMIN_URL:-https://synesis-admin.apps.openshiftdemo.dev}"
USERNAME="${SYNESIS_ADMIN_USER:-admin}"
PASSWORD="${SYNESIS_ADMIN_PASSWORD:-admin}"
# Pre-seed from env; -t/--token overrides when parsing (last flag wins if passed multiple times).
ADMIN_TOKEN="${SYNESIS_ADMIN_TOKEN:-}"
CORPUS_DIR="bootstrap/corpus"
STATUS_OVERRIDE="pending"
DRY_RUN=false

usage() {
  sed -n '/^# Usage:/,/^# ---/p' "$0" | sed 's/^# //' | head -n -1
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -u|--username)
      [[ $# -lt 2 ]] && { echo "ERROR: $1 requires a value (e.g. -u 'you@example.com')." >&2; exit 1; }
      USERNAME="$2"; shift 2 ;;
    -p|--password)
      [[ $# -lt 2 ]] && {
        echo "ERROR: -p requires a password value. Use single quotes, not backticks: -p 'your!pass'" >&2
        exit 1
      }
      PASSWORD="$2"; shift 2 ;;
    -t|--token)
      [[ $# -lt 2 ]] && { echo "ERROR: $1 requires a token value (use single quotes if needed)." >&2; exit 1; }
      ADMIN_TOKEN="$2"; shift 2 ;;
    -a|--admin-url)
      [[ $# -lt 2 ]] && { echo "ERROR: $1 requires a URL." >&2; exit 1; }
      ADMIN_URL="$2"; shift 2 ;;
    -d|--dir)
      [[ $# -lt 2 ]] && { echo "ERROR: $1 requires a directory path." >&2; exit 1; }
      CORPUS_DIR="$2"; shift 2 ;;
    -s|--status)
      [[ $# -lt 2 ]] && { echo "ERROR: $1 requires a status value." >&2; exit 1; }
      STATUS_OVERRIDE="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=true;         shift   ;;
    -h|--help)       usage ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

ADMIN_URL="${ADMIN_URL%/}"

# ---------------------------------------------------------------------------
# 1. Bearer token — supplied directly (Keycloak / PAT) or from legacy /auth/login
# Wrong password or bad URL exits here (exit 1) before any corpus uploads — one
# login attempt when using -u/-p, so we do not hammer bootstrap on bad creds.
# ---------------------------------------------------------------------------
if [[ -n "${ADMIN_TOKEN}" ]]; then
  TOKEN="${ADMIN_TOKEN}"
  echo "Using bearer token from -t / SYNESIS_ADMIN_TOKEN (skipping POST .../auth/login)."
else
  echo "Authenticating as '${USERNAME}' against ${ADMIN_URL} ..."

  # JSON-encode credentials so passwords with quotes, backslashes, or Unicode are safe.
  LOGIN_JSON=$(
    _LB_USER="$USERNAME" _LB_PASS="$PASSWORD" python3 -c '
import json, os
print(json.dumps({
    "username": os.environ["_LB_USER"],
    "password": os.environ["_LB_PASS"],
}))
'
  ) || { echo "ERROR: Could not build login JSON." >&2; exit 1; }

  TOKEN_RESPONSE=$(curl -sf -X POST "${ADMIN_URL}/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "${LOGIN_JSON}" 2>&1) || {
    echo "ERROR: Authentication failed. Check URL, username, and password." >&2
    echo "Response: ${TOKEN_RESPONSE}" >&2
    if echo "${TOKEN_RESPONSE}" | grep -qiE 'disabled|keycloak|sso|Local login'; then
      echo "" >&2
      echo "This admin API uses Keycloak: username/password login at /api/v1/auth/login is disabled." >&2
      echo "Use a Personal Access Token (Admin UI) or Keycloak access_token, e.g.:" >&2
      echo "  export SYNESIS_ADMIN_TOKEN='syn-...'" >&2
      echo "  $0 -a '${ADMIN_URL}'   # or: $0 -t 'syn-...'" >&2
    fi
    exit 1
  }

  TOKEN=$(echo "${TOKEN_RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null) || {
    echo "ERROR: Could not parse access_token from response." >&2
    echo "Response: ${TOKEN_RESPONSE}" >&2
    exit 1
  }

  echo "Authenticated. Token acquired (legacy login)."
fi

# ---------------------------------------------------------------------------
# 2. Discover corpus files
# ---------------------------------------------------------------------------
if [[ ! -d "${CORPUS_DIR}" ]]; then
  echo "ERROR: Corpus directory '${CORPUS_DIR}' not found." >&2
  echo "Run this script from the synesis repo root." >&2
  exit 1
fi

# Deterministic order (avoid filesystem-dependent glob order)
FILES=()
while IFS= read -r line; do
  [[ -n "$line" && -f "$line" ]] && FILES+=("$line")
done < <(find "${CORPUS_DIR}" -maxdepth 1 \( -name '*.yaml' -o -name '*.yml' \) -type f 2>/dev/null | LC_ALL=C sort)

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No YAML files found in ${CORPUS_DIR}."
  exit 0
fi

echo "Found ${#FILES[@]} bootstrap file(s) in ${CORPUS_DIR}:"
printf "  %s\n" "${FILES[@]}"
echo ""

# ---------------------------------------------------------------------------
# 3. Upload each file via the bootstrap endpoint
# ---------------------------------------------------------------------------
TOTAL_ADDED=0
TOTAL_SKIPPED=0
FAILED_FILES=()

for f in "${FILES[@]}"; do
  fname=$(basename "$f")

  if $DRY_RUN; then
    echo "[DRY RUN] Would upload: $f"
    continue
  fi

  printf "Uploading %-40s ... " "$fname"

  RESP=$(curl -sf -X POST \
    "${ADMIN_URL}/api/v1/ingestion/bootstrap?status_override=${STATUS_OVERRIDE}" \
    -F "file=@${f}" \
    -H "Authorization: Bearer ${TOKEN}" 2>&1) || {
    echo "FAILED"
    FAILED_FILES+=("$f")
    echo "  Error: ${RESP}" >&2
    continue
  }

  ADDED=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('added',0))" 2>/dev/null || echo "?")
  SKIPPED=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('skipped',0))" 2>/dev/null || echo "?")

  echo "added=${ADDED}  skipped=${SKIPPED}"
  TOTAL_ADDED=$((TOTAL_ADDED + ${ADDED:-0}))
  TOTAL_SKIPPED=$((TOTAL_SKIPPED + ${SKIPPED:-0}))
done

# ---------------------------------------------------------------------------
# 4. Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================="
echo "  Bootstrap Load Summary"
echo "========================================="
echo "  Files processed:  ${#FILES[@]}"
echo "  Items added:      ${TOTAL_ADDED}"
echo "  Items skipped:    ${TOTAL_SKIPPED} (already in queue)"

if [[ ${#FAILED_FILES[@]} -gt 0 ]]; then
  echo "  Files FAILED:     ${#FAILED_FILES[@]}"
  printf "    - %s\n" "${FAILED_FILES[@]}"
fi

echo ""
echo "Items are now 'pending' in the ingestion queue."
echo "Run the indexer to process them:"
echo "  ./scripts/deploy-indexer.sh --run"
echo ""
echo "Or check queue status:"
echo "  curl -s -H 'Authorization: Bearer ${TOKEN}' ${ADMIN_URL}/api/v1/ingestion/stats | python3 -m json.tool"
