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
#   -a, --admin-url  Admin service base URL   (default: $SYNESIS_ADMIN_URL or https://synesis-admin.apps.openshiftdemo.dev)
#   -d, --dir        Bootstrap corpus dir     (default: bootstrap/corpus)
#   -s, --status     Status override          (default: pending)
#   --dry-run        Print commands without executing
#   -h, --help       Show this help
#
# Examples:
#   # Default (public route)
#   ./scripts/load-bootstrap.sh
#
#   # With explicit credentials
#   ./scripts/load-bootstrap.sh -u admin -p s3cret
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
CORPUS_DIR="bootstrap/corpus"
STATUS_OVERRIDE="pending"
DRY_RUN=false

usage() {
  sed -n '/^# Usage:/,/^# ---/p' "$0" | sed 's/^# //' | head -n -1
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -u|--username)   USERNAME="$2";        shift 2 ;;
    -p|--password)   PASSWORD="$2";        shift 2 ;;
    -a|--admin-url)  ADMIN_URL="$2";       shift 2 ;;
    -d|--dir)        CORPUS_DIR="$2";      shift 2 ;;
    -s|--status)     STATUS_OVERRIDE="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=true;         shift   ;;
    -h|--help)       usage ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

ADMIN_URL="${ADMIN_URL%/}"

# ---------------------------------------------------------------------------
# 1. Authenticate — get a JWT token
# ---------------------------------------------------------------------------
echo "Authenticating as '${USERNAME}' against ${ADMIN_URL} ..."

TOKEN_RESPONSE=$(curl -sf -X POST "${ADMIN_URL}/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\": \"${USERNAME}\", \"password\": \"${PASSWORD}\"}" 2>&1) || {
  echo "ERROR: Authentication failed. Check URL, username, and password." >&2
  echo "Response: ${TOKEN_RESPONSE}" >&2
  exit 1
}

TOKEN=$(echo "${TOKEN_RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null) || {
  echo "ERROR: Could not parse access_token from response." >&2
  echo "Response: ${TOKEN_RESPONSE}" >&2
  exit 1
}

echo "Authenticated. Token acquired."

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
