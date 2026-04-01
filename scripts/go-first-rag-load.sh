#!/usr/bin/env bash
set -euo pipefail

# Go-first RAG ingestion runner.
# Phase order:
#   1) preflight
#   2) enqueue Go corpus
#   3) run queue job + watch
#   4) optional retrieval validation
#
# Required:
# - oc login to the target cluster
# - SYNESIS_ADMIN_TOKEN with org_admin + tenant content grants
#
# Optional:
# - SYNESIS_ADMIN_URL (default: https://synesis-admin.apps.openshiftdemo.dev)
# - SYNESIS_YARN_URL  (default: https://synesis-yarn.apps.openshiftdemo.dev)
# - SYNESIS_TEST_AUTH for yarn retrieval checks

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_CORPUS_FILE="${ROOT_DIR}/bootstrap/corpus/lang-go.yaml"
ADMIN_URL="${SYNESIS_ADMIN_URL:-https://synesis-admin.apps.openshiftdemo.dev}"
YARN_URL="${SYNESIS_YARN_URL:-https://synesis-yarn.apps.openshiftdemo.dev}"
ADMIN_TOKEN="${SYNESIS_ADMIN_TOKEN:-}"
SYNESIS_TEST_AUTH="${SYNESIS_TEST_AUTH:-}"
RUN_RETRIEVAL_CHECKS="${RUN_RETRIEVAL_CHECKS:-true}"

RAG_NS="${RAG_NS:-synesis-rag}"
ADMIN_NS="${ADMIN_NS:-synesis-admin}"
YARN_NS="${YARN_NS:-synesis-yarn}"
QUEUE_CRONJOB="${QUEUE_CRONJOB:-synesis-indexer-queue}"

function require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: Missing required command: $1" >&2
    exit 1
  }
}

function log() {
  printf "[go-first] %s\n" "$*"
}

function phase_header() {
  printf "\n========== %s ==========\n" "$*"
}

function check_http_ok() {
  local code="$1"
  local msg="$2"
  if [[ "$code" != "200" ]]; then
    echo "ERROR: ${msg} (HTTP ${code})" >&2
    exit 1
  fi
}

require_cmd oc
require_cmd curl
require_cmd python3

phase_header "Phase 1: preflight"
log "Checking OpenShift identity"
oc whoami >/dev/null
oc project >/dev/null

log "Checking required namespaces"
oc get ns "${RAG_NS}" "${ADMIN_NS}" "${YARN_NS}" >/dev/null

log "Validating Go corpus YAML"
python3 "${ROOT_DIR}/scripts/validate-bootstrap-corpus.py" "${GO_CORPUS_FILE}" >/dev/null

if [[ -z "${ADMIN_TOKEN}" ]]; then
  echo "ERROR: SYNESIS_ADMIN_TOKEN is required for bootstrap enqueue." >&2
  echo "Hint: create PAT in Admin UI with org_admin + tenant content grants." >&2
  exit 1
fi

log "Validating admin token permissions via ingestion stats"
stats_code="$(curl -sS -o /tmp/go-first-stats.json -w '%{http_code}' \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  "${ADMIN_URL%/}/api/v1/ingestion/stats")"
if [[ "${stats_code}" != "200" ]]; then
  echo "ERROR: admin token cannot read ingestion stats (HTTP ${stats_code})." >&2
  echo "Response:" >&2
  python3 - <<'PY'
from pathlib import Path
resp = Path("/tmp/go-first-stats.json")
print(resp.read_text() if resp.exists() else "(no body)")
PY
  exit 1
fi

phase_header "Phase 2: enqueue Go-only corpus"
bootstrap_code="$(curl -sS -o /tmp/go-first-bootstrap.json -w '%{http_code}' \
  -X POST "${ADMIN_URL%/}/api/v1/ingestion/bootstrap?status_override=pending&upsert=false" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -F "file=@${GO_CORPUS_FILE}")"
if [[ "${bootstrap_code}" != "200" ]]; then
  echo "ERROR: Go bootstrap enqueue failed (HTTP ${bootstrap_code})" >&2
  python3 - <<'PY'
from pathlib import Path
resp = Path("/tmp/go-first-bootstrap.json")
print(resp.read_text() if resp.exists() else "(no body)")
PY
  echo "Hint: default lang-go bootstrap entries are global visibility; global writes require a platform_admin PAT." >&2
  exit 1
fi

python3 - <<'PY'
import json
from pathlib import Path
data = json.loads(Path("/tmp/go-first-bootstrap.json").read_text())
print(f"enqueue_result added={data.get('added', 0)} skipped={data.get('skipped', 0)}")
PY

phase_header "Phase 2b: run queue job and monitor"
ts="$(date +%s)"
job_name="go-first-queue-${ts}"
log "Creating one-shot job from cronjob/${QUEUE_CRONJOB}: ${job_name}"
oc -n "${RAG_NS}" create job --from=cronjob/"${QUEUE_CRONJOB}" "${job_name}" >/dev/null

log "Waiting for job to complete (timeout 45m)"
if ! oc -n "${RAG_NS}" wait --for=condition=complete --timeout=45m "job/${job_name}" >/dev/null; then
  log "Job did not reach complete; dumping job/pod status"
  oc -n "${RAG_NS}" get job "${job_name}" -o wide || true
  oc -n "${RAG_NS}" get pods -l "job-name=${job_name}" -o wide || true
  exit 1
fi

log "Queue job complete. Last 200 log lines:"
oc -n "${RAG_NS}" logs "job/${job_name}" --tail=200 || true

log "Reading ingestion stats after run"
post_code="$(curl -sS -o /tmp/go-first-post-stats.json -w '%{http_code}' \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  "${ADMIN_URL%/}/api/v1/ingestion/stats")"
check_http_ok "${post_code}" "post-run ingestion stats request failed"

python3 - <<'PY'
import json
from pathlib import Path
d = json.loads(Path("/tmp/go-first-post-stats.json").read_text())
fields = ["pending","running","indexed","failed","dead_letter","staged_raw","staged_norm","enrich_queued","total_chunks"]
print("post_run_stats " + " ".join(f"{k}={d.get(k)}" for k in fields))
PY

phase_header "Phase 3: retrieval hit validation (optional)"
if [[ "${RUN_RETRIEVAL_CHECKS}" != "true" ]]; then
  log "RUN_RETRIEVAL_CHECKS=false; skipping retrieval checks"
  exit 0
fi

if [[ -z "${SYNESIS_TEST_AUTH}" ]]; then
  log "SYNESIS_TEST_AUTH is not set; skipping retrieval checks"
  exit 0
fi

if ! oc -n "${YARN_NS}" get deploy synesis-yarn >/dev/null 2>&1; then
  log "synesis-yarn deployment not found; skipping retrieval checks"
  exit 0
fi

ready="$(oc -n "${YARN_NS}" get deploy synesis-yarn -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
if [[ -z "${ready}" || "${ready}" == "0" ]]; then
  log "synesis-yarn has no ready replicas; skipping retrieval checks"
  exit 0
fi

log "Running basic Go retrieval probe"
probe_code="$(curl -sS -o /tmp/go-first-yarn-probe.json -w '%{http_code}' \
  -X POST "${YARN_URL%/}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SYNESIS_TEST_AUTH}" \
  -d '{"model":"synesis-auto","messages":[{"role":"user","content":"In Go, does map iteration order have guaranteed stability? Answer in 2-3 sentences and include source links if available."}],"temperature":0.1}')"

if [[ "${probe_code}" != "200" ]]; then
  log "Yarn probe failed (HTTP ${probe_code}); see /tmp/go-first-yarn-probe.json"
  exit 0
fi

python3 - <<'PY'
import json
from pathlib import Path
d = json.loads(Path("/tmp/go-first-yarn-probe.json").read_text())
text = d.get("choices", [{}])[0].get("message", {}).get("content", "")
print("yarn_probe_response:")
print(text[:1200])
PY

log "Go-first run completed."
