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
#   -t, --token      Bearer token (required unless SYNESIS_ADMIN_TOKEN is set)
#   -a, --admin-url  Admin service base URL   (default: $SYNESIS_ADMIN_URL or https://synesis-admin.apps.openshiftdemo.dev)
#   -d, --dir        Bootstrap corpus dir     (default: bootstrap/corpus)
#   -s, --status     Status override          (default: pending)
#   --upsert         Pass upsert=true: update existing rows by uri; requeue if handler/config changed
#   --dry-run        Print commands without executing
#   -h, --help       Show this help
#
# Authentication: POST /api/v1/auth/login (username/password) was removed from the admin API.
# Use a Personal Access Token (syn-...) from Admin → Personal Access Tokens, or a Keycloak
# access_token for the synesis-admin client. See docs/admin/KEYCLOAK_BOOTSTRAP.md
#
# Examples:
#   export SYNESIS_ADMIN_TOKEN='syn-...'
#   ./scripts/load-bootstrap.sh
#
#   ./scripts/load-bootstrap.sh -t 'syn-...' -a http://localhost:8000
#
#   # In-cluster URL
#   ./scripts/load-bootstrap.sh -a http://synesis-admin.synesis-admin.svc:8080
#
#   # Only a specific file
#   echo bootstrap/corpus/code.yaml | ./scripts/load-bootstrap.sh --dir -
# ---------------------------------------------------------------------------

ADMIN_URL="${SYNESIS_ADMIN_URL:-https://synesis-admin.apps.openshiftdemo.dev}"
ADMIN_TOKEN="${SYNESIS_ADMIN_TOKEN:-}"
CORPUS_DIR="bootstrap/corpus"
STATUS_OVERRIDE="pending"
UPSERT=false
DRY_RUN=false

usage() {
  sed -n '/^# Usage:/,/^# ---/p' "$0" | sed 's/^# //' | head -n -1
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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
    --upsert)        UPSERT=true;          shift   ;;
    --dry-run)       DRY_RUN=true;         shift   ;;
    -h|--help)       usage ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

ADMIN_URL="${ADMIN_URL%/}"

# ---------------------------------------------------------------------------
# 1. Bearer token (PAT syn-... or Keycloak access_token)
# ---------------------------------------------------------------------------
if [[ -z "${ADMIN_TOKEN}" ]]; then
  echo "ERROR: SYNESIS_ADMIN_TOKEN or -t/--token is required." >&2
  echo "The admin API no longer provides POST /api/v1/auth/login (username/password)." >&2
  echo "Use a Personal Access Token from the admin UI or a Keycloak token. See docs/admin/KEYCLOAK_BOOTSTRAP.md" >&2
  exit 1
fi
TOKEN="${ADMIN_TOKEN}"
echo "Using bearer token from -t / SYNESIS_ADMIN_TOKEN."

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

  BOOTSTRAP_URL="${ADMIN_URL}/api/v1/ingestion/bootstrap?status_override=${STATUS_OVERRIDE}"
  $UPSERT && BOOTSTRAP_URL="${BOOTSTRAP_URL}&upsert=true"

  RESP=$(curl -sf -X POST \
    "${BOOTSTRAP_URL}" \
    -F "file=@${f}" \
    -H "Authorization: Bearer ${TOKEN}" 2>&1) || {
    echo "FAILED"
    FAILED_FILES+=("$f")
    echo "  Error: ${RESP}" >&2
    continue
  }

  ADDED=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('added',0))" 2>/dev/null || echo "?")
  SKIPPED=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('skipped',0))" 2>/dev/null || echo "?")

  if $UPSERT; then
    EX=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('requeued',0),d.get('unchanged',0),d.get('updated_meta',0))" 2>/dev/null || echo "? ? ?")
    echo "added=${ADDED}  skipped=${SKIPPED}  requeued=$(echo "$EX" | awk '{print $1}')  unchanged=$(echo "$EX" | awk '{print $2}')  meta=$(echo "$EX" | awk '{print $3}')"
  else
    echo "added=${ADDED}  skipped=${SKIPPED}"
  fi
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
