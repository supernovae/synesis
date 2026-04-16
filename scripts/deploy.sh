#!/usr/bin/env bash
set -euo pipefail

# Synesis Deployment Script
#
# Applies Kustomize overlays to the cluster.
# Auto-generates a LiteLLM API key if one doesn't exist.
# Prunes stale ReplicaSets and keeps revision history short for idempotent deploys.
#
# Usage: ./scripts/deploy.sh <mode> [ref]
#   mode: api   — external LLM providers (OpenRouter, Groq, etc.), no GPUs
#         model — self-hosted GPU inference via vLLM (requires RHOAI)
#   ref:  (optional) Image tag to deploy. Default: latest.
#         Use "latest", a branch (main, feature/foo), a tag (v1.0.0), or PR (pr-123).
#   env:  SYNESIS_LITELLM_STATIC_FALLBACK=true (api mode only)
#         Force static LiteLLM role mappings from overlays/api/litellm-config-openrouter-static-fallback.yaml
#         instead of Prisma-backed dynamic registry sync.
#   env:  SYNESIS_FORCE_LITELLM_HELM=true (api mode only)
#         Always run `helm upgrade --install` for LiteLLM even when values files are unchanged.
#         Default: skip Helm when the values fingerprint matches the last successful deploy.
#   env:  SYNESIS_YARN_FULL_FEATURES=true
#         Enable ALL gated Yarn feature flags (Phases 7–19) at once.
#         Overrides per-flag defaults so every implemented capability is active for testing.
#         Individual flags (e.g. SYNESIS_YARN_PATTERN_RECALL_ENABLED=false) still take precedence.
#
# Yarn (IDE path) and the MCP-TS agent deploy with both api and model overlays
# (namespaces synesis-yarn). Images: ghcr.io/.../yarn-ts, .../mcp-ts (coder MCP).
# Admin MCP (synesis-admin-mcp-ts) deploys with base/admin (synesis-admin namespace).
#
# Yarn → Admin DB (sessions, usage, PAT lookup):
#   - Secret synesis-admin-db-url in synesis-yarn (keys admin-url, trace-url), same as admin/planner.
#   - ensure_admin_db + patch_admin_db_urls create/update it from CNPG synesis-admin-db-app.
#   - synesis-yarn is rollout-restarted after each DB URL patch so pods load SYNESIS_YARN_ADMIN_DB_URL.
#   - SYNESIS_YARN_PERSIST_USAGE_TO_DB=true (default in base/yarn-ts/deployment.yaml) required for
#     yarn_sessions / yarn_usage_log rows to appear in Admin → Yarn.
#   - Optional: SYNESIS_PAT_PEPPER on yarn-ts must match admin when using HMAC PAT hashing.
#
# Admin → Chat Feedback (Open WebUI evaluation sync):
#   - synesis-admin calls Open WebUI GET /api/v1/evaluations/feedbacks/all/export (see docs/FEEDBACK_API.md).
#   - Default SYNESIS_OPENWEBUI_URL in base/admin/deployment.yaml points at the in-cluster Service
#     (open-webui.synesis-webui.svc.cluster.local:8080). Override only if WebUI is reached by a different URL.
#   - Bearer token (NOT webui-api-key): admin → Open WebUI /api/v1/evaluations/* credentials only.
#     deploy.sh syncs webui-api-key for Open WebUI → planner chat; it does NOT mint OWUI admin API tokens.
#     Use an admin session JWT (from browser) or an Open WebUI–issued PAT if your version accepts it on export.
#     Export SYNESIS_OPENWEBUI_ADMIN_TOKEN before deploy to create/update Secret synesis-openwebui-admin-token
#     (key: token) in synesis-admin; otherwise create that secret manually or sync returns 400 until configured.
#   - Post-apply: synesis-admin is rollout-restarted when the secret was created/updated this run or
#     SYNESIS_OPENWEBUI_ADMIN_TOKEN is set (so optional envFrom picks up the token).
#   - Trace correlation: deploy the Synesis-built Open WebUI image (middleware patch), not stock upstream only:
#       ./scripts/build-images.sh --only open-webui --push
#     Overlays replace ghcr.io/open-webui/open-webui with ghcr.io/.../synesis/open-webui.
#
# Yarn tool call collapsing (docs/YARN_TOOL_COLLAPSE.md):
#   - SYNESIS_YARN_TOOL_COLLAPSE_ENABLED (default true via deploy.sh patch) — exposes POST /v1/coder/tool-collapse/plan.
#   - SYNESIS_YARN_TOOL_COLLAPSE_REWRITE_NON_STREAM (default false) — rewrite non-stream completions to synesis_* tools;
#     requires client support + x-synesis-workspace-root + x-synesis-tool-collapse: apply.
#   - SYNESIS_YARN_TOOL_COLLAPSE_DEBOUNCE_MS, SYNESIS_YARN_TOOL_COLLAPSE_SHELL_ALLOWLIST (optional override).
#   - SYNESIS_YARN_DEDUPE_ENABLED (default true), SYNESIS_YARN_DEDUPE_CACHE_MAX, SYNESIS_YARN_DEDUPE_MAX_SEARCH_QUERY_CHARS.
#   - SYNESIS_YARN_TOOL_PREFIX_CACHE_ENABLED (default true), MAX_ENTRIES, MAX_ENTRY_BYTES.
#   - SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE (default true via deploy.sh patch) — strict file path clamp to project_root/shell_cwd anchor.
#   - SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED (default true via deploy.sh patch) — block risky mkdir/cd duplicate-segment drift.
#   - SYNESIS_YARN_RESPONSE_STYLE_MODE (default guidance) and SYNESIS_YARN_RESPONSE_STYLE_ALLOW_MERMAID (default true) — stylized markdown response guidance.
#   - Workspace handshake disabled in strict fix-forward mode; clients must send project_root/shell_cwd anchors.
#
# Yarn token optimization (M10 + transcript pruning):
#   - SYNESIS_YARN_STABLE_PREFIX_ENABLED (default true) — stable system prompt prefix for provider cache hits.
#   - SYNESIS_YARN_JSON_COMPACTION_ENABLED (default true) — compact JSON in tool results.
#   - SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED (default true) — attention-aware message positioning.
#   - SYNESIS_YARN_SORTED_TOOLS_ENABLED (default true) — deterministic tool ordering for cache.
#   - SYNESIS_YARN_TRANSCRIPT_PRUNE_ENABLED (default true) — evict stale tool results, dedup file reads, condense old assistant turns.
#   - SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TURNS (default 5), BUDGET_CHARS (120000), STUB_MAX_CHARS (400), ASSISTANT_CONDENSE_CHARS (2000).
#   - SYNESIS_YARN_REQUEST_FORENSICS_ENABLED (default true via deploy.sh patch) — provider-boundary request forensics (LCP/first-change/breakdown).
#   - SYNESIS_YARN_REQUEST_FORENSICS_CAPTURE_PAYLOAD (default false) and MAX_PREVIEW_CHARS (default 4000) — optional payload preview capture.
#   - SYNESIS_YARN_PHASE_EXECUTION_POLICY_ENABLED (default false) — enable phase-aware tool_choice/tool filtering.
#   - SYNESIS_YARN_PHASE_EXECUTION_POLICY_FAMILIES (default qwen3-coder) — comma-separated model families for phase policy.
#
# Yarn Eval Gym (docs/coder/EVAL_GYM.md):
#   - SYNESIS_YARN_EVAL_API_ENABLED (default true) — exposes /v1/eval/* routes (scenario runner, results, export).
#   - SYNESIS_YARN_EVAL_OBSERVER_ENABLED (default true via deploy.sh) — session observer records eval_transcript_v1
#     and live_eval_v1 events for anomaly detection and training data export.
#   - CLI: npm run eval (scenarios), npm run eval:regression, npm run eval:e2e, npm run eval:export.
#   - Training data: POST /v1/eval/export (sft/dpo/rlaif JSONL); admin dataset_type=eval_gym for feedback loop.
#
# Planner-ts — RAG + SearXNG + Admin web_search_log (post-apply patch, survives manifest drift):
#   Default: SYNESIS_DEPLOY_PLANNER_RETRIEVAL=true (or unset) — patches synesis-planner-ts with:
#     SYNESIS_EMBEDDER_URL, SYNESIS_MILVUS_HOST, SYNESIS_MILVUS_PORT,
#     SYNESIS_WEB_SEARCH_ENABLED, SYNESIS_WEB_SEARCH_URL (in-cluster TEI, Milvus, SearXNG).
#   web_search_log rows require Secret synesis-admin-db-url (admin-url) in synesis-planner —
#     created by patch_admin_db_urls when CNPG synesis-admin-db-app password is ready (same as Yarn/admin).
#   Disable unified retrieval + web for planner: SYNESIS_DEPLOY_PLANNER_RETRIEVAL=false
#     (clears embedder URL and disables web search; router uses NullRetrievalClient).
#   Override service URLs if your cluster DNS differs:
#     SYNESIS_PLANNER_EMBEDDER_URL, SYNESIS_PLANNER_MILVUS_HOST, SYNESIS_PLANNER_MILVUS_PORT,
#     SYNESIS_PLANNER_SEARXNG_URL, SYNESIS_PLANNER_WEB_SEARCH_ENABLED (default true when retrieval on).
#
# Examples:
#   ./scripts/deploy.sh api                     # default — API providers, latest images
#   ./scripts/deploy.sh api v1.2.0              # API providers, release tag
#   ./scripts/deploy.sh model                   # self-hosted GPU inference
#   SYNESIS_REF=pr-456 ./scripts/deploy.sh api  # deploy PR branch images
#
# Optional staged ingestion (S3): after the bucket + IRSA exist, pass the bucket to the indexer deploy:
#   ./scripts/deploy-indexer.sh --s3-bucket your-bucket-name

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

PYTHON="${PROJECT_ROOT}/.venv/bin/python3"
[[ -x "$PYTHON" ]] || PYTHON="python3"

MODE="${1:-}"
REF="${2:-${SYNESIS_REF:-latest}}"

# Reject old overlay names with a clear migration message
if [[ "$MODE" =~ ^(dev|dev-services|staging|prod|openrouter)$ ]]; then
    echo "ERROR: '$MODE' is no longer a valid mode."
    echo ""
    echo "The overlay structure has been simplified to two modes:"
    echo "  api   — external LLM providers (OpenRouter, etc.), no GPU hardware"
    echo "  model — self-hosted GPU inference via vLLM"
    echo ""
    echo "Environment-specific tuning (log levels, replicas, model profiles)"
    echo "is now managed post-deploy via the Admin UI or kubectl."
    echo ""
    echo "Usage: $0 <api|model> [ref]"
    exit 1
fi

if [[ -z "$MODE" ]] || [[ ! "$MODE" =~ ^(api|model)$ ]]; then
    echo "Usage: $0 <api|model> [ref]"
    echo "  api:   external LLM providers (OpenRouter, etc.), no GPU hardware"
    echo "  model: self-hosted GPU inference via vLLM"
    echo "  ref:   optional image tag (default: latest). e.g. main, v1.0.0, pr-123"
    exit 1
fi

# Normalize ref for image tag (no leading/trailing slash; safe for sed)
REF_SAFE="${REF//\//-}"

is_true() {
    local v
    v="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
    [[ "$v" =~ ^(1|true|yes|on)$ ]]
}

LITELLM_STATIC_FALLBACK=false
if is_true "${SYNESIS_LITELLM_STATIC_FALLBACK:-false}"; then
    LITELLM_STATIC_FALLBACK=true
fi

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

OVERLAY_DIR="$PROJECT_ROOT/overlays/$MODE"

if [[ ! -d "$OVERLAY_DIR" ]]; then
    log "ERROR: Overlay directory not found: $OVERLAY_DIR"
    exit 1
fi

# -----------------------------------------------------------------------
# Ensure a LiteLLM API key exists in the cluster secret.
# If the secret doesn't exist or still has the placeholder value,
# generate a real key and create/update the secret.
# -----------------------------------------------------------------------
ensure_litellm_key() {
    local ns="synesis-gateway"
    local secret_name="litellm-secrets"
    local existing_key="" existing_salt=""

    oc create namespace "$ns" 2>/dev/null || true

    if oc get secret "$secret_name" -n "$ns" &>/dev/null; then
        existing_key=$(oc get secret "$secret_name" -n "$ns" \
            -o jsonpath='{.data.master-key}' 2>/dev/null | base64 -d 2>/dev/null || true)
        existing_salt=$(oc get secret "$secret_name" -n "$ns" \
            -o jsonpath='{.data.salt-key}' 2>/dev/null | base64 -d 2>/dev/null || true)
    fi

    local need_update="false"

    if [[ -z "$existing_key" ]] || [[ "$existing_key" == "sk-synesis-change-me" ]]; then
        LITELLM_KEY="sk-synesis-$(openssl rand -hex 24)"
        log "Generating LiteLLM API key..."
        need_update="true"
    else
        LITELLM_KEY="$existing_key"
        log "LiteLLM API key already exists in $ns/$secret_name"
    fi

    if [[ -z "$existing_salt" ]]; then
        LITELLM_SALT="sk-salt-$(openssl rand -hex 32)"
        log "Generating LiteLLM salt key..."
        need_update="true"
    else
        LITELLM_SALT="$existing_salt"
    fi

    if [[ "$need_update" == "true" ]]; then
        oc create secret generic "$secret_name" \
            -n "$ns" \
            --from-literal=master-key="$LITELLM_KEY" \
            --from-literal=salt-key="$LITELLM_SALT" \
            --dry-run=client -o yaml | oc apply -f -
        log "  Keys stored in secret $ns/$secret_name"
    fi
}

ensure_webui_key() {
    local webui_ns="synesis-webui"
    oc create namespace "$webui_ns" 2>/dev/null || true

    log "Syncing API key to Open WebUI namespace..."
    oc create secret generic webui-api-key \
        -n "$webui_ns" \
        --from-literal=api-key="$LITELLM_KEY" \
        --dry-run=client -o yaml | oc apply -f -
    log "  Key synced to $webui_ns/webui-api-key"
}

ensure_admin_litellm_key() {
    local admin_ns="synesis-admin"
    oc create namespace "$admin_ns" 2>/dev/null || true

    log "Syncing LiteLLM master key to admin namespace..."
    oc create secret generic litellm-secrets \
        -n "$admin_ns" \
        --from-literal=master-key="$LITELLM_KEY" \
        --dry-run=client -o yaml | oc apply -f -
    log "  Key synced to $admin_ns/litellm-secrets"
}

ensure_planner_litellm_key() {
    local planner_ns="synesis-planner"
    oc create namespace "$planner_ns" 2>/dev/null || true

    log "Syncing LiteLLM master key to planner namespace..."
    oc create secret generic litellm-secrets \
        -n "$planner_ns" \
        --from-literal=master-key="$LITELLM_KEY" \
        --dry-run=client -o yaml | oc apply -f -
    log "  Key synced to $planner_ns/litellm-secrets"
}

# -----------------------------------------------------------------------
# Open WebUI admin token for synesis-admin Chat Feedback sync
# (POST /api/v1/feedback/sync-openwebui → OWUI evaluations export).
# Idempotent: only overwrites when SYNESIS_OPENWEBUI_ADMIN_TOKEN is non-empty this run.
# -----------------------------------------------------------------------
ensure_openwebui_feedback_sync_secret() {
    local admin_ns="synesis-admin"
    local secret_name="synesis-openwebui-admin-token"
    local key_name="token"

    oc create namespace "$admin_ns" 2>/dev/null || true

    if [[ -n "${SYNESIS_OPENWEBUI_ADMIN_TOKEN:-}" ]]; then
        log "Syncing Open WebUI admin token to $admin_ns/$secret_name (Chat Feedback → Sync from Open WebUI)..."
        oc create secret generic "$secret_name" \
            -n "$admin_ns" \
            --from-literal="$key_name=$SYNESIS_OPENWEBUI_ADMIN_TOKEN" \
            --dry-run=client -o yaml | oc apply -f -
        log "  Secret $secret_name applied (Bearer for OWUI /api/v1/evaluations/*)"
    else
        if oc get secret "$secret_name" -n "$admin_ns" &>/dev/null; then
            log "Chat Feedback: $admin_ns/$secret_name present (sync can authenticate to Open WebUI)"
        else
            log "NOTE: Chat Feedback — export not configured until Secret $secret_name exists."
            log "  Set SYNESIS_OPENWEBUI_ADMIN_TOKEN when running deploy.sh, or:"
            log "  oc create secret generic $secret_name -n $admin_ns --from-literal=$key_name='<Open WebUI admin JWT>'"
            log "  Docs: docs/FEEDBACK_API.md"
        fi
    fi
}

# Uses _openwebui_secret_rv_before / _openwebui_secret_rv_after (set around ensure_openwebui_feedback_sync_secret).
post_apply_restart_synesis_admin_openwebui_feedback() {
    local admin_ns="synesis-admin"
    local secret_name="synesis-openwebui-admin-token"
    local prior="${_openwebui_secret_rv_before:-}"
    local post="${_openwebui_secret_rv_after:-}"
    local want_restart=false

    if [[ -n "${SYNESIS_OPENWEBUI_ADMIN_TOKEN:-}" ]]; then
        want_restart=true
    elif [[ -n "$post" && "$prior" != "$post" ]]; then
        want_restart=true
    fi

    if [[ "$want_restart" != true ]]; then
        return 0
    fi
    if ! oc get deployment synesis-admin -n "$admin_ns" &>/dev/null; then
        return 0
    fi
    log "Restarting synesis-admin to pick up $secret_name (Chat Feedback sync)..."
    oc rollout restart deployment/synesis-admin -n "$admin_ns" 2>/dev/null || true
}

# -----------------------------------------------------------------------
# Internal service auth token (defense in depth for control-plane APIs).
# Idempotent: reuse existing token if present in any managed namespace,
# otherwise generate and sync to all.
# -----------------------------------------------------------------------
ensure_internal_service_auth() {
    local secret_name="synesis-internal-service-auth"
    local key_name="token"
    local existing=""
    local ns
    local namespaces=(synesis-admin synesis-rag synesis-planner synesis-yarn synesis-gateway synesis-webui synesis-sandbox synesis-validation)

    for ns in "${namespaces[@]}"; do
        oc create namespace "$ns" 2>/dev/null || true
    done

    for ns in "${namespaces[@]}"; do
        if oc get secret "$secret_name" -n "$ns" &>/dev/null; then
            existing=$(oc get secret "$secret_name" -n "$ns" \
                -o jsonpath="{.data.${key_name}}" 2>/dev/null | base64 -d 2>/dev/null || true)
            existing=$(printf '%s' "$existing" | tr -d '\n\r')
            if [[ -n "$existing" ]]; then
                break
            fi
        fi
    done

    if [[ -z "$existing" ]]; then
        existing="synesis-internal-$(openssl rand -hex 32)"
        log "Generating internal service auth token..."
    else
        log "Internal service auth token already exists (syncing namespaces)"
    fi

    INTERNAL_SERVICE_TOKEN="$existing"
    for ns in "${namespaces[@]}"; do
        oc create secret generic "$secret_name" \
            -n "$ns" \
            --from-literal="$key_name=$INTERNAL_SERVICE_TOKEN" \
            --dry-run=client -o yaml | oc apply -f - >/dev/null
    done
    log "  Internal service auth secret synced to: ${namespaces[*]}"
}

# -----------------------------------------------------------------------
# Yarn (synesis-yarn): clone gateway secrets so envFrom provider-api-keys
# resolves in the Yarn namespace (OpenRouter API key, etc.).
# -----------------------------------------------------------------------
ensure_yarn_secrets_from_gateway() {
    local gw="synesis-gateway"
    local yn="synesis-yarn"

    oc create namespace "$yn" 2>/dev/null || true

    _yarn_clone_secret() {
        local sname="$1"
        if ! oc get secret "$sname" -n "$gw" &>/dev/null; then
            return 0
        fi
        log "  Cloning secret $gw/$sname -> $yn/$sname"
        SRC_NS="$gw" DEST_NS="$yn" SNAME="$sname" "$PYTHON" -c '
import json, os, subprocess

gw = os.environ["SRC_NS"]
yn = os.environ["DEST_NS"]
name = os.environ["SNAME"]
raw = subprocess.check_output(["oc", "get", "secret", name, "-n", gw, "-o", "json"])
d = json.loads(raw)
d.pop("status", None)
d["metadata"] = {"name": name, "namespace": yn}
subprocess.run(["oc", "apply", "-f", "-"], input=json.dumps(d).encode(), check=True)
'
    }

    _yarn_clone_secret provider-api-keys
    _yarn_clone_secret litellm-secrets
}

# -----------------------------------------------------------------------
# Optional Cloudflare Tunnel deployment (cloudflared).
# Enabled with SYNESIS_ENABLE_CLOUDFLARED=true.
# Idempotent: reconciles secret + configmap + deployment.
# -----------------------------------------------------------------------
ensure_cloudflared_tunnel() {
    if ! is_true "${SYNESIS_ENABLE_CLOUDFLARED:-false}"; then
        return 0
    fi

    local ns="synesis-edge"
    local kustomize_dir="$PROJECT_ROOT/base/edge/cloudflared"
    local secret_name="cloudflared-credentials"
    local configmap_name="cloudflared-config"
    local deploy_name="cloudflared"
    local tunnel_name="${SYNESIS_CF_TUNNEL_NAME:-synesis}"
    local tunnel_token="${SYNESIS_CF_TUNNEL_TOKEN:-}"
    local creds_file="${SYNESIS_CF_TUNNEL_CREDENTIALS_FILE:-}"
    local creds_json="${SYNESIS_CF_TUNNEL_CREDENTIALS_JSON:-}"
    local use_token="false"
    local existing_token=""
    local existing_creds=""

    if [[ ! -d "$kustomize_dir" ]]; then
        log "WARNING: cloudflared base not found at $kustomize_dir"
        return 1
    fi

    oc create namespace "$ns" 2>/dev/null || true

    existing_token="$(oc get secret "$secret_name" -n "$ns" -o jsonpath='{.data.token}' 2>/dev/null || true)"
    existing_creds="$(oc get secret "$secret_name" -n "$ns" -o jsonpath='{.data.credentials\.json}' 2>/dev/null || true)"

    # Credentials/token secret
    if [[ -n "$tunnel_token" ]]; then
        use_token="true"
        log "Reconciling cloudflared token from SYNESIS_CF_TUNNEL_TOKEN..."
        oc create secret generic "$secret_name" \
            -n "$ns" \
            --from-literal=token="$tunnel_token" \
            --dry-run=client -o yaml | oc apply -f -
    elif [[ -n "$creds_json" ]]; then
        log "Reconciling cloudflared credentials from SYNESIS_CF_TUNNEL_CREDENTIALS_JSON..."
        oc create secret generic "$secret_name" \
            -n "$ns" \
            --from-literal=credentials.json="$creds_json" \
            --dry-run=client -o yaml | oc apply -f -
    elif [[ -n "$creds_file" ]]; then
        if [[ -f "$creds_file" ]]; then
            log "Reconciling cloudflared credentials from file: $creds_file"
            oc create secret generic "$secret_name" \
                -n "$ns" \
                --from-file=credentials.json="$creds_file" \
                --dry-run=client -o yaml | oc apply -f -
        else
            log "WARNING: SYNESIS_CF_TUNNEL_CREDENTIALS_FILE not found: $creds_file"
            return 1
        fi
    elif [[ -n "$existing_token" ]]; then
        use_token="true"
        log "Using existing cloudflared token secret: $ns/$secret_name"
    elif [[ -n "$existing_creds" ]]; then
        log "Using existing cloudflared credentials secret: $ns/$secret_name"
    elif ! oc get secret "$secret_name" -n "$ns" &>/dev/null; then
        log "WARNING: cloudflared token/credentials missing."
        log "  Set one of:"
        log "    SYNESIS_CF_TUNNEL_TOKEN=<cloudflare-zero-trust-token>"
        log "    SYNESIS_CF_TUNNEL_CREDENTIALS_JSON='{\"AccountTag\":\"...\",\"TunnelSecret\":\"...\",\"TunnelID\":\"...\"}'"
        log "    SYNESIS_CF_TUNNEL_CREDENTIALS_FILE=/path/to/credentials.json"
        log "  Or pre-create secret: $ns/$secret_name"
        return 1
    else
        log "WARNING: existing $ns/$secret_name has no token or credentials.json key"
        log "  Expected one of secret keys: token, credentials.json"
        return 1
    fi

    local api_host admin_host chat_host auth_host coder_host
    api_host="${SYNESIS_CF_API_HOST:-$(oc get route synesis-api -n synesis-gateway -o jsonpath='{.spec.host}' 2>/dev/null || true)}"
    admin_host="${SYNESIS_CF_ADMIN_HOST:-$(oc get route synesis-admin -n synesis-admin -o jsonpath='{.spec.host}' 2>/dev/null || true)}"
    chat_host="${SYNESIS_CF_CHAT_HOST:-$(oc get route synesis-webui -n synesis-webui -o jsonpath='{.spec.host}' 2>/dev/null || true)}"
    auth_host="${SYNESIS_CF_AUTH_HOST:-$(oc get route synesis-auth -n synesis-auth -o jsonpath='{.spec.host}' 2>/dev/null || true)}"
    coder_host="${SYNESIS_CF_CODER_HOST:-$(oc get route synesis-yarn -n synesis-yarn -o jsonpath='{.spec.host}' 2>/dev/null || true)}"

    api_host="${api_host:-synesis-api.apps.openshiftdemo.dev}"
    admin_host="${admin_host:-synesis-admin.apps.openshiftdemo.dev}"
    chat_host="${chat_host:-synesis.apps.openshiftdemo.dev}"
    auth_host="${auth_host:-synesis-auth.apps.openshiftdemo.dev}"
    coder_host="${coder_host:-synesis-yarn.apps.openshiftdemo.dev}"

    local cfg_tmp
    cfg_tmp="$(mktemp)"
    local creds_line=""
    if [[ "$use_token" != "true" ]]; then
        creds_line="credentials-file: /etc/cloudflared/credentials/credentials.json"
    fi
    cat > "$cfg_tmp" <<EOF
tunnel: ${tunnel_name}
${creds_line}
ingress:
  - hostname: ${api_host}
    service: http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080
  - hostname: ${admin_host}
    service: http://synesis-admin.synesis-admin.svc.cluster.local:8080
  - hostname: ${chat_host}
    service: http://open-webui.synesis-webui.svc.cluster.local:8080
  - hostname: ${auth_host}
    service: http://synesis-keycloak-service.synesis-auth.svc.cluster.local:8080
  - hostname: ${coder_host}
    service: http://synesis-yarn.synesis-yarn.svc.cluster.local:8000
  - service: http_status:404
EOF

    oc create configmap "$configmap_name" \
        -n "$ns" \
        --from-file=config.yaml="$cfg_tmp" \
        --dry-run=client -o yaml | oc apply -f -
    rm -f "$cfg_tmp"

    oc apply -k "$kustomize_dir"

    # Roll cloudflared only when config/secret changed.
    local cfg_hash sec_hash
    cfg_hash=$(oc get configmap "$configmap_name" -n "$ns" -o jsonpath='{.data}' 2>/dev/null | (md5sum 2>/dev/null || md5) | cut -c1-8)
    sec_hash=$(oc get secret "$secret_name" -n "$ns" -o jsonpath='{.data}' 2>/dev/null | (md5sum 2>/dev/null || md5) | cut -c1-8)
    if [[ -n "$cfg_hash" && -n "$sec_hash" ]]; then
        oc patch deployment "$deploy_name" -n "$ns" \
            -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"synesis/configmap-hash\":\"$cfg_hash\",\"synesis/secret-hash\":\"$sec_hash\"}}}}}" \
            --type=merge >/dev/null 2>&1 || true
    fi

    log "cloudflared tunnel reconciled:"
    log "  API:   $api_host"
    log "  Admin: $admin_host"
    log "  Chat:  $chat_host"
    log "  Auth:  $auth_host"
    log "  Coder: $coder_host"
    if [[ "$use_token" == "true" ]]; then
        log "  Auth mode: token (SYNESIS_CF_TUNNEL_TOKEN)"
    else
        log "  Auth mode: credentials.json"
    fi
}

verify_cloudflared_tunnel() {
    if ! is_true "${SYNESIS_VERIFY_CLOUDFLARED:-false}"; then
        return 0
    fi
    local verifier="$PROJECT_ROOT/scripts/verify-cloudflared.sh"
    if [[ ! -x "$verifier" ]]; then
        log "WARNING: cloudflared verifier not found or not executable: $verifier"
        return 1
    fi

    log "Running cloudflared verification..."
    if "$verifier" --check-hosts; then
        log "cloudflared verification passed"
        return 0
    fi
    log "WARNING: cloudflared verification failed"
    return 1
}

# -----------------------------------------------------------------------
# Provider API keys: prompt for OpenRouter key interactively or read from
# OPENROUTER_API_KEY.  Writes to the unified provider-api-keys secret in
# synesis-gateway.  Additional provider keys can be managed via Admin UI
# (Settings > Provider Keys) after deployment.
# -----------------------------------------------------------------------
ensure_openrouter_key() {
    local ns="synesis-gateway"
    local secret_name="provider-api-keys"
    local existing_key=""

    oc create namespace "$ns" 2>/dev/null || true

    if oc get secret "$secret_name" -n "$ns" &>/dev/null; then
        existing_key=$(oc get secret "$secret_name" -n "$ns" \
            -o jsonpath='{.data.OPENROUTER_API_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)
    fi

    if [[ -n "$existing_key" ]] && [[ "$existing_key" != "sk-or-v1-REPLACE_ME" ]]; then
        log "OpenRouter API key already exists in $ns/$secret_name"
        log "  To rotate: manage keys via Admin UI (Settings > Provider Keys)"
        log "  Or re-run: oc patch secret $secret_name -n $ns -p '{\"data\":{\"OPENROUTER_API_KEY\":\"'\"$(echo -n NEW_KEY | base64)\"'\"}}'"
        return
    fi

    local api_key="${OPENROUTER_API_KEY:-}"

    if [[ -z "$api_key" ]]; then
        log ""
        log "OpenRouter API key required."
        log "  Get one at: https://openrouter.ai/keys"
        log ""
        if [[ -t 0 ]]; then
            read -rsp "  Enter your OpenRouter API key: " api_key
            echo ""
        else
            log "ERROR: No TTY — set OPENROUTER_API_KEY env var and re-run."
            exit 1
        fi
    fi

    if [[ -z "$api_key" ]]; then
        log "ERROR: No API key provided."
        exit 1
    fi

    if [[ ! "$api_key" =~ ^sk-or- ]]; then
        log "WARNING: Key does not start with 'sk-or-'. OpenRouter keys usually do."
        log "  Continuing anyway — verify at https://openrouter.ai/keys if requests fail."
    fi

    oc create secret generic "$secret_name" \
        -n "$ns" \
        --from-literal=OPENROUTER_API_KEY="$api_key" \
        --dry-run=client -o yaml | oc apply -f -

    log "OpenRouter API key stored in $ns/$secret_name (OPENROUTER_API_KEY)"
    log "  Add more provider keys via Admin UI (Settings > Provider Keys)"
}

# After manifest apply: heal OPENROUTER_API_KEY if the secret was wiped.
# (Older releases applied an empty provider-api-keys Secret via kustomize.)
# When envFrom used optional:true and the Secret was created after the pod
# started, the pod never receives OPENROUTER_API_KEY until recreated — OpenRouter
# then returns 401 and LiteLLM surfaces "No deployments available" / cooldown.
reconcile_provider_api_keys() {
    [[ "$MODE" != "api" ]] && return 0
    local ns="synesis-gateway"
    local secret_name="provider-api-keys"
    local key=""

    if oc get secret "$secret_name" -n "$ns" &>/dev/null; then
        key=$(oc get secret "$secret_name" -n "$ns" \
            -o jsonpath='{.data.OPENROUTER_API_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)
    fi
    # Trim whitespace / newlines from decoded value
    key=$(printf '%s' "$key" | tr -d '\n\r')

    if [[ -z "$key" ]] || [[ "$key" == "sk-or-v1-REPLACE_ME" ]]; then
        log ""
        log "OPENROUTER_API_KEY missing in $ns/$secret_name — LiteLLM will return 401 from OpenRouter."
        log "  Re-running provider key setup..."
        ensure_openrouter_key

        if oc get deployment litellm-proxy -n "$ns" &>/dev/null; then
            log "  Restarting litellm-proxy to reload envFrom..."
            oc rollout restart deployment/litellm-proxy -n "$ns" 2>/dev/null || true
        fi
        return 0
    fi

    # Valid key in cluster — ensure running pods actually have OPENROUTER_API_KEY
    # (stale pods from optional envFrom + late Secret).
    if oc get deployment litellm-proxy -n "$ns" &>/dev/null; then
        local pod
        pod=$(oc get pod -n "$ns" -l app.kubernetes.io/name=litellm-proxy \
            -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
        if [[ -n "$pod" ]]; then
            if ! oc exec -n "$ns" "$pod" -- sh -c 'test -n "${OPENROUTER_API_KEY:-}"' 2>/dev/null; then
                log ""
                log "litellm-proxy pod missing OPENROUTER_API_KEY (stale envFrom) — restarting..."
                oc rollout restart deployment/litellm-proxy -n "$ns" 2>/dev/null || true
            fi
        fi
    fi
}

# Heal litellm-secrets / webui-api-key if an older release applied placeholder
# Secrets from kustomize (now removed) and clobbered real keys.
reconcile_litellm_webui_secrets() {
    local gw="synesis-gateway"
    local wu="synesis-webui"
    local ad="synesis-admin"
    local pl="synesis-planner"
    local mk="" wk="" ak="" pk="" changed="false"

    oc create namespace "$gw" 2>/dev/null || true
    oc create namespace "$wu" 2>/dev/null || true
    oc create namespace "$ad" 2>/dev/null || true
    oc create namespace "$pl" 2>/dev/null || true

    if oc get secret litellm-secrets -n "$gw" &>/dev/null; then
        mk=$(oc get secret litellm-secrets -n "$gw" \
            -o jsonpath='{.data.master-key}' 2>/dev/null | base64 -d 2>/dev/null || true)
    fi
    mk=$(printf '%s' "$mk" | tr -d '\n\r')

    if oc get secret webui-api-key -n "$wu" &>/dev/null; then
        wk=$(oc get secret webui-api-key -n "$wu" \
            -o jsonpath='{.data.api-key}' 2>/dev/null | base64 -d 2>/dev/null || true)
    fi
    wk=$(printf '%s' "$wk" | tr -d '\n\r')

    if oc get secret litellm-secrets -n "$ad" &>/dev/null; then
        ak=$(oc get secret litellm-secrets -n "$ad" \
            -o jsonpath='{.data.master-key}' 2>/dev/null | base64 -d 2>/dev/null || true)
    fi
    ak=$(printf '%s' "$ak" | tr -d '\n\r')

    if oc get secret litellm-secrets -n "$pl" &>/dev/null; then
        pk=$(oc get secret litellm-secrets -n "$pl" \
            -o jsonpath='{.data.master-key}' 2>/dev/null | base64 -d 2>/dev/null || true)
    fi
    pk=$(printf '%s' "$pk" | tr -d '\n\r')

    if [[ -n "$mk" ]] && [[ "$mk" != "sk-synesis-change-me" ]]; then
        if [[ "$wk" != "$mk" ]] || [[ -z "$wk" ]] || [[ "$wk" == "sk-synesis-change-me" ]]; then
            oc create secret generic webui-api-key \
                -n "$wu" \
                --from-literal=api-key="$mk" \
                --dry-run=client -o yaml | oc apply -f -
            log "  Synced webui-api-key from litellm-secrets (was missing or out of date)"
            changed="true"
        fi
        if [[ "$ak" != "$mk" ]] || [[ -z "$ak" ]] || [[ "$ak" == "sk-synesis-change-me" ]]; then
            oc create secret generic litellm-secrets \
                -n "$ad" \
                --from-literal=master-key="$mk" \
                --dry-run=client -o yaml | oc apply -f -
            log "  Synced synesis-admin/litellm-secrets from gateway master key"
            changed="true"
        fi
        if [[ "$pk" != "$mk" ]] || [[ -z "$pk" ]] || [[ "$pk" == "sk-synesis-change-me" ]]; then
            oc create secret generic litellm-secrets \
                -n "$pl" \
                --from-literal=master-key="$mk" \
                --dry-run=client -o yaml | oc apply -f -
            log "  Synced synesis-planner/litellm-secrets from gateway master key"
            changed="true"
        fi
    elif [[ -n "$wk" ]] && [[ "$wk" != "sk-synesis-change-me" ]]; then
        oc create secret generic litellm-secrets \
            -n "$gw" \
            --from-literal=master-key="$wk" \
            --dry-run=client -o yaml | oc apply -f -
        log "  Restored litellm-secrets from existing webui-api-key"
        oc create secret generic litellm-secrets \
            -n "$ad" \
            --from-literal=master-key="$wk" \
            --dry-run=client -o yaml | oc apply -f -
        log "  Restored synesis-admin/litellm-secrets from existing webui-api-key"
        oc create secret generic litellm-secrets \
            -n "$pl" \
            --from-literal=master-key="$wk" \
            --dry-run=client -o yaml | oc apply -f -
        log "  Restored synesis-planner/litellm-secrets from existing webui-api-key"
    else
        local newk
        newk="sk-synesis-$(openssl rand -hex 24)"
        oc create secret generic litellm-secrets \
            -n "$gw" \
            --from-literal=master-key="$newk" \
            --dry-run=client -o yaml | oc apply -f -
        oc create secret generic webui-api-key \
            -n "$wu" \
            --from-literal=api-key="$newk" \
            --dry-run=client -o yaml | oc apply -f -
        oc create secret generic litellm-secrets \
            -n "$ad" \
            --from-literal=master-key="$newk" \
            --dry-run=client -o yaml | oc apply -f -
        oc create secret generic litellm-secrets \
            -n "$pl" \
            --from-literal=master-key="$newk" \
            --dry-run=client -o yaml | oc apply -f -
        log "  Generated new shared litellm/webui client key (both secrets were missing or placeholders)"
        changed="true"
    fi

    # Refresh for any later deploy.sh steps that reference LITELLM_KEY
    mk=$(oc get secret litellm-secrets -n "$gw" -o jsonpath='{.data.master-key}' 2>/dev/null | base64 -d 2>/dev/null || true)
    LITELLM_KEY=$(printf '%s' "$mk" | tr -d '\n\r')

    if [[ "$changed" == "true" ]] && oc get deployment open-webui -n "$wu" &>/dev/null; then
        log "  Restarting open-webui to pick up api-key / WEBUI_SECRET_KEY..."
        oc rollout restart deployment/open-webui -n "$wu" 2>/dev/null || true
    fi
    if [[ "$changed" == "true" ]] && oc get deployment synesis-admin -n "$ad" &>/dev/null; then
        log "  Restarting synesis-admin to pick up SYNESIS_LITELLM_MASTER_KEY..."
        oc rollout restart deployment/synesis-admin -n "$ad" 2>/dev/null || true
    fi
    if [[ "$changed" == "true" ]] && oc get deployment synesis-planner -n "$pl" &>/dev/null; then
        log "  Restarting synesis-planner to pick up SYNESIS_MODEL_API_KEY..."
        oc rollout restart deployment/synesis-planner -n "$pl" 2>/dev/null || true
    fi
}

# Deprecated: LiteLLM config mode is now managed by Helm (deploy_litellm_helm).
# Kept for reference only; not called.
apply_litellm_config_mode() {
    log "WARNING: apply_litellm_config_mode is deprecated — use deploy_litellm_helm"
    return 0
}


# -----------------------------------------------------------------------
# Admin Postgres: ensure CloudNativePG Cluster exists, read the operator-
# generated password, and patch admin + planner deployments with the real
# DATABASE_URL.  Idempotent — only patches when the password changes.
# -----------------------------------------------------------------------
ensure_admin_db() {
    local ns="synesis-admin"
    local cluster_name="synesis-admin-db"
    local secret_name="${cluster_name}-app"
    local db_name="synesis_admin"
    local db_user="app"
    local cluster_manifest="$PROJECT_ROOT/base/postgres/cluster.yaml"

    oc create namespace "$ns" 2>/dev/null || true

    # Check that the CloudNativePG CRD is installed
    if ! oc get crd clusters.postgresql.cnpg.io &>/dev/null; then
        log "WARNING: CloudNativePG CRD not found — install the operator first."
        log "  OpenShift: OperatorHub → CloudNativePG (community)"
        log "  Helm:      helm repo add cnpg https://cloudnative-pg.github.io/charts"
        log "             helm install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace"
        log "  Skipping admin DB setup. The admin will use the default (dev) connection string."
        return
    fi

    # Apply the Cluster CR (idempotent)
    if [[ -f "$cluster_manifest" ]]; then
        oc apply -f "$cluster_manifest"
        log "  Cluster CR applied: $ns/$cluster_name"
    else
        log "WARNING: Cluster manifest not found: $cluster_manifest"
        return
    fi

    # Wait for the cluster to become Ready (up to 3 min)
    log "  Waiting for Postgres cluster to become Ready..."
    local ready="false"
    for _ in $(seq 1 36); do
        local phase
        phase=$(oc get cluster "$cluster_name" -n "$ns" \
            -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
        if [[ "$phase" == "Cluster in healthy state" ]]; then
            ready="true"
            break
        fi
        sleep 5
    done

    if [[ "$ready" != "true" ]]; then
        log "WARNING: Postgres cluster not ready after 3 min."
        log "  Check: oc get cluster $cluster_name -n $ns -o yaml"
        log "  Continuing with placeholder credentials — update manually if needed."
        return
    fi
    log "  Postgres cluster is healthy"

    # Read the operator-generated password
    local pg_pass=""
    if oc get secret "$secret_name" -n "$ns" &>/dev/null; then
        pg_pass=$(oc get secret "$secret_name" -n "$ns" \
            -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
    fi

    if [[ -z "$pg_pass" ]]; then
        log "WARNING: Could not read password from secret $ns/$secret_name"
        return
    fi

    # URL-encode the password (operator may generate special chars)
    local encoded_pass
    encoded_pass=$($PYTHON -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$pg_pass")

    local svc_host="${cluster_name}-rw.${ns}.svc"
    local admin_url="postgresql+asyncpg://${db_user}:${encoded_pass}@${svc_host}:5432/${db_name}"
    local planner_url="postgresql://${db_user}:${encoded_pass}@${svc_host}:5432/${db_name}"
    # LiteLLM Prisma must use its own database (empty at first migrate) — not synesis_admin (Alembic).
    local litellm_url="postgresql://${db_user}:${encoded_pass}@${svc_host}:5432/litellm"

    # Store DB URLs in a Secret so kustomize apply cannot reset them to placeholders.
    # Deployments reference this via secretKeyRef (admin-url, trace-url).
    _upsert_admin_db_url_secret "$admin_url" "$planner_url"

    _ensure_litellm_database "$ns" "$cluster_name" || true
    _upsert_litellm_database_secret "$litellm_url"
    _upsert_litellm_db_credentials

    log "  Admin DB wired: $svc_host/$db_name (user=$db_user)"
    _restart_yarn_after_admin_db_url_update
}

# Yarn reads SYNESIS_YARN_ADMIN_DB_URL at container start; rolling restart picks up new secret data.
_restart_yarn_after_admin_db_url_update() {
    local yn="synesis-yarn"
    if ! oc get deployment synesis-yarn -n "$yn" &>/dev/null; then
        return 0
    fi
    log "  Restarting $yn/synesis-yarn to reload synesis-admin-db-url (usage + session persistence to admin DB)"
    oc rollout restart deployment/synesis-yarn -n "$yn" 2>/dev/null || true
}

# Store admin + planner DB URLs in a single Secret per namespace.
# Deployments reference these via secretKeyRef, immune to kustomize resets.
_upsert_admin_db_url_secret() {
    local admin_url="${1:?}" planner_url="${2:?}"
    for ns_target in synesis-admin synesis-planner synesis-yarn; do
        oc create namespace "$ns_target" 2>/dev/null || true
        oc create secret generic synesis-admin-db-url -n "$ns_target" \
            --from-literal=admin-url="$admin_url" \
            --from-literal=trace-url="$planner_url" \
            --dry-run=client -o yaml | oc apply -f - >/dev/null
    done
    log "  Secret synesis-admin-db-url synced to synesis-admin, synesis-planner, synesis-yarn"
}

# Sync LiteLLM DATABASE_URL via Secret so `oc apply -k` does not wipe inline env values.
# (Legacy — kept for non-Helm fallback. Helm chart uses litellm-db-credentials instead.)
_upsert_litellm_database_secret() {
    local litellm_url="${1:?}"
    local gw="synesis-gateway"
    oc create namespace "$gw" 2>/dev/null || true
    oc create secret generic litellm-database-url -n "$gw" \
        --from-literal=database-url="$litellm_url" \
        --dry-run=client -o yaml | oc apply -f - \
        && log "  Secret $gw/litellm-database-url synced (LiteLLM Prisma)"
}

# Create litellm-db-credentials secret for the Helm chart (db.useExisting).
# Sources the password from the CNPG operator-generated secret.
_upsert_litellm_db_credentials() {
    local gw="synesis-gateway"
    local admin_ns="synesis-admin"
    local cnpg_secret="synesis-admin-db-app"

    oc create namespace "$gw" 2>/dev/null || true

    local pg_pass=""
    if oc get secret "$cnpg_secret" -n "$admin_ns" &>/dev/null; then
        pg_pass=$(oc get secret "$cnpg_secret" -n "$admin_ns" \
            -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
    fi

    if [[ -z "$pg_pass" ]]; then
        log "WARNING: Could not read password from $admin_ns/$cnpg_secret — skipping litellm-db-credentials"
        return
    fi

    oc create secret generic litellm-db-credentials -n "$gw" \
        --from-literal=username="app" \
        --from-literal=password="$pg_pass" \
        --dry-run=client -o yaml | oc apply -f - \
        && log "  Secret $gw/litellm-db-credentials synced"
}

# -----------------------------------------------------------------------
# Deploy LiteLLM via the official Helm chart.
# Replaces the Kustomize-managed Deployment/Service/ConfigMap.
#
# Idempotent: skips `helm upgrade --wait` when the merged values fingerprint
# matches the last successful run (ConfigMap synesis-gateway/litellm-helm-values-fingerprint).
# Use SYNESIS_FORCE_LITELLM_HELM=true to always upgrade (e.g. after pulling a new chart).
# -----------------------------------------------------------------------
_sha256_stdin() {
    "$PYTHON" -c "import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"
}

_litellm_helm_values_fingerprint() {
    local values_file="$1" values_dir="$2" static_flag="$3"
    {
        cat "$values_file"
        if [[ "$static_flag" == "true" ]]; then
            local static_file="$values_dir/values-synesis-static.yaml"
            if [[ -f "$static_file" ]]; then
                cat "$static_file"
            fi
        fi
        printf '\n# synesis_fingerprint static_fallback=%s\n' "$static_flag"
    } | _sha256_stdin
}

deploy_litellm_helm() {
    [[ "$MODE" != "api" ]] && return 0

    local ns="synesis-gateway"
    local values_dir="$PROJECT_ROOT/base/gateway/helm"
    local values_file="$values_dir/values-synesis.yaml"
    local release_name="litellm-proxy"
    local fp_cm="litellm-helm-values-fingerprint"

    if [[ ! -f "$values_file" ]]; then
        log "WARNING: Helm values file not found: $values_file — skipping LiteLLM Helm deploy"
        return 1
    fi

    if ! command -v helm &>/dev/null; then
        log "ERROR: helm CLI not found. Install Helm 3.x to deploy LiteLLM."
        log "  https://helm.sh/docs/intro/install/"
        return 1
    fi

    oc create namespace "$ns" 2>/dev/null || true

    local fp
    fp=$(_litellm_helm_values_fingerprint "$values_file" "$values_dir" "$LITELLM_STATIC_FALLBACK")

    local prev_fp=""
    if oc get configmap "$fp_cm" -n "$ns" &>/dev/null; then
        prev_fp=$(oc get configmap "$fp_cm" -n "$ns" -o jsonpath='{.data.sha256}' 2>/dev/null || true)
    fi

    if ! is_true "${SYNESIS_FORCE_LITELLM_HELM:-false}"; then
        if helm status "$release_name" -n "$ns" &>/dev/null; then
            if [[ -n "$prev_fp" && "$prev_fp" == "$fp" ]]; then
                log ""
                log "LiteLLM Helm: values unchanged (fingerprint matches $ns/$fp_cm) — skipping upgrade."
                log "  To force: SYNESIS_FORCE_LITELLM_HELM=true $0 $MODE"
                return 0
            fi
        fi
    else
        log ""
        log "LiteLLM Helm: SYNESIS_FORCE_LITELLM_HELM=true — running upgrade regardless of fingerprint."
    fi

    # Pin chart version to a known-safe release.  Override with
    # SYNESIS_LITELLM_CHART_VERSION for controlled upgrades.
    local chart_version="${SYNESIS_LITELLM_CHART_VERSION:-1.82.3-stable.patch.2}"

    local helm_args=(
        upgrade --install "$release_name"
        oci://ghcr.io/berriai/litellm-helm
        --version "$chart_version"
        -n "$ns"
        -f "$values_file"
    )

    if [[ "$LITELLM_STATIC_FALLBACK" == "true" ]]; then
        local static_file="$values_dir/values-synesis-static.yaml"
        if [[ -f "$static_file" ]]; then
            helm_args+=(-f "$static_file")
            log ""
            log "Deploying LiteLLM via Helm (static fallback mode)..."
        else
            log "WARNING: Static fallback values file not found: $static_file"
            log "  Falling back to dynamic mode."
            log ""
            log "Deploying LiteLLM via Helm (dynamic Prisma mode)..."
        fi
    else
        log ""
        log "Deploying LiteLLM via Helm (dynamic Prisma mode)..."
    fi

    helm_args+=(--wait --timeout 5m)

    # Helm 3.15+ applies some resources with server-side apply. A ConfigMap that was
    # previously touched by `kubectl/oc apply` (client-side) keeps field manager
    # "kubectl-client-side-apply" on .data.config.yaml and Helm then fails with:
    #   conflict with "kubectl-client-side-apply" ... .data.config.yaml
    # Dropping the chart ConfigMap immediately before upgrade is idempotent: the
    # chart recreates it in the same upgrade (same as a first-time install).
    local litellm_chart_cfg_cm="litellm-proxy-config"
    if oc get configmap "$litellm_chart_cfg_cm" -n "$ns" &>/dev/null; then
        log "  Removing $ns/$litellm_chart_cfg_cm so Helm can own it (avoids SSA / kubectl apply conflicts)."
        oc delete configmap "$litellm_chart_cfg_cm" -n "$ns" --wait=false 2>/dev/null || true
    fi

    # Pre-create the synesis-callbacks ConfigMap so the migration hook
    # (a Helm pre-upgrade job) can mount it. Helm extraResources are
    # only applied after hooks finish, causing a mount failure otherwise.
    # Labels/annotations must match Helm ownership so the chart can adopt it.
    local callbacks_src="$PROJECT_ROOT/base/gateway/synesis_callbacks.py"
    if [[ -f "$callbacks_src" ]]; then
        oc create configmap synesis-callbacks -n "$ns" \
            --from-file=synesis_callbacks.py="$callbacks_src" \
            --dry-run=client -o yaml | oc apply -f - >/dev/null
        oc label configmap synesis-callbacks -n "$ns" \
            app.kubernetes.io/managed-by=Helm --overwrite >/dev/null
        oc annotate configmap synesis-callbacks -n "$ns" \
            "meta.helm.sh/release-name=$release_name" \
            "meta.helm.sh/release-namespace=$ns" --overwrite >/dev/null
        log "  Pre-created synesis-callbacks ConfigMap (required by migration hook)"
    fi

    if helm "${helm_args[@]}"; then
        log "  LiteLLM Helm release '$release_name' deployed successfully"
        oc create configmap "$fp_cm" -n "$ns" \
            --from-literal=sha256="$fp" \
            --from-literal=updated="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --dry-run=client -o yaml | oc apply -f - \
            && log "  Recorded values fingerprint in ConfigMap $fp_cm"
    else
        log "WARNING: LiteLLM Helm deploy failed. Check: helm status $release_name -n $ns"
        return 1
    fi
}

# Create empty `litellm` DB for LiteLLM Prisma (idempotent). Must not reuse synesis_admin.
_ensure_litellm_database() {
    local ns="${1:?}"
    local cluster_name="${2:?}"
    local pod
    pod=$(oc get pods -n "$ns" -l "role=primary,cnpg.io/cluster=${cluster_name}" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) || return 1
    [[ -n "$pod" ]] || return 1
    if oc exec -n "$ns" "$pod" -c postgres -- psql -U postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname='litellm'" 2>/dev/null | grep -q 1; then
        return 0
    fi
    if oc exec -n "$ns" "$pod" -c postgres -- psql -U postgres -c "CREATE DATABASE litellm OWNER app;"; then
        log "  Created database litellm on $cluster_name"
    else
        log "WARNING: CREATE DATABASE litellm failed (LiteLLM Prisma will not start)"
    fi
}

# Drop and recreate the `litellm` Prisma database for a clean start.
# Controlled by SYNESIS_RESET_LITELLM_DB=true env var (safety gate).
reset_litellm_database() {
    if ! is_true "${SYNESIS_RESET_LITELLM_DB:-false}"; then
        return 0
    fi

    local ns="synesis-admin"
    local cluster_name="synesis-admin-db"
    local gw="synesis-gateway"

    log ""
    log "LITELLM DB RESET requested (SYNESIS_RESET_LITELLM_DB=true)"

    # Scale down litellm-proxy to release DB connections
    if oc get deployment litellm-proxy -n "$gw" &>/dev/null; then
        log "  Scaling down litellm-proxy..."
        oc scale deployment litellm-proxy -n "$gw" --replicas=0 2>/dev/null || true
        sleep 5
    fi

    local pod
    pod=$(oc get pods -n "$ns" -l "role=primary,cnpg.io/cluster=${cluster_name}" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) || {
        log "WARNING: Cannot find Postgres primary pod — skipping DB reset"
        return 1
    }
    [[ -n "$pod" ]] || { log "WARNING: No primary pod found"; return 1; }

    # Terminate active connections and drop
    log "  Dropping litellm database..."
    oc exec -n "$ns" "$pod" -c postgres -- psql -U postgres -c \
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='litellm' AND pid <> pg_backend_pid();" \
        2>/dev/null || true
    oc exec -n "$ns" "$pod" -c postgres -- psql -U postgres -c \
        "DROP DATABASE IF EXISTS litellm;" 2>/dev/null || true

    # Recreate
    log "  Recreating litellm database..."
    if oc exec -n "$ns" "$pod" -c postgres -- psql -U postgres -c \
        "CREATE DATABASE litellm OWNER app;"; then
        log "  litellm database recreated (clean)"
    else
        log "ERROR: Failed to recreate litellm database"
        return 1
    fi

    # Scale litellm-proxy back up (migrations run on startup via USE_PRISMA_MIGRATE)
    if oc get deployment litellm-proxy -n "$gw" &>/dev/null; then
        log "  Scaling litellm-proxy back up..."
        oc scale deployment litellm-proxy -n "$gw" --replicas=1 2>/dev/null || true
    fi

    log "  DB reset complete — Prisma migrations will run on next startup"
}

# Helper: set a single env var on a deployment, only if it changed.
# Optional 5th arg: container name (recommended for multi-container deploys).
_patch_deployment_env() {
    local ns="$1" deploy="$2" env_name="$3" env_value="$4"
    local container="${5:-}"

    if ! oc get deployment "$deploy" -n "$ns" &>/dev/null; then
        return
    fi

    local current
    local jp
    if [[ -n "$container" ]]; then
        jp="{.spec.template.spec.containers[?(@.name=='$container')].env[?(@.name=='$env_name')].value}"
    else
        jp="{.spec.template.spec.containers[0].env[?(@.name=='$env_name')].value}"
    fi
    current=$(oc get deployment "$deploy" -n "$ns" -o "jsonpath=$jp" 2>/dev/null || true)

    if [[ "$current" == "$env_value" ]]; then
        return
    fi

    if [[ -n "$container" ]]; then
        if oc set env deployment/"$deploy" -n "$ns" -c "$container" "${env_name}=${env_value}" 2>/dev/null; then
            log "  Patched $ns/$deploy ($container) $env_name"
        else
            log "WARNING: oc set env failed for $ns/$deploy ($container) $env_name"
        fi
    else
        if oc set env deployment/"$deploy" -n "$ns" "${env_name}=${env_value}" 2>/dev/null; then
            log "  Patched $ns/$deploy $env_name"
        else
            log "WARNING: oc set env failed for $ns/$deploy $env_name"
        fi
    fi
}

# Yarn TS handles Claude/Anthropic natively -- no env-var compat flags needed.

# Ensure Yarn reducer registry/runtime controls are present on each deploy.
patch_yarn_reducer_envs() {
    local ns="synesis-yarn"
    local deploy="synesis-yarn"
    local container="yarn"

    if ! oc get deployment "$deploy" -n "$ns" &>/dev/null; then
        return
    fi

    local reducers_enabled="${SYNESIS_YARN_REDUCERS_ENABLED:-true}"
    local reducer_disabled="${SYNESIS_YARN_REDUCER_DISABLED_FAMILIES:-}"
    local reducer_min_conf="${SYNESIS_YARN_REDUCER_MIN_CONFIDENCE:-0.6}"
    local reducer_profile="${SYNESIS_YARN_REDUCER_PROFILE:-balanced}"

    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_REDUCERS_ENABLED" "$reducers_enabled" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_REDUCER_DISABLED_FAMILIES" "$reducer_disabled" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_REDUCER_MIN_CONFIDENCE" "$reducer_min_conf" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_REDUCER_PROFILE" "$reducer_profile" "$container"
}

# Enable debug protocol and stream admission env vars on each deploy.
patch_yarn_debug_and_streams() {
    local ns="synesis-yarn"
    local deploy="synesis-yarn"
    local container="yarn"

    if ! oc get deployment "$deploy" -n "$ns" &>/dev/null; then
        return
    fi

    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_DEBUG_PROTOCOL" "${SYNESIS_YARN_DEBUG_PROTOCOL:-true}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_REQUEST_FORENSICS_ENABLED" "${SYNESIS_YARN_REQUEST_FORENSICS_ENABLED:-true}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_REQUEST_FORENSICS_CAPTURE_PAYLOAD" "${SYNESIS_YARN_REQUEST_FORENSICS_CAPTURE_PAYLOAD:-false}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_REQUEST_FORENSICS_MAX_PREVIEW_CHARS" "${SYNESIS_YARN_REQUEST_FORENSICS_MAX_PREVIEW_CHARS:-4000}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_MAX_CONCURRENT_STREAMS" "${SYNESIS_YARN_MAX_CONCURRENT_STREAMS:-50}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_STREAM_QUEUE_MAX_DEPTH" "${SYNESIS_YARN_STREAM_QUEUE_MAX_DEPTH:-100}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_STREAM_QUEUE_WAIT_TIMEOUT_MS" "${SYNESIS_YARN_STREAM_QUEUE_WAIT_TIMEOUT_MS:-30000}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_SESSION_SOFT_MAX_INPUT_TOKENS" "${SYNESIS_YARN_SESSION_SOFT_MAX_INPUT_TOKENS:-10000000}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS" "${SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS:-50000000}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_SESSION_BUDGET_MODE" "${SYNESIS_YARN_SESSION_BUDGET_MODE:-audit}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_CONTEXT_ADMISSION_MODE" "${SYNESIS_YARN_CONTEXT_ADMISSION_MODE:-hybrid}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT" "${SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT:-15}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT" "${SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT:-9}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT" "${SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT:-4}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT" "${SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT:-2}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED" "${SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED:-true}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_POLICY_HARD_REJECT_AFTER" "${SYNESIS_YARN_POLICY_HARD_REJECT_AFTER:-6}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TASK_INTAKE_ENABLED" "${SYNESIS_YARN_TASK_INTAKE_ENABLED:-true}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_PLAN_GRAPH_ENABLED" "${SYNESIS_YARN_PLAN_GRAPH_ENABLED:-true}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED" "${SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED:-true}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED" "${SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED:-true}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_PHASE_EXECUTION_POLICY_ENABLED" "${SYNESIS_YARN_PHASE_EXECUTION_POLICY_ENABLED:-false}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_PHASE_EXECUTION_POLICY_FAMILIES" "${SYNESIS_YARN_PHASE_EXECUTION_POLICY_FAMILIES:-qwen3-coder}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_MODEL_SELECTION_MODE" "${SYNESIS_YARN_MODEL_SELECTION_MODE:-respect_explicit}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_CLI_ACCEPTANCE_HARNESS_ENABLED" "${SYNESIS_YARN_CLI_ACCEPTANCE_HARNESS_ENABLED:-false}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_ENABLED" "${SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_ENABLED:-true}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_WINDOW_MS" "${SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_WINDOW_MS:-3600000}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_SESSION_LIMIT" "${SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_SESSION_LIMIT:-10000000}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_USER_LIMIT" "${SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_USER_LIMIT:-20000000}" "$container"
}

# Tool call collapsing: batch/dedupe model tool rounds (see docs/YARN_TOOL_COLLAPSE.md).
patch_yarn_tool_collapse_envs() {
    local ns="synesis-yarn"
    local deploy="synesis-yarn"
    local container="yarn"

    if ! oc get deployment "$deploy" -n "$ns" &>/dev/null; then
        return
    fi

    local collapse_enabled="${SYNESIS_YARN_TOOL_COLLAPSE_ENABLED:-true}"
    local collapse_rewrite="${SYNESIS_YARN_TOOL_COLLAPSE_REWRITE_NON_STREAM:-false}"
    local collapse_debounce="${SYNESIS_YARN_TOOL_COLLAPSE_DEBOUNCE_MS:-100}"

    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TOOL_COLLAPSE_ENABLED" "$collapse_enabled" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TOOL_COLLAPSE_REWRITE_NON_STREAM" "$collapse_rewrite" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TOOL_COLLAPSE_DEBOUNCE_MS" "$collapse_debounce" "$container"

    local dedupe_enabled="${SYNESIS_YARN_DEDUPE_ENABLED:-true}"
    local dedupe_cache_max="${SYNESIS_YARN_DEDUPE_CACHE_MAX:-512}"
    local dedupe_query_max="${SYNESIS_YARN_DEDUPE_MAX_SEARCH_QUERY_CHARS:-4096}"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_DEDUPE_ENABLED" "$dedupe_enabled" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_DEDUPE_CACHE_MAX" "$dedupe_cache_max" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_DEDUPE_MAX_SEARCH_QUERY_CHARS" "$dedupe_query_max" "$container"

    local pcache_enabled="${SYNESIS_YARN_TOOL_PREFIX_CACHE_ENABLED:-true}"
    local pcache_entries="${SYNESIS_YARN_TOOL_PREFIX_CACHE_MAX_ENTRIES:-512}"
    local pcache_bytes="${SYNESIS_YARN_TOOL_PREFIX_CACHE_MAX_ENTRY_BYTES:-262144}"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TOOL_PREFIX_CACHE_ENABLED" "$pcache_enabled" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TOOL_PREFIX_CACHE_MAX_ENTRIES" "$pcache_entries" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TOOL_PREFIX_CACHE_MAX_ENTRY_BYTES" "$pcache_bytes" "$container"

    if [[ -n "${SYNESIS_YARN_TOOL_COLLAPSE_SHELL_ALLOWLIST:-}" ]]; then
        _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TOOL_COLLAPSE_SHELL_ALLOWLIST" "${SYNESIS_YARN_TOOL_COLLAPSE_SHELL_ALLOWLIST}" "$container"
    fi
}

# Strict path-governance defaults (fix-forward): no legacy wandering behavior.
patch_yarn_path_governance_envs() {
    local ns="synesis-yarn"
    local deploy="synesis-yarn"
    local container="yarn"

    if ! oc get deployment "$deploy" -n "$ns" &>/dev/null; then
        return
    fi

    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE" "${SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE:-true}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED" "${SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED:-true}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_SESSION_PATH_HINTS_IN_WORKING_FRAME" "${SYNESIS_YARN_SESSION_PATH_HINTS_IN_WORKING_FRAME:-true}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_RESPONSE_STYLE_MODE" "${SYNESIS_YARN_RESPONSE_STYLE_MODE:-guidance}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_RESPONSE_STYLE_ALLOW_MERMAID" "${SYNESIS_YARN_RESPONSE_STYLE_ALLOW_MERMAID:-true}" "$container"
}

verify_yarn_path_governance_envs() {
    local ns="synesis-yarn"
    local deploy="synesis-yarn"

    if ! oc get deployment "$deploy" -n "$ns" &>/dev/null; then
        return 0
    fi

    local ok="true"
    _require_env() {
        local env_name="$1"
        local expected="$2"
        local current
        current=$(oc get deployment "$deploy" -n "$ns" \
            -o "jsonpath={.spec.template.spec.containers[?(@.name=='yarn')].env[?(@.name=='$env_name')].value}" \
            2>/dev/null || true)
        if [[ "$current" != "$expected" ]]; then
            log "ERROR: $ns/$deploy requires $env_name=$expected (found '${current:-<unset>}')"
            ok="false"
        fi
    }

    _require_env "SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE" "${SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE:-true}"
    _require_env "SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED" "${SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED:-true}"
    _require_env "SYNESIS_YARN_SESSION_PATH_HINTS_IN_WORKING_FRAME" "${SYNESIS_YARN_SESSION_PATH_HINTS_IN_WORKING_FRAME:-true}"
    _require_env "SYNESIS_YARN_RESPONSE_STYLE_MODE" "${SYNESIS_YARN_RESPONSE_STYLE_MODE:-guidance}"
    _require_env "SYNESIS_YARN_RESPONSE_STYLE_ALLOW_MERMAID" "${SYNESIS_YARN_RESPONSE_STYLE_ALLOW_MERMAID:-true}"

    [[ "$ok" == "true" ]]
}

verify_yarn_runtime_envs() {
    local ns="synesis-yarn"
    local deploy="synesis-yarn"
    local container="yarn"

    if ! oc get deployment "$deploy" -n "$ns" &>/dev/null; then
        return 0
    fi

    local ok="true"
    _check_runtime_env() {
        local env_name="$1"
        local expected="$2"
        local jp="{.spec.template.spec.containers[?(@.name=='$container')].env[?(@.name=='$env_name')].value}"
        local actual
        actual="$(oc get deployment "$deploy" -n "$ns" -o "jsonpath=$jp" 2>/dev/null || true)"
        if [[ "$actual" != "$expected" ]]; then
            log "WARNING: Yarn env drift $env_name expected='$expected' actual='${actual:-<unset>}'"
            ok="false"
        else
            log "  Yarn env OK $env_name=$actual"
        fi
    }

    _check_runtime_env "SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT" "${SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT:-15}"
    _check_runtime_env "SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT" "${SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT:-9}"
    _check_runtime_env "SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT" "${SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT:-4}"
    _check_runtime_env "SYNESIS_YARN_POLICY_HARD_REJECT_AFTER" "${SYNESIS_YARN_POLICY_HARD_REJECT_AFTER:-6}"
    _check_runtime_env "SYNESIS_YARN_TASK_INTAKE_ENABLED" "${SYNESIS_YARN_TASK_INTAKE_ENABLED:-true}"
    _check_runtime_env "SYNESIS_YARN_PLAN_GRAPH_ENABLED" "${SYNESIS_YARN_PLAN_GRAPH_ENABLED:-true}"
    _check_runtime_env "SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED" "${SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED:-true}"
    _check_runtime_env "SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED" "${SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED:-true}"
    _check_runtime_env "SYNESIS_YARN_MODEL_SELECTION_MODE" "${SYNESIS_YARN_MODEL_SELECTION_MODE:-respect_explicit}"
    _check_runtime_env "SYNESIS_YARN_CLI_ACCEPTANCE_HARNESS_ENABLED" "${SYNESIS_YARN_CLI_ACCEPTANCE_HARNESS_ENABLED:-false}"
    _check_runtime_env "SYNESIS_YARN_EVAL_API_ENABLED" "${SYNESIS_YARN_EVAL_API_ENABLED:-true}"
    _check_runtime_env "SYNESIS_YARN_EVAL_OBSERVER_ENABLED" "${SYNESIS_YARN_EVAL_OBSERVER_ENABLED:-true}"

    [[ "$ok" == "true" ]]
}

# Patch all Yarn feature flags (Phases 7–19).
# Each flag defaults to the value in config.ts but can be overridden by the
# corresponding shell env var when running deploy.sh.
# Set SYNESIS_YARN_FULL_FEATURES=true to flip every gated feature ON at once.
patch_yarn_feature_flags() {
    local ns="synesis-yarn"
    local deploy="synesis-yarn"
    local container="yarn"

    if ! oc get deployment "$deploy" -n "$ns" &>/dev/null; then
        return
    fi

    local full="${SYNESIS_YARN_FULL_FEATURES:-false}"

    _flag() {
        local name="$1" default_val="$2"
        local val="${!name:-}"
        if [[ -z "$val" ]]; then
            if is_true "$full"; then val="true"; else val="$default_val"; fi
        fi
        _patch_deployment_env "$ns" "$deploy" "$name" "$val" "$container"
    }

    # ── Phase 6: MCP + Planner-backed search tools ──
    _flag SYNESIS_YARN_MCP_TOOLS_ENABLED              "true"
    _flag SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED        "true"
    _flag SYNESIS_YARN_WEB_SEARCH_ENABLED              "true"

    # ── Phase 7a: Recall Engine ──
    _flag SYNESIS_YARN_RECALL_BYPASS_ENABLED           "false"

    # ── Phase 7b: Verification Loop ──
    _flag SYNESIS_YARN_VERIFICATION_PLAN_ENABLED       "false"

    # ── Phase 8: Decision Matrix ──
    _flag SYNESIS_YARN_DECISION_MATRIX_ENABLED         "false"

    # ── Phase 10: Sensemaking (disabled in regular coding flow) ──
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_SENSEMAKING_ENABLED" "${SYNESIS_YARN_SENSEMAKING_ENABLED:-false}" "$container"

    # ── Phase 11: Reliability Hardening ──
    _flag SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED  "false"

    # ── Phase 12: Feature Activation ──
    _flag SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED      "false"

    # ── Phase 13: Evidence Pipeline ──
    _flag SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED       "true"
    _flag SYNESIS_YARN_EVIDENCE_PREFETCH_RETRY_ENABLED "false"

    # ── Phase 14: Governance ──
    _flag SYNESIS_YARN_GOVERNANCE_ENABLED              "false"

    # ── Phase 15: Conversation Memory ──
    _flag SYNESIS_YARN_CONVERSATION_MEMORY_ENABLED     "false"
    _flag SYNESIS_YARN_CROSS_CONVERSATION_RECALL_ENABLED "false"
    _flag SYNESIS_YARN_SESSION_CONTINUITY_ENABLED      "true"

    # ── Phase 16: Worker Pool ──
    _flag SYNESIS_YARN_WORKER_POOL_ENABLED             "false"

    # ── Phase 19: Pattern Recall ──
    _flag SYNESIS_YARN_PATTERN_RECALL_ENABLED          "false"
    _flag SYNESIS_YARN_PATTERN_USAGE_FEEDBACK_ENABLED  "false"

    # ── Phase 19b: Validation Tier C + Tool Schema Pruning ──
    _flag SYNESIS_YARN_VALIDATION_TIER_C_ENABLED       "false"
    _flag SYNESIS_YARN_TOOL_SCHEMA_PRUNING_ENABLED     "true"
    _flag SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED        "true"
    _flag SYNESIS_YARN_OPENCLAW_MCP_ALLOWLIST_ENABLED  "true"
    _flag SYNESIS_YARN_OPENCLAW_STRICT_GOVERNANCE_ENABLED "true"

    # Non-boolean tuning knobs (do not force true under FULL mode)
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_VALIDATION_TIER_C_ROLE" "${SYNESIS_YARN_VALIDATION_TIER_C_ROLE:-coder-normalizer}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_VALIDATION_TIER_C_TIMEOUT_MS" "${SYNESIS_YARN_VALIDATION_TIER_C_TIMEOUT_MS:-1500}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_VALIDATION_TIER_C_MAX_INPUT_CHARS" "${SYNESIS_YARN_VALIDATION_TIER_C_MAX_INPUT_CHARS:-8000}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_VALIDATION_TIER_C_MAX_FINDINGS" "${SYNESIS_YARN_VALIDATION_TIER_C_MAX_FINDINGS:-8}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TOOL_SCHEMA_PRUNING_MAX_OVERRIDE" "${SYNESIS_YARN_TOOL_SCHEMA_PRUNING_MAX_OVERRIDE:-0}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_OPENCLAW_TOOL_SCHEMA_CAP" "${SYNESIS_YARN_OPENCLAW_TOOL_SCHEMA_CAP:-8}" "$container"

    # ── Cache stability: governance bypass for A/B testing ──
    _flag SYNESIS_YARN_GOVERNANCE_DISABLED              "false"

    # ── DashScope explicit cache markers ──
    _flag SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_ENABLED "false"
    _flag SYNESIS_YARN_DASHSCOPE_CACHE_MAX_MARKERS      "3"

    # ── Prefix optimizer (provider-agnostic stable-first layout) ──
    _flag SYNESIS_YARN_PREFIX_OPTIMIZER_ENABLED          "true"

    # ── M10: Prefix cache / token optimization ──
    _flag SYNESIS_YARN_STABLE_PREFIX_ENABLED           "true"
    _flag SYNESIS_YARN_JSON_COMPACTION_ENABLED         "true"
    _flag SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED   "true"
    _flag SYNESIS_YARN_SORTED_TOOLS_ENABLED            "true"

    # ── Transcript pruning (evict stale tool results, condense old turns) ──
    _flag SYNESIS_YARN_TRANSCRIPT_PRUNE_ENABLED        "true"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TURNS" "${SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TURNS:-5}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TOOL_RESULTS" "${SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TOOL_RESULTS:-25}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TRANSCRIPT_PRUNE_BUDGET_CHARS" "${SYNESIS_YARN_TRANSCRIPT_PRUNE_BUDGET_CHARS:-120000}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TRANSCRIPT_PRUNE_STUB_MAX_CHARS" "${SYNESIS_YARN_TRANSCRIPT_PRUNE_STUB_MAX_CHARS:-400}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_YARN_TRANSCRIPT_PRUNE_ASSISTANT_CONDENSE_CHARS" "${SYNESIS_YARN_TRANSCRIPT_PRUNE_ASSISTANT_CONDENSE_CHARS:-2000}" "$container"

    # ── Content Dispatch ──
    _flag SYNESIS_YARN_CONTENT_DISPATCH_ENABLED        "true"

    # ── Completion quality (pre-finalize critic + gate) ──
    _flag SYNESIS_YARN_PREFINALIZE_CRITIC_ENABLED      "true"
    _flag SYNESIS_YARN_PREFINALIZE_LLM_CRITIC_ENABLED  "false"
    _flag SYNESIS_YARN_COMPLETION_GATE_ENABLED         "false"

    # ── Trust / Security ──
    _flag SYNESIS_YARN_TRUST_PACKET_ENABLED            "true"
    _flag SYNESIS_YARN_INJECTION_SCAN_ENABLED          "true"
    _flag SYNESIS_YARN_SECURITY_INGEST_ENABLED         "true"

    # ── Tool call collapse (plan API + optional non-stream rewrite) ──
    _flag SYNESIS_YARN_TOOL_COLLAPSE_ENABLED           "true"
    _flag SYNESIS_YARN_TOOL_COLLAPSE_REWRITE_NON_STREAM "false"
    _flag SYNESIS_YARN_DEDUPE_ENABLED                  "true"
    _flag SYNESIS_YARN_TOOL_PREFIX_CACHE_ENABLED       "true"

    # ── Eval Gym: scenario runner, session observer, training data export ──
    _flag SYNESIS_YARN_EVAL_API_ENABLED                "true"
    _flag SYNESIS_YARN_EVAL_OBSERVER_ENABLED           "true"
}

# Ensure planner-ts guardrails/clarification flags are explicitly enabled.
patch_planner_feature_flags() {
    local ns="synesis-planner"
    local deploy="synesis-planner-ts"
    local container="planner-ts"

    if ! oc get deployment "$deploy" -n "$ns" &>/dev/null; then
        return
    fi

    _patch_deployment_env "$ns" "$deploy" "SYNESIS_PLANNER_TS_AMBIGUITY_SCORER_ENABLED" "${SYNESIS_PLANNER_TS_AMBIGUITY_SCORER_ENABLED:-true}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_PLANNER_TS_AMBIGUITY_SCORER_MODEL" "${SYNESIS_PLANNER_TS_AMBIGUITY_SCORER_MODEL:-synesis-general}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_PLANNER_TS_AMBIGUITY_SCORER_MAX_TOKENS" "${SYNESIS_PLANNER_TS_AMBIGUITY_SCORER_MAX_TOKENS:-350}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_PLANNER_TS_AMBIGUITY_THRESHOLD" "${SYNESIS_PLANNER_TS_AMBIGUITY_THRESHOLD:-0.58}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_PLANNER_TS_MERMAID_GUARD_ENABLED" "${SYNESIS_PLANNER_TS_MERMAID_GUARD_ENABLED:-true}" "$container"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_PLANNER_TS_MERMAID_GUARD_STRICT" "${SYNESIS_PLANNER_TS_MERMAID_GUARD_STRICT:-true}" "$container"
    # Writer output: policy target vs effective max_tokens; default audit for telemetry learning (override with enforced if needed).
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_PLANNER_TS_WRITER_BUDGET_MODE" "${SYNESIS_PLANNER_TS_WRITER_BUDGET_MODE:-audit}" "$container"
}

# Reconcile planner-ts unified retrieval (TEI + Milvus + SearXNG) on every deploy so OpenShift/Kustomize
# applies do not leave SYNESIS_WEB_SEARCH_URL empty (planner-ts default) or drop service URLs.
# Admin Integrations → Web Search log: requires synesis-admin-db-url in synesis-planner (see patch_admin_db_urls).
patch_planner_retrieval_and_web() {
    local ns="synesis-planner"
    local deploy="synesis-planner-ts"
    local container="planner-ts"

    if ! oc get deployment "$deploy" -n "$ns" &>/dev/null; then
        return
    fi

    if is_true "${SYNESIS_DEPLOY_PLANNER_RETRIEVAL:-true}"; then
        local embedder="${SYNESIS_PLANNER_EMBEDDER_URL:-http://embedder.synesis-rag.svc.cluster.local:8080/v1}"
        local milvus_host="${SYNESIS_PLANNER_MILVUS_HOST:-synesis-milvus.synesis-rag.svc.cluster.local}"
        local milvus_port="${SYNESIS_PLANNER_MILVUS_PORT:-19530}"
        local searx="${SYNESIS_PLANNER_SEARXNG_URL:-http://searxng.synesis-search.svc.cluster.local:8080}"
        local web_on="${SYNESIS_PLANNER_WEB_SEARCH_ENABLED:-true}"
        log "  SYNESIS_DEPLOY_PLANNER_RETRIEVAL enabled — patching $ns/$deploy (embedder, Milvus, SearXNG)"
        _patch_deployment_env "$ns" "$deploy" "SYNESIS_EMBEDDER_URL" "$embedder" "$container"
        _patch_deployment_env "$ns" "$deploy" "SYNESIS_MILVUS_HOST" "$milvus_host" "$container"
        _patch_deployment_env "$ns" "$deploy" "SYNESIS_MILVUS_PORT" "$milvus_port" "$container"
        _patch_deployment_env "$ns" "$deploy" "SYNESIS_WEB_SEARCH_ENABLED" "$web_on" "$container"
        _patch_deployment_env "$ns" "$deploy" "SYNESIS_WEB_SEARCH_URL" "$searx" "$container"
        if oc get secret synesis-admin-db-url -n "$ns" &>/dev/null; then
            log "    synesis-admin-db-url present — SYNESIS_PLANNER_TS_ADMIN_DB_URL (web_search_log) can resolve"
        else
            log "WARNING: synesis-admin-db-url missing in $ns — planner web_search_log persistence disabled until admin DB secret is synced"
        fi
    else
        log "  SYNESIS_DEPLOY_PLANNER_RETRIEVAL disabled — clearing planner-ts embedder and web search URL"
        _patch_deployment_env "$ns" "$deploy" "SYNESIS_WEB_SEARCH_ENABLED" "false" "$container"
        _patch_deployment_env "$ns" "$deploy" "SYNESIS_WEB_SEARCH_URL" "" "$container"
        _patch_deployment_env "$ns" "$deploy" "SYNESIS_EMBEDDER_URL" "" "$container"
    fi
}

# Ensure MCP-TS has the internal service token and admin DB URL.
patch_mcp_ts_envs() {
    local ns="synesis-yarn"
    local deploy="synesis-mcp-ts"

    if ! oc get deployment "$deploy" -n "$ns" &>/dev/null; then
        return
    fi

    # Keep sensitive values secret-backed (never patch inline plaintext env values).
    oc patch deployment "$deploy" -n "$ns" --type='strategic' -p '{
      "spec": {
        "template": {
          "spec": {
            "containers": [{
              "name": "mcp-ts",
              "env": [
                {
                  "name": "SYNESIS_INTERNAL_SERVICE_TOKEN",
                  "valueFrom": {
                    "secretKeyRef": {
                      "name": "synesis-internal-service-auth",
                      "key": "token",
                      "optional": true
                    }
                  }
                },
                {
                  "name": "SYNESIS_ADMIN_DB_URL",
                  "valueFrom": {
                    "secretKeyRef": {
                      "name": "synesis-admin-db-url",
                      "key": "admin-url",
                      "optional": true
                    }
                  }
                }
              ]
            }]
          }
        }
      }
    }' >/dev/null 2>&1 || log "WARNING: unable to patch secret-backed envs for $ns/$deploy"
}

# Optional env patches for synesis-admin-mcp-ts (Streamable Admin MCP; proxies to Admin API).
patch_admin_mcp_ts_envs() {
    local ns="synesis-admin"
    local deploy="synesis-admin-mcp-ts"

    if ! oc get deployment "$deploy" -n "$ns" &>/dev/null; then
        return
    fi

    # Keep SYNESIS_ADMIN_API_URL aligned with in-cluster admin Service if deploy.sh overrides admin URL elsewhere.
    local admin_url="${SYNESIS_ADMIN_INTERNAL_URL:-http://synesis-admin.synesis-admin.svc.cluster.local:8080}"
    _patch_deployment_env "$ns" "$deploy" "SYNESIS_ADMIN_API_URL" "$admin_url" "admin-mcp-ts"
}

# Post-apply: refresh the synesis-admin-db-url Secret with the real CNPG password.
# Deployments reference this Secret via secretKeyRef — no more inline-env race.
patch_admin_db_urls() {
    local ns="synesis-admin"
    local cluster_name="synesis-admin-db"
    local secret_name="${cluster_name}-app"
    local db_name="synesis_admin"
    local db_user="app"

    if ! oc get secret "$secret_name" -n "$ns" &>/dev/null; then
        return
    fi

    local pg_pass
    pg_pass=$(oc get secret "$secret_name" -n "$ns" \
        -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)

    if [[ -z "$pg_pass" ]] || [[ "$pg_pass" == "changeme" ]]; then
        return
    fi

    local encoded_pass
    encoded_pass=$($PYTHON -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$pg_pass")

    local svc_host="${cluster_name}-rw.${ns}.svc"
    local admin_url="postgresql+asyncpg://${db_user}:${encoded_pass}@${svc_host}:5432/${db_name}"
    local planner_url="postgresql://${db_user}:${encoded_pass}@${svc_host}:5432/${db_name}"
    local litellm_url="postgresql://${db_user}:${encoded_pass}@${svc_host}:5432/litellm"

    _upsert_admin_db_url_secret "$admin_url" "$planner_url"
    _ensure_litellm_database "$ns" "$cluster_name" || true
    _upsert_litellm_database_secret "$litellm_url"
    _restart_yarn_after_admin_db_url_update
}

# -----------------------------------------------------------------------
# Keycloak auth DB: separate CloudNativePG cluster for Keycloak.
# -----------------------------------------------------------------------
ensure_keycloak_db() {
    local ns="synesis-auth"
    local cluster_name="synesis-auth-db"
    local cluster_manifest="$PROJECT_ROOT/base/keycloak/postgres-cluster.yaml"

    oc create namespace "$ns" 2>/dev/null || true

    if ! oc get crd clusters.postgresql.cnpg.io &>/dev/null; then
        log "WARNING: CloudNativePG CRD not found — skipping Keycloak DB."
        return
    fi

    if [[ -f "$cluster_manifest" ]]; then
        oc apply -f "$cluster_manifest"
        log "  Keycloak DB Cluster CR applied: $ns/$cluster_name"
    else
        log "WARNING: Keycloak DB manifest not found: $cluster_manifest"
        return
    fi

    log "  Waiting for Keycloak Postgres cluster..."
    local ready="false"
    for _ in $(seq 1 36); do
        local phase
        phase=$(oc get cluster "$cluster_name" -n "$ns" \
            -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
        if [[ "$phase" == "Cluster in healthy state" ]]; then
            ready="true"
            break
        fi
        sleep 5
    done

    if [[ "$ready" != "true" ]]; then
        log "WARNING: Keycloak Postgres not ready after 3 min."
        return
    fi
    log "  Keycloak Postgres cluster is healthy"
}

# -----------------------------------------------------------------------
# Keycloak: deploy the Keycloak CR and realm import via Kustomize.
# -----------------------------------------------------------------------
ensure_keycloak() {
    local ns="synesis-auth"

    if ! oc get crd keycloaks.k8s.keycloak.org &>/dev/null; then
        log "WARNING: RHBK operator not found — skipping Keycloak deployment."
        log "  Install from OperatorHub: 'Red Hat build of Keycloak'"
        return
    fi

    oc create namespace "$ns" 2>/dev/null || true

    # The RHBK operator is installed in synesis-admin (OLM).  Ensure it
    # watches synesis-auth by patching the OperatorGroup + deployment annotation.
    local og_name
    og_name=$(oc get operatorgroup -n synesis-admin -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    if [[ -n "$og_name" ]]; then
        local current_ns
        current_ns=$(oc get operatorgroup "$og_name" -n synesis-admin -o jsonpath='{.spec.targetNamespaces}' 2>/dev/null || true)
        if [[ "$current_ns" != *"synesis-auth"* ]]; then
            log "  Extending RHBK OperatorGroup to watch synesis-auth..."
            oc patch operatorgroup "$og_name" -n synesis-admin --type=merge \
                -p '{"spec":{"targetNamespaces":["synesis-admin","synesis-auth"]}}' 2>/dev/null || true
            oc patch deployment rhbk-operator -n synesis-admin --type=json \
                -p '[{"op":"add","path":"/spec/template/metadata/annotations/olm.targetNamespaces","value":"synesis-admin,synesis-auth"}]' 2>/dev/null || true
            log "  Waiting for operator restart..."
            oc rollout status deployment/rhbk-operator -n synesis-admin --timeout=60s 2>/dev/null || true
        fi
    fi

    log "  Applying Keycloak manifests..."
    kustomize build "$PROJECT_ROOT/base/keycloak" | oc apply -f -

    log "  Waiting for Keycloak pod to be ready..."
    local ready="false"
    for _ in $(seq 1 60); do
        if oc get keycloak synesis-keycloak -n "$ns" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null | grep -q "True"; then
            ready="true"
            break
        fi
        sleep 5
    done

    if [[ "$ready" != "true" ]]; then
        log "WARNING: Keycloak not ready after 5 min. Check: oc get keycloak -n $ns"
    else
        log "  Keycloak is ready"
    fi

    # Realm import runs once; existing clusters may lack openid/profile/email client scopes
    # (Keycloak returns invalid_scope for Synesis Admin + Open WebUI). Idempotent repair.
    if oc get secret synesis-keycloak-initial-admin -n "$ns" &>/dev/null; then
        log "  Ensuring realm token lifetimes and OIDC client scopes on realm synesis..."
        if ! "$PROJECT_ROOT/scripts/ensure-keycloak-oidc-scopes.sh"; then
            log "WARNING: ensure-keycloak-oidc-scopes.sh failed — token lifetimes or OIDC scopes may be stale"
        fi
    fi

    # Extract initial admin credentials
    local admin_secret="synesis-keycloak-initial-admin"
    if oc get secret "$admin_secret" -n "$ns" &>/dev/null; then
        local kc_user kc_pass
        kc_user=$(oc get secret "$admin_secret" -n "$ns" -o jsonpath='{.data.username}' | base64 -d 2>/dev/null)
        kc_pass=$(oc get secret "$admin_secret" -n "$ns" -o jsonpath='{.data.password}' | base64 -d 2>/dev/null)
        KEYCLOAK_ADMIN_USER="$kc_user"
        KEYCLOAK_ADMIN_PASS="$kc_pass"
    fi

    # Patch admin + yarn with canonical Keycloak issuer URL.
    # Prefer explicit public host envs for Cloudflare cutovers.
    local kc_host
    kc_host="${SYNESIS_KEYCLOAK_PUBLIC_HOST:-${SYNESIS_CF_AUTH_HOST:-}}"
    if [[ -z "$kc_host" ]]; then
        kc_host=$(oc get route synesis-auth -n "$ns" -o jsonpath='{.spec.host}' 2>/dev/null || true)
    fi
    kc_host="${kc_host:-auth.kybern.dev}"
    local issuer_url="https://${kc_host}/realms/synesis"
    _patch_deployment_env "synesis-admin" "synesis-admin" "SYNESIS_KEYCLOAK_ISSUER_URL" "$issuer_url" "admin"
    _patch_deployment_env "synesis-yarn" "synesis-yarn" "SYNESIS_YARN_KEYCLOAK_ISSUER_URL" "$issuer_url" "yarn"
}

# -----------------------------------------------------------------------
# OpenFGA: authorization-as-a-service.
# Reuses the existing CNPG Postgres cluster (synesis-admin-db) with a
# separate `openfga` database.  Idempotent: reuses existing store/model
# if already created.
# -----------------------------------------------------------------------
ensure_openfga() {
    local authz_ns="synesis-authz"
    local admin_ns="synesis-admin"
    local cluster_name="synesis-admin-db"
    local cnpg_secret="${cluster_name}-app"
    local fga_secret="openfga-config"
    local preshared_secret="openfga-preshared-key"
    local client_secret="openfga-client-config"
    local fga_manifests="$PROJECT_ROOT/authz/openfga/deploy"
    local schema_json="$PROJECT_ROOT/authz/openfga/schema.json"

    if [[ -f "$fga_manifests/namespace.yaml" ]]; then
        oc apply -f "$fga_manifests/namespace.yaml"
    else
        oc create namespace "$authz_ns" 2>/dev/null || true
    fi

    # ── Step 1: create the openfga database on the existing CNPG cluster ──
    if ! oc get crd clusters.postgresql.cnpg.io &>/dev/null; then
        log "WARNING: CloudNativePG CRD not found — skipping OpenFGA setup."
        log "  Run ensure_admin_db first (deploy.sh sets up CNPG)."
        return
    fi

    local pg_pass=""
    if oc get secret "$cnpg_secret" -n "$admin_ns" &>/dev/null; then
        pg_pass=$(oc get secret "$cnpg_secret" -n "$admin_ns" \
            -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
    fi

    if [[ -z "$pg_pass" ]]; then
        log "WARNING: CNPG password not available — skipping OpenFGA setup."
        log "  Run ensure_admin_db first so the operator generates credentials."
        return
    fi

    local encoded_pass
    encoded_pass=$($PYTHON -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$pg_pass")
    local svc_host="${cluster_name}-rw.${admin_ns}.svc"

    # Create openfga database (idempotent — same pattern as _ensure_litellm_database)
    local pod=""
    pod=$(oc get pods -n "$admin_ns" -l "role=primary,cnpg.io/cluster=${cluster_name}" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) || true
    if [[ -n "$pod" ]]; then
        local db_exists
        db_exists=$(oc exec -n "$admin_ns" "$pod" -c postgres -- psql -U postgres -tAc \
            "SELECT 1 FROM pg_database WHERE datname='openfga'" 2>/dev/null || true)
        if [[ "$db_exists" != "1" ]]; then
            if oc exec -n "$admin_ns" "$pod" -c postgres -- psql -U postgres -c "CREATE DATABASE openfga OWNER app;"; then
                log "  Created database openfga on $cluster_name"
            else
                log "WARNING: CREATE DATABASE openfga failed"
            fi
        fi
    else
        log "WARNING: Cannot find Postgres primary pod — openfga DB may not exist"
    fi

    local fga_db_url="postgres://app:${encoded_pass}@${svc_host}:5432/openfga?sslmode=disable"

    # ── Step 2: generate preshared key (or reuse existing) ────────────────
    local preshared_key=""
    if oc get secret "$preshared_secret" -n "$authz_ns" &>/dev/null; then
        preshared_key=$(oc get secret "$preshared_secret" -n "$authz_ns" \
            -o jsonpath='{.data.key}' 2>/dev/null | base64 -d 2>/dev/null || true)
    fi
    preshared_key=$(printf '%s' "$preshared_key" | tr -d '\n\r')

    if [[ -z "$preshared_key" ]]; then
        preshared_key="fga-$(openssl rand -hex 32)"
        log "  Generated OpenFGA preshared key"
    else
        log "  Reusing existing OpenFGA preshared key"
    fi

    # Store the raw key separately so we can read it back reliably
    oc create secret generic "$preshared_secret" -n "$authz_ns" \
        --from-literal=key="$preshared_key" \
        --dry-run=client -o yaml | oc apply -f - >/dev/null

    # ── Step 3: create/update openfga-config secret ───────────────────────
    oc create secret generic "$fga_secret" -n "$authz_ns" \
        --from-literal=OPENFGA_DATASTORE_URI="$fga_db_url" \
        --from-literal=OPENFGA_AUTHN_PRESHARED_KEYS="$preshared_key" \
        --dry-run=client -o yaml | oc apply -f - >/dev/null
    log "  Secret $authz_ns/$fga_secret updated"

    # ── Step 4: run the migration job ─────────────────────────────────────
    if [[ -f "$fga_manifests/migrate-job.yaml" ]]; then
        # Delete previous job if it exists (jobs are immutable)
        oc delete job openfga-migrate -n "$authz_ns" --ignore-not-found 2>/dev/null || true
        oc apply -f "$fga_manifests/migrate-job.yaml"
        log "  Waiting for OpenFGA migration job..."
        local mig_ok="false"
        for _ in $(seq 1 24); do
            local phase
            phase=$(oc get job openfga-migrate -n "$authz_ns" \
                -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || true)
            if [[ "$phase" == "True" ]]; then
                mig_ok="true"
                break
            fi
            local failed
            failed=$(oc get job openfga-migrate -n "$authz_ns" \
                -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)
            if [[ "$failed" == "True" ]]; then
                log "WARNING: OpenFGA migration job failed"
                break
            fi
            sleep 5
        done
        if [[ "$mig_ok" == "true" ]]; then
            log "  OpenFGA migration complete"
        else
            log "WARNING: OpenFGA migration did not complete in 2 minutes"
            log "  Check: oc logs -n $authz_ns job/openfga-migrate"
        fi
    fi

    # ── Step 5: apply OpenFGA deployment + service ────────────────────────
    if [[ -f "$fga_manifests/deployment.yaml" ]]; then
        oc apply -f "$fga_manifests/deployment.yaml"
        log "  OpenFGA deployment + service applied"
    fi

    # Wait for OpenFGA to be ready
    log "  Waiting for OpenFGA pods..."
    local fga_ready="false"
    for _ in $(seq 1 30); do
        local ready_replicas
        ready_replicas=$(oc get deployment openfga -n "$authz_ns" \
            -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
        if [[ "${ready_replicas:-0}" -ge 1 ]]; then
            fga_ready="true"
            break
        fi
        sleep 5
    done

    if [[ "$fga_ready" != "true" ]]; then
        log "WARNING: OpenFGA not ready after 2.5 min"
        log "  Check: oc get pods -n $authz_ns -l app=openfga"
        log "  Continuing — store/model creation may fail."
    else
        log "  OpenFGA is ready"
    fi

    # The OpenFGA image is distroless (no shell/wget), so we port-forward
    # and use curl from the deploy host for API calls.
    local fga_local_port=18080
    local pf_pid=""
    oc port-forward -n "$authz_ns" svc/openfga "$fga_local_port:8080" &>/dev/null &
    pf_pid=$!
    sleep 2

    # Verify port-forward is alive
    if ! kill -0 "$pf_pid" 2>/dev/null; then
        log "WARNING: Port-forward to OpenFGA failed — cannot create store/model."
        log "  After pods are running, re-run deploy.sh to complete setup."
        return
    fi
    local fga_base="http://localhost:$fga_local_port"

    # Ensure port-forward is cleaned up on return
    trap 'kill "$pf_pid" 2>/dev/null || true' RETURN

    # ── Step 6: create the FGA store (idempotent) ─────────────────────────
    local store_id=""
    # Check if we already have a store ID saved
    if oc get secret "$client_secret" -n "$admin_ns" &>/dev/null; then
        store_id=$(oc get secret "$client_secret" -n "$admin_ns" \
            -o jsonpath='{.data.store-id}' 2>/dev/null | base64 -d 2>/dev/null || true)
        store_id=$(printf '%s' "$store_id" | tr -d '\n\r')
    fi

    if [[ -z "$store_id" ]]; then
        log "  Creating OpenFGA store..."
        local store_resp
        store_resp=$(curl -sf -X POST \
            -H "Authorization: Bearer $preshared_key" \
            -H "Content-Type: application/json" \
            -d '{"name":"synesis"}' \
            "$fga_base/stores" 2>/dev/null || true)
        store_id=$($PYTHON -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('id',''))" "$store_resp" 2>/dev/null || true)

        if [[ -z "$store_id" ]]; then
            # Try listing stores — maybe one already exists
            local list_resp
            list_resp=$(curl -sf \
                -H "Authorization: Bearer $preshared_key" \
                "$fga_base/stores" 2>/dev/null || true)
            store_id=$($PYTHON -c "
import json,sys
d = json.loads(sys.argv[1])
stores = d.get('stores', [])
for s in stores:
    if s.get('name') == 'synesis':
        print(s['id'])
        break
" "$list_resp" 2>/dev/null || true)
        fi

        if [[ -z "$store_id" ]]; then
            log "WARNING: Failed to create or find OpenFGA store"
            log "  Response: $store_resp"
            return
        fi
        log "  Store created: $store_id"
    else
        log "  Using existing store: $store_id"
    fi

    # ── Step 7: write the authorization model ─────────────────────────────
    local model_id=""
    if [[ -f "$schema_json" ]]; then
        log "  Writing authorization model..."
        local model_resp
        model_resp=$(curl -sf -X POST \
            -H "Authorization: Bearer $preshared_key" \
            -H "Content-Type: application/json" \
            -d @"$schema_json" \
            "$fga_base/stores/$store_id/authorization-models" 2>/dev/null || true)
        model_id=$($PYTHON -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('authorization_model_id',''))" "$model_resp" 2>/dev/null || true)

        if [[ -n "$model_id" ]]; then
            log "  Authorization model written: $model_id"
        else
            log "WARNING: Failed to write authorization model"
            log "  Response: $model_resp"
            # Try to read the latest existing model ID
            local models_resp
            models_resp=$(curl -sf \
                -H "Authorization: Bearer $preshared_key" \
                "$fga_base/stores/$store_id/authorization-models?page_size=1" 2>/dev/null || true)
            model_id=$($PYTHON -c "
import json,sys
d = json.loads(sys.argv[1])
models = d.get('authorization_models', [])
if models: print(models[0].get('id',''))
" "$models_resp" 2>/dev/null || true)
            if [[ -n "$model_id" ]]; then
                log "  Using existing model: $model_id"
            fi
        fi
    else
        log "WARNING: $schema_json not found — cannot write authorization model"
    fi

    # ── Step 8: write baseline tuples (idempotent) ──────────────────────
    # These grant all authenticated users access to public RAG and endpoints.
    # Individual user/org/tenant tuples are managed by the admin service.
    if [[ -n "$store_id" ]] && [[ -n "$model_id" ]]; then
        log "  Writing baseline authorization tuples..."
        local baseline_tuples
        baseline_tuples=$($PYTHON -c "
import json, sys
tuples = [
    {'user': 'user:*', 'relation': 'can_read_public', 'object': 'rag_catalog:default'},
    {'user': 'user:*', 'relation': 'can_invoke', 'object': 'planner_endpoint:chat_completions'},
    {'user': 'user:*', 'relation': 'can_invoke', 'object': 'yarn_endpoint:completions'},
    {'user': 'user:*', 'relation': 'can_invoke', 'object': 'yarn_endpoint:messages'},
    {'user': 'user:*', 'relation': 'can_read', 'object': 'admin_endpoint:tokens'},
    {'user': 'user:*', 'relation': 'can_read', 'object': 'admin_endpoint:profile'},
]
body = {
    'writes': {
        'tuple_keys': tuples
    },
    'authorization_model_id': sys.argv[1]
}
print(json.dumps(body))
" "$model_id")

        local tuples_resp
        tuples_resp=$(curl -sf -X POST \
            -H "Authorization: Bearer $preshared_key" \
            -H "Content-Type: application/json" \
            -d "$baseline_tuples" \
            "$fga_base/stores/$store_id/write" 2>/dev/null || true)
        local write_err
        write_err=$($PYTHON -c "
import json,sys
try:
    d = json.loads(sys.argv[1]) if sys.argv[1].strip() else {}
    code = d.get('code','')
    if code: print(d.get('message', code))
except: pass
" "$tuples_resp" 2>/dev/null || true)
        if [[ -z "$write_err" ]]; then
            log "  Baseline tuples written"
        else
            log "  Baseline tuples: $write_err (may already exist — OK)"
        fi
    fi

    # ── Step 9: sync openfga-client-config to consumer namespaces ─────────
    local consumer_ns
    for consumer_ns in synesis-admin synesis-planner synesis-yarn; do
        oc create namespace "$consumer_ns" 2>/dev/null || true
        oc create secret generic "$client_secret" -n "$consumer_ns" \
            --from-literal=store-id="$store_id" \
            --from-literal=model-id="${model_id:-}" \
            --from-literal=auth-token="$preshared_key" \
            --dry-run=client -o yaml | oc apply -f - >/dev/null
    done
    log "  Secret $client_secret synced to synesis-admin, synesis-planner, synesis-yarn"
    log "  OpenFGA setup complete"
}

log "=== Deploying Synesis ($MODE) ==="
[[ "$REF" != "latest" ]] && log "Image ref: $REF (tag: $REF_SAFE)"
if [[ "$MODE" == "api" ]]; then
    if [[ "$LITELLM_STATIC_FALLBACK" == "true" ]]; then
        log "LiteLLM route mode: static fallback (SYNESIS_LITELLM_STATIC_FALLBACK=true)"
    else
        log "LiteLLM route mode: dynamic (Prisma-backed registry sync)"
    fi
fi
log ""

ensure_litellm_key
ensure_internal_service_auth
ensure_webui_key
ensure_admin_litellm_key
ensure_planner_litellm_key
_openwebui_secret_rv_before=$(oc get secret synesis-openwebui-admin-token -n synesis-admin \
    -o jsonpath='{.metadata.resourceVersion}' 2>/dev/null || true)
ensure_openwebui_feedback_sync_secret
_openwebui_secret_rv_after=$(oc get secret synesis-openwebui-admin-token -n synesis-admin \
    -o jsonpath='{.metadata.resourceVersion}' 2>/dev/null || true)

if [[ "$MODE" == "api" ]]; then
    ensure_openrouter_key
fi

log ""
log "Syncing gateway secrets to Yarn namespace (synesis-yarn)..."
ensure_yarn_secrets_from_gateway

# -----------------------------------------------------------------------
# Admin ConfigMaps: models.yaml and taxonomy config mounted into the pod.
# Created from repo-root files so the admin service can read model registry
# and taxonomy data without baking them into the Docker image.
# -----------------------------------------------------------------------
ensure_admin_configmaps() {
    local ns="synesis-admin"
    oc create namespace "$ns" 2>/dev/null || true

    if [[ -f "$PROJECT_ROOT/models.yaml" ]]; then
        oc create configmap synesis-models-config \
            --from-file=models.yaml="$PROJECT_ROOT/models.yaml" \
            -n "$ns" --dry-run=client -o yaml | oc apply -f -
        log "  ConfigMap synesis-models-config updated from models.yaml"
    else
        log "WARNING: models.yaml not found at $PROJECT_ROOT/models.yaml"
    fi

    local taxonomy_path="$PROJECT_ROOT/base/planner/taxonomy_prompt_config.yaml"
    if [[ -f "$taxonomy_path" ]]; then
        oc create configmap synesis-taxonomy-config \
            --from-file=taxonomy_prompt_config.yaml="$taxonomy_path" \
            -n "$ns" --dry-run=client -o yaml | oc apply -f -
        log "  ConfigMap synesis-taxonomy-config updated from taxonomy_prompt_config.yaml"
    else
        log "WARNING: taxonomy_prompt_config.yaml not found at $taxonomy_path"
    fi
}

log ""
log "Setting up admin → gateway RBAC..."
oc apply -f "$PROJECT_ROOT/base/admin/rbac-gateway-secrets.yaml"
log "  Role/RoleBinding synesis-admin-provider-keys applied to synesis-gateway"

log ""
log "Setting up admin ConfigMaps..."
ensure_admin_configmaps

log ""
log "Setting up admin Postgres..."
ensure_admin_db

reset_litellm_database

log ""
log "Setting up OpenFGA authorization service..."
ensure_openfga

log ""
log "Setting up Keycloak auth DB..."
ensure_keycloak_db

log ""
log "Setting up Keycloak IdP..."
ensure_keycloak

log ""
log "Validating kustomize build..."
if ! kustomize build "$OVERLAY_DIR" 2>/dev/null >/dev/null; then
    log "ERROR: Kustomize build failed. Fix errors and retry."
    kustomize build "$OVERLAY_DIR" 2>&1
    exit 1
fi

log "Generating manifest preview..."
MANIFEST_COUNT=$(kustomize build "$OVERLAY_DIR" 2>/dev/null | grep -c '^kind:' || true)
log "  $MANIFEST_COUNT resources to apply"

# -----------------------------------------------------------------------
# Pre-flight: verify custom images are reachable.
# Spot-check key runtime images so deploys do not silently roll old tags:
#   - admin UI image (build-images.sh artifact "admin" → REGISTRY/admin:tag,
#     kustomize: synesis-admin → …/synesis/admin)
#   - yarn-ts image (contains MCP runtime + delegate_task orchestration path)
# When REF is not "latest", we check the same tag we're about to deploy.
# -----------------------------------------------------------------------
check_custom_images() {
    log "Checking Synesis runtime image availability (admin + yarn-ts)..."
    local built
    built=$(kustomize build "$OVERLAY_DIR" 2>/dev/null)
    # sed regex replacement; ${var//} cannot express capture groups
    # shellcheck disable=SC2001
    [[ "$REF_SAFE" != "latest" ]] && built=$(echo "$built" | sed "s|ghcr.io/supernovae/synesis/\([^:]*\):latest|ghcr.io/supernovae/synesis/\\1:${REF_SAFE}|g")
    check_image_by_pattern() {
        local label="$1"
        local pattern="$2"
        local sample_image
        sample_image=$(echo "$built" | grep 'image:' | grep -E "$pattern" | head -1 \
            | sed 's/.*image: *//' | tr -d '"' | tr -d "'" | awk '{print $1}' || true)

        if [[ -z "$sample_image" ]]; then
            log "  WARNING: Could not find $label image in rendered manifests."
            return
        fi

        if [[ "$sample_image" != *"/"* ]]; then
            log "WARNING: $label image still uses a bare name ($sample_image)."
            log "  Kubernetes will try docker.io/library/$sample_image which does not exist."
            log "  Ensure overlays/$MODE/kustomization.yaml has an 'images:' mapping for this workload."
            log ""
            return
        fi

        if command -v skopeo &>/dev/null; then
            if ! skopeo inspect --no-tags "docker://$sample_image" &>/dev/null; then
                log "WARNING: skopeo cannot inspect $sample_image ($label) (missing image, network, or auth)."
                log "  Build/push images:"
                [[ "$REF_SAFE" != "latest" ]] && log "    ./scripts/build-images.sh --only yarn-ts,admin,mcp-ts,admin-mcp-ts --push --tag $REF_SAFE"
                log "    ./scripts/build-images.sh --only yarn-ts,admin,mcp-ts,admin-mcp-ts --push"
                log "  Private GHCR: skopeo needs registry login (e.g. podman login ghcr.io); the cluster still pulls via imagePullSecrets."
                log "  If the cluster already pulls this image, you can ignore this warning."
                log ""
            else
                log "  Image check OK ($label: $sample_image)"
            fi
        else
            log "  Skipping image pull check for $label (skopeo not installed)"
            log "  Sample image: $sample_image"
        fi
    }

    # Must match overlays */kustomization image remaps.
    check_image_by_pattern "admin" 'synesis/admin(:|@)'
    check_image_by_pattern "yarn-ts" 'synesis/yarn-ts(:|@)'
}

check_custom_images

# -----------------------------------------------------------------------
# Pre-flight: check RHOAI model serving readiness.
# InferenceService resources require:
#   1. A DataScienceCluster CR with kserve: Managed
#   2. The odh-model-controller webhook to have running endpoints
# If (1) is missing, retrying won't help -- skip InferenceService apply.
# If (1) exists but (2) is not ready, retry with backoff.
# -----------------------------------------------------------------------

ISVC_SKIP=false

check_dsc_kserve() {
    local dsc_name
    dsc_name=$(oc get datascienceclusters.datasciencecluster.opendatahub.io \
        --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null | head -1 || true)

    if [[ -z "$dsc_name" ]]; then
        return 1
    fi

    local kserve_state
    kserve_state=$(oc get datascienceclusters.datasciencecluster.opendatahub.io "$dsc_name" \
        -o jsonpath='{.spec.components.kserve.managementState}' 2>/dev/null || echo "unknown")
    [[ "$kserve_state" == "Managed" ]]
}

check_rhoai_webhook() {
    local endpoint_json
    endpoint_json=$(oc get endpoints odh-model-controller-webhook-service \
        -n redhat-ods-applications -o jsonpath='{.subsets[*].addresses}' 2>/dev/null || true)
    [[ "${#endpoint_json}" -gt 2 ]]
}

# -----------------------------------------------------------------------
# Runtime discovery: verify ClusterServingRuntimes exist for model deployment.
# Override via SYNESIS_RUNTIME_GPU, SYNESIS_RUNTIME_CPU env vars (requires overlay patches).
# -----------------------------------------------------------------------
discover_runtimes() {
    if [[ "$ISVC_SKIP" == "true" ]]; then return 0; fi

    local deploys
    deploys=$(oc get deployments -n synesis-models -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)
    if [[ -n "$deploys" ]]; then
        log "  Model deployments in synesis-models: $deploys"
        for r in synesis-router synesis-critic synesis-coder synesis-general; do
            echo "$deploys" | grep -q "$r" || log "  WARNING: $r not found (deploy creates it)"
        done
    fi
}

log ""
if [[ "$MODE" == "api" ]]; then
    log "API mode: skipping RHOAI/model-serving checks (no GPU hardware needed)"
    ISVC_SKIP=true
else
    log "Checking RHOAI model serving readiness..."

    if ! check_dsc_kserve; then
        log "WARNING: No DataScienceCluster CR found with kserve: Managed."
        log "  InferenceService/ServingRuntime resources will be SKIPPED."
        log "  All other Synesis resources will be applied normally."
        log ""
        log "  To fix, create a DataScienceCluster CR (via Terraform, dashboard, or manifest):"
        log "    spec.components.kserve.managementState: Managed"
        log "  Then re-run:  ./scripts/deploy.sh $MODE"
        log ""
        log "  Prerequisites:"
        log "    - OpenShift Serverless operator (KNative Serving)"
        log "    - OpenShift Service Mesh operator (Istio)"
        ISVC_SKIP=true
    elif check_rhoai_webhook; then
        log "  DataScienceCluster: OK (kserve Managed)"
        log "  Model controller webhook: ready"
        discover_runtimes
    else
        log "  DataScienceCluster: OK (kserve Managed)"
        log "  Model controller webhook: not ready yet (will retry after apply)"
        discover_runtimes
    fi
fi

build_manifests() {
    local output
    output=$(kustomize build "$OVERLAY_DIR" 2>/dev/null)
    if [[ "$ISVC_SKIP" == "true" ]]; then
        output=$(echo "$output" | python3 -c "
import sys, re
docs = re.split(r'^---\s*$', sys.stdin.read(), flags=re.MULTILINE)
for doc in docs:
    if 'kind: InferenceService' not in doc and 'kind: ServingRuntime' not in doc:
        print('---')
        print(doc)
")
    fi
    # Deploy a specific ref (branch/tag/PR) instead of latest
    if [[ "$REF_SAFE" != "latest" ]]; then
        # shellcheck disable=SC2001
        output=$(echo "$output" | sed "s|ghcr.io/supernovae/synesis/\([^:]*\):latest|ghcr.io/supernovae/synesis/\\1:${REF_SAFE}|g")
    fi
    echo "$output"
}

apply_manifests() {
    local output
    output=$(build_manifests | oc apply -f - 2>&1)
    echo "$output" | grep -v '^#'

    if echo "$output" | grep -qi 'failed calling webhook'; then
        return 1
    fi
    if echo "$output" | grep -qi 'field is immutable'; then
        return 1
    fi
    return 0
}

# -----------------------------------------------------------------------
# Ensure shared EFS PVC exists for model weights.
# -----------------------------------------------------------------------
ensure_model_pvc() {
    oc create namespace synesis-models 2>/dev/null || true

    local pvc="synesis-models-efs"
    if oc get pvc "$pvc" -n synesis-models &>/dev/null; then
        log "PVC $pvc exists"
    else
        local manifest="$PROJECT_ROOT/pipelines/manifests/synesis-models-efs-pvc.yaml"
        if [[ -f "$manifest" ]]; then
            log "Creating $pvc PVC (requires efs-sc StorageClass from Terraform)..."
            oc apply -f "$manifest" || true
        else
            log "WARNING: PVC manifest not found: $manifest"
        fi
    fi
}
if [[ "$MODE" != "api" ]]; then
    ensure_model_pvc
fi

log ""
log "Applying manifests to cluster..."

APPLY_OK=false
MAX_ATTEMPTS=6
ATTEMPT=1
WAIT_SECS=10

if [[ "$ISVC_SKIP" == "true" ]]; then
    MAX_ATTEMPTS=1
fi

while [[ $ATTEMPT -le $MAX_ATTEMPTS ]]; do
    if apply_manifests; then
        APPLY_OK=true
        break
    fi

    if [[ $ATTEMPT -lt $MAX_ATTEMPTS ]]; then
        log ""
        log "WARNING: Apply had errors (attempt $ATTEMPT/$MAX_ATTEMPTS)."
        if ! check_rhoai_webhook; then
            log "  RHOAI webhook not ready (odh-model-controller pods may still be starting)."
            log "  Waiting ${WAIT_SECS}s..."
        else
            log "  Retrying in ${WAIT_SECS}s..."
        fi
        sleep "$WAIT_SECS"
        WAIT_SECS=$((WAIT_SECS * 2))
    fi
    ATTEMPT=$((ATTEMPT + 1))
done

if [[ "$APPLY_OK" != "true" && "$ISVC_SKIP" != "true" ]]; then
    log ""
    log "WARNING: Some resources failed to apply after $MAX_ATTEMPTS attempts."
    log "  The RHOAI model controller webhook is not responding."
    log "  Diagnose:"
    log "    oc get datascienceclusters"
    log "    oc get pods -n redhat-ods-applications -l app=odh-model-controller"
    log "    oc get endpoints odh-model-controller-webhook-service -n redhat-ods-applications"
    log "  Once ready, re-run:  ./scripts/deploy.sh $MODE"
fi

# -----------------------------------------------------------------------
# One-time cleanup: remove Kustomize-managed LiteLLM resources before Helm
# takes over. Only runs once (detects Deployment not owned by Helm).
# -----------------------------------------------------------------------
_cleanup_kustomize_litellm() {
    local gw="synesis-gateway"
    if ! oc get deployment litellm-proxy -n "$gw" &>/dev/null 2>&1; then
        return 0
    fi
    local mgr
    mgr=$(oc get deployment litellm-proxy -n "$gw" \
        -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}' 2>/dev/null || true)
    if [[ "$mgr" == "Helm" ]]; then
        return 0
    fi
    log ""
    log "Cleaning up Kustomize-managed LiteLLM resources (migrating to Helm)..."
    oc delete deployment litellm-proxy -n "$gw" --ignore-not-found 2>/dev/null || true
    oc delete service litellm-proxy -n "$gw" --ignore-not-found 2>/dev/null || true
    oc delete configmap litellm-config -n "$gw" --ignore-not-found 2>/dev/null || true
    oc delete route synesis-api -n "$gw" --ignore-not-found 2>/dev/null || true
    log "  Kustomize LiteLLM resources removed — Helm will recreate them"
}
_cleanup_kustomize_litellm

# -----------------------------------------------------------------------
# One-time cleanup: admin resources moved from synesis-planner to
# synesis-admin. Remove the orphaned resources in the old namespace.
# -----------------------------------------------------------------------
if oc get deployment synesis-admin -n synesis-planner &>/dev/null; then
    log ""
    log "Cleaning up stale admin resources from synesis-planner namespace..."
    oc delete deployment synesis-admin -n synesis-planner --ignore-not-found 2>/dev/null || true
    oc delete service synesis-admin -n synesis-planner --ignore-not-found 2>/dev/null || true
    oc delete route synesis-admin -n synesis-planner --ignore-not-found 2>/dev/null || true
    log "  Stale admin resources removed from synesis-planner"
fi

# -----------------------------------------------------------------------
# Post-apply: re-patch admin/planner DATABASE_URL with the real password.
# The kustomize-applied deployments have the placeholder "changeme";
# this overwrites it if the operator secret exists.
# -----------------------------------------------------------------------
log ""
log "Patching admin DB credentials (post-apply)..."
patch_admin_db_urls

log ""
log "Reconciling provider API keys (post-apply)..."
reconcile_provider_api_keys

log ""
log "Refreshing Yarn secrets from gateway (post-apply)..."
ensure_yarn_secrets_from_gateway

log ""
log "Patching Yarn reducer runtime envs (post-apply)..."
patch_yarn_reducer_envs

log ""
log "Patching Yarn debug protocol and stream admission (post-apply)..."
patch_yarn_debug_and_streams

log ""
log "Patching Yarn tool-collapse envs (post-apply)..."
patch_yarn_tool_collapse_envs

log ""
log "Patching Yarn strict path-governance envs (post-apply)..."
patch_yarn_path_governance_envs

log ""
log "Patching Yarn feature flags (Phases 7–19, post-apply)..."
if is_true "${SYNESIS_YARN_FULL_FEATURES:-false}"; then
    log "  SYNESIS_YARN_FULL_FEATURES=true — enabling ALL gated features (including Tier C validation fallback)"
fi
patch_yarn_feature_flags

log ""
log "Patching planner-ts feature flags (post-apply)..."
patch_planner_feature_flags

log ""
log "Patching planner-ts RAG + web search (post-apply)..."
patch_planner_retrieval_and_web

log ""
log "Validating Yarn strict path-governance envs (post-apply)..."
if ! verify_yarn_path_governance_envs; then
    log "ERROR: strict Yarn path-governance env validation failed."
    exit 1
fi
log ""
log "Validating Yarn runtime envs (post-apply)..."
if ! verify_yarn_runtime_envs; then
    log "ERROR: Yarn runtime env validation failed."
    exit 1
fi

log ""
log "Patching MCP-TS service envs (post-apply)..."
patch_mcp_ts_envs

log ""
log "Patching Admin MCP-TS deployment envs (post-apply)..."
patch_admin_mcp_ts_envs

log ""
log "Reconciling LiteLLM / WebUI client secrets (post-apply)..."
reconcile_litellm_webui_secrets

log ""
log "Chat Feedback: reload synesis-admin if Open WebUI admin token secret changed..."
post_apply_restart_synesis_admin_openwebui_feedback

if [[ "$APPLY_OK" == "true" ]]; then
    deploy_litellm_helm
fi

if [[ "$APPLY_OK" == "true" ]]; then
    log ""
    log "Reconciling optional cloudflared tunnel..."
    ensure_cloudflared_tunnel || true
fi

if [[ "$APPLY_OK" == "true" ]]; then
    log ""
    if ! verify_cloudflared_tunnel; then
        if is_true "${SYNESIS_VERIFY_CLOUDFLARED:-false}"; then
            log "ERROR: cloudflared verification failed (SYNESIS_VERIFY_CLOUDFLARED=true)"
            exit 1
        fi
    fi
fi

# -----------------------------------------------------------------------
# Keep Deployments and ReplicaSets under control (idempotent, less cruft).
# - Set revisionHistoryLimit=2 on Synesis Deployments so new rollouts don't pile up.
# - Delete old ReplicaSets with 0 replicas so failed or superseded rollouts don't linger.
# -----------------------------------------------------------------------
SYNESIS_NAMESPACES=(synesis-gateway synesis-planner synesis-rag synesis-webui synesis-admin synesis-yarn synesis-models synesis-sandbox synesis-search synesis-authz)

set_revision_history_limit() {
    local ns name
    for ns in "${SYNESIS_NAMESPACES[@]}"; do
        if ! oc get namespace "$ns" &>/dev/null; then continue; fi
        for name in $(oc get deployment -n "$ns" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
            oc patch deployment "$name" -n "$ns" -p '{"spec":{"revisionHistoryLimit":2}}' --type=merge 2>/dev/null || true
        done
    done
    log "  Set revisionHistoryLimit=2 on Deployments"
}

prune_old_replicasets() {
    local ns name count=0
    for ns in "${SYNESIS_NAMESPACES[@]}"; do
        if ! oc get namespace "$ns" &>/dev/null; then continue; fi
        while read -r name; do
            [[ -z "$name" ]] && continue
            if oc delete replicaset "$name" -n "$ns" --ignore-not-found 2>/dev/null; then
                ((count++)) || true
            fi
        done < <(oc get rs -n "$ns" --no-headers -o custom-columns=NAME:.metadata.name,REPLICAS:.status.replicas 2>/dev/null | awk '$2=="" || $2=="0" {print $1}')
    done
    if [[ "${count:-0}" -gt 0 ]]; then
        log "  Pruned $count old ReplicaSet(s) (0 replicas)"
    fi
}

if [[ "$APPLY_OK" == "true" ]]; then
    log ""
    log "Setting revisionHistoryLimit=2 on Deployments (limits future ReplicaSet growth)..."
    set_revision_history_limit
fi

# -----------------------------------------------------------------------
# Configmap-hash annotations — triggers pod restart when configmap changes.
# Kubernetes does not restart pods on configmap updates; this annotation
# approach is the standard workaround.  Idempotent: no restart if hash
# hasn't changed.
# -----------------------------------------------------------------------
if [[ "$APPLY_OK" == "true" ]]; then
    log ""
    log "Patching configmap-hash annotations (triggers restart on config change)..."

    _patch_configmap_hash() {
        local ns="$1" deploy="$2" cm_name="$3"
        local hash
        hash=$(oc get configmap "$cm_name" -n "$ns" -o jsonpath='{.data}' 2>/dev/null | (md5sum 2>/dev/null || md5) | cut -c1-8)
        if [[ -n "$hash" && "$hash" != "d41d8cd9" ]]; then
            oc patch deployment "$deploy" -n "$ns" \
                -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"synesis/configmap-hash\":\"$hash\"}}}}}" \
                2>/dev/null && log "  $ns/$deploy configmap-hash=$hash" || true
        fi
    }

    _patch_configmap_hash synesis-search   searxng        searxng-settings
    # litellm-proxy is now managed by Helm — chart handles config rollouts.
    _patch_configmap_hash synesis-admin    synesis-admin  synesis-models-config
fi

log ""
log "Waiting for rollouts..."

wait_for_deployment() {
    local ns="${1:?wait_for_deployment requires namespace}"
    local deploy="${2:?wait_for_deployment requires deployment name}"
    if oc get deployment "$deploy" -n "$ns" &>/dev/null; then
        log "  Waiting for $ns/$deploy..."
        if ! oc rollout status deployment/"$deploy" -n "$ns" --timeout=300s 2>/dev/null; then
            log "WARNING: Rollout timeout for $ns/$deploy"
        fi
    fi
}

# litellm-proxy rollout is managed by Helm --wait (deploy_litellm_helm).
wait_for_deployment synesis-planner synesis-planner
wait_for_deployment synesis-planner synesis-health-monitor
# Milvus is managed by the Milvus Operator (kind: Milvus CR).
# The operator handles etcd + Milvus pod lifecycle. We wait for the
# operator-created Milvus deployment instead of manual etcd/milvus.
if oc get milvus synesis -n synesis-rag &>/dev/null 2>&1; then
    log "  Waiting for Milvus CR 'synesis' to become Healthy..."
    for _ in $(seq 1 30); do
        STATUS=$(oc get milvus synesis -n synesis-rag -o jsonpath='{.status.status}' 2>/dev/null || echo "")
        if [[ "$STATUS" == "Healthy" ]]; then
            log "  Milvus CR is Healthy"
            break
        fi
        sleep 10
    done
    if [[ "$STATUS" != "Healthy" ]]; then
        log "WARNING: Milvus CR status is '$STATUS' after 5 min. Check: oc get milvus synesis -n synesis-rag -o yaml"
    fi
else
    log "  No Milvus CR found — install Milvus Operator first (see bootstrap.sh)"
fi
# RAG data plane: base/core includes base/rag (embedder, keyword, gliner, preprocess, spam, redis, Milvus operator).
# Indexer CronJob is a separate kustomize overlay — ./scripts/deploy-indexer.sh
wait_for_deployment synesis-rag embedder
wait_for_deployment synesis-rag keyword-service
wait_for_deployment synesis-rag gliner-service
wait_for_deployment synesis-rag preprocess-service
wait_for_deployment synesis-rag spam-service
wait_for_deployment synesis-search searxng
wait_for_deployment synesis-admin synesis-admin
wait_for_deployment synesis-admin synesis-admin-mcp-ts
wait_for_deployment synesis-yarn synesis-mcp-ts
wait_for_deployment synesis-yarn synesis-ast-mcp
wait_for_deployment synesis-yarn synesis-vision-worker
wait_for_deployment synesis-yarn synesis-yarn
if ! verify_yarn_path_governance_envs; then
    log "ERROR: strict Yarn path-governance env validation failed after rollout."
    exit 1
fi
if ! verify_yarn_runtime_envs; then
    log "ERROR: Yarn runtime env validation failed after rollout."
    exit 1
fi
wait_for_deployment synesis-authz openfga
wait_for_deployment synesis-webui open-webui

# Prune old ReplicaSets (0 replicas) after rollouts so we don't delete the new one.
if [[ "$APPLY_OK" == "true" ]]; then
    log ""
    log "Pruning stale ReplicaSets (0 replicas)..."
    prune_old_replicasets
fi

log ""
if [[ "$MODE" == "api" ]]; then
    log "Model serving: API providers (no local GPU hardware)"
    log "  All LLM traffic routes through LiteLLM → external API providers"
    log "  Configure model endpoints via Admin UI (LiteLLM /model/new + deploy.sh DATABASE_URL on litellm-proxy)"
else
    log "Model serving status (synesis-models namespace):"
    if [[ "$ISVC_SKIP" == "true" ]]; then
        log "  InferenceServices SKIPPED (no DataScienceCluster with kserve Managed)"
        log "  Summarizer and model deployments must be applied manually."
    else
        if oc get deployment synesis-router -n synesis-models &>/dev/null || oc get inferenceservice -n synesis-models --no-headers 2>/dev/null | grep -q .; then
            log ""
            oc get deployments -n synesis-models -l 'app.kubernetes.io/name in (synesis-router,synesis-critic,synesis-coder,synesis-general)' 2>/dev/null || true
            oc get pods -n synesis-models -l 'app in (synesis-router,synesis-critic,synesis-coder,synesis-general)' 2>/dev/null || true
            oc get inferenceservice -n synesis-models 2>/dev/null || true
            log ""
            log "  Model topology (small profile): router (1 GPU) + critic (1 GPU) + coder (1 GPU) on L40S"
            log "  See models.yaml for profile sizing. Wait for pods Ready."
            pending=$(oc get pods -n synesis-models --no-headers 2>/dev/null \
                | grep -E "synesis-router|synesis-critic|synesis-coder|synesis-general" | grep -E "Pending|ContainerCreating" || true)
            if [[ -n "$pending" ]]; then
                log ""
                log "  WARNING: Model pods Pending. Common causes:"
                log "    - No PVC: oc get pvc synesis-models-efs -n synesis-models"
                log "    - PVC pending: check efs-sc StorageClass and EFS CSI driver"
                log "    - No GPU nodes: oc get nodes -l node-role.autonode/gpu"
                log "    - Models not downloaded: ./scripts/run-model-pipeline.sh --profile=small"
                log "  Inspect: oc describe pod -n synesis-models -l app=synesis-router"
            fi
        else
            log "  Model deployments may not be ready yet."
            log "  Check: oc get pods -n synesis-models"
            log "  Then retry: ./scripts/deploy.sh $MODE"
        fi
    fi
fi

log ""
log "=== Deployment complete ($MODE) ==="

ROUTE_HOST=$(oc get route synesis-api -n synesis-gateway -o jsonpath='{.spec.host}' 2>/dev/null || echo "not-yet-created")
WEBUI_HOST=$(oc get route synesis-webui -n synesis-webui -o jsonpath='{.spec.host}' 2>/dev/null || echo "not-yet-created")
ADMIN_HOST=$(oc get route synesis-admin -n synesis-admin -o jsonpath='{.spec.host}' 2>/dev/null || echo "not-yet-created")
KC_HOST=$(oc get route synesis-auth -n synesis-auth -o jsonpath='{.spec.host}' 2>/dev/null || echo "not-yet-created")
YARN_HOST=$(oc get route synesis-yarn -n synesis-yarn -o jsonpath='{.spec.host}' 2>/dev/null || echo "not-yet-created")

log ""
log "============================================================"
log "  API endpoint:  https://$ROUTE_HOST"
log "  API key:       $LITELLM_KEY"
log "  Web UI:        https://$WEBUI_HOST"
log "  Admin UI:      https://$ADMIN_HOST"
log "  Yarn (IDE):    https://$YARN_HOST"
log "  Keycloak:      https://$KC_HOST"
log "============================================================"
log ""
if [[ -n "${KEYCLOAK_ADMIN_USER:-}" ]]; then
    log "Keycloak initial admin:"
    log "  URL:      https://$KC_HOST/admin"
    log "  Username: $KEYCLOAK_ADMIN_USER"
    log "  Password: $KEYCLOAK_ADMIN_PASS"
    log ""
    log "IMPORTANT: Change the Keycloak admin password after first login!"
    log ""
fi
log "Next: deploy indexer CronJobs (after Milvus is healthy):"
log "  ./scripts/deploy-indexer.sh"
log "  ./scripts/deploy-indexer.sh --run   # process pending queue items now"
log "  ./scripts/deploy-indexer.sh --s3-bucket <name>   # staged S3 pipeline (fetch/normalize/enrich CronJobs)"
log ""
log "Quality runner (corpus audit + DB import, runs nightly at 04:00 UTC):"
log "  CronJob:  synesis-quality-runner in synesis-rag namespace"
log "  Run now:  oc create job synesis-quality-run-now --from=cronjob/synesis-quality-runner -n synesis-rag"
log "  Logs:     oc logs -n synesis-rag job/synesis-quality-run-now -f"
log ""
log "Open WebUI (SSO via Keycloak):"
log "  Browse to https://$WEBUI_HOST"
log "  Click 'Sign in with Keycloak' to register or log in."
log "  Models are pre-configured -- select 'Synesis' to start."
log ""
log "API access (generate a Personal Access Token in Admin UI):"
log "  1. Log in to https://$ADMIN_HOST"
log "  2. Click the key icon in the top bar"
log "  3. Generate a token for your IDE or scripts"
log ""
log "Export for your shell:"
log "  export SYNESIS_API_KEY=<your-personal-token>"
log "  export SYNESIS_API_URL=https://$ROUTE_HOST/v1"
log ""
log "Cursor / Claude Code setup:"
log "  Base URL: https://$ROUTE_HOST/v1"
log "  API Key:  <your-personal-token>"
log "  Model:    synesis-coder"
log ""
log "Quick test:"
log "  curl -s https://$ROUTE_HOST/v1/models -H 'Authorization: Bearer $LITELLM_KEY' | python3 -m json.tool"
