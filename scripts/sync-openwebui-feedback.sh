#!/usr/bin/env bash
# Sync feedback from Open WebUI API to Synesis.
#
# Open WebUI stores feedback via its own API. This script polls that API,
# filters by model (synesis-agent), and POSTs to Synesis /v1/feedback.
#
# Prerequisites:
#   - OPENWEBUI_URL (e.g. https://your-openwebui.example.com)
#   - OPENWEBUI_API_KEY (from Settings > Account)
#   - SYNESIS_PLANNER_URL (e.g. http://synesis-planner:8000)
#
# Note: Open WebUI API paths/structure may differ. Check Swagger at
#   ${OPENWEBUI_URL}/docs or ${OPENWEBUI_URL}/api/v1/docs
# run_id must be preserved (e.g. in message metadata) when proxying to Synesis.
#
# Usage: ./sync-openwebui-feedback.sh
#
# For cron: 0 * * * * /path/to/sync-openwebui-feedback.sh >> /var/log/synesis-feedback-sync.log 2>&1

set -e

: "${OPENWEBUI_URL:?Set OPENWEBUI_URL}"
: "${OPENWEBUI_API_KEY:?Set OPENWEBUI_API_KEY}"
: "${SYNESIS_PLANNER_URL:?Set SYNESIS_PLANNER_URL}"

# Open WebUI feedback API - adjust path per your Open WebUI version
FEEDBACK_URL="${OPENWEBUI_URL}/api/v1/messages"
PLANNER_FEEDBACK="${SYNESIS_PLANNER_URL}/v1/feedback"

echo "Fetching feedback from ${FEEDBACK_URL}..."
resp=$(curl -s -H "Authorization: Bearer ${OPENWEBUI_API_KEY}" "${FEEDBACK_URL}" 2>/dev/null || echo "{}")

# Parse and filter - adapt jq to actual Open WebUI response structure
echo "$resp" | jq -r '.data[]? | select(.model == "synesis-agent") | "\(.id)|\(.rating // 0)|\(.metadata.run_id // .run_id // "")"' 2>/dev/null | while IFS='|' read -r msg_id rating run_id; do
  [[ -z "$msg_id" ]] && continue
  vote="down"
  [[ "$rating" == "1" || "$rating" == 1 ]] && vote="up"
  if [[ -z "$run_id" ]]; then
    echo "Skip $msg_id: no run_id (proxy must pass run_id in metadata)" >&2
    continue
  fi
  curl -s -X POST -H "Content-Type: application/json" \
    -d "{\"message_id\": \"$msg_id\", \"run_id\": \"$run_id\", \"vote\": \"$vote\"}" \
    "${PLANNER_FEEDBACK}"
  echo "Synced $msg_id -> $vote"
done
