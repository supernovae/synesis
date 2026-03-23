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
#
# Yarn (IDE path) and the MCP agent deploy with both api and model overlays
# (namespaces synesis-yarn, synesis-planner/synesis-mcp). Images: ghcr.io/.../yarn, .../mcp.
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
# Internal service auth token (defense in depth for control-plane APIs).
# Idempotent: reuse existing token if present in any managed namespace,
# otherwise generate and sync to all.
# -----------------------------------------------------------------------
ensure_internal_service_auth() {
    local secret_name="synesis-internal-service-auth"
    local key_name="token"
    local existing=""
    local ns
    local namespaces=(synesis-admin synesis-rag synesis-planner synesis-yarn synesis-gateway)

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
# Yarn (synesis-yarn): clone gateway secrets so envFrom provider-api-keys /
# litellm-secrets resolve in the Yarn namespace (DeepInfra + optional LiteLLM).
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
    local creds_file="${SYNESIS_CF_TUNNEL_CREDENTIALS_FILE:-}"
    local creds_json="${SYNESIS_CF_TUNNEL_CREDENTIALS_JSON:-}"

    if [[ ! -d "$kustomize_dir" ]]; then
        log "WARNING: cloudflared base not found at $kustomize_dir"
        return 1
    fi

    oc create namespace "$ns" 2>/dev/null || true

    # Credentials secret
    if [[ -n "$creds_json" ]]; then
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
    elif ! oc get secret "$secret_name" -n "$ns" &>/dev/null; then
        log "WARNING: cloudflared credentials missing."
        log "  Set one of:"
        log "    SYNESIS_CF_TUNNEL_CREDENTIALS_JSON='{\"AccountTag\":\"...\",\"TunnelSecret\":\"...\",\"TunnelID\":\"...\"}'"
        log "    SYNESIS_CF_TUNNEL_CREDENTIALS_FILE=/path/to/credentials.json"
        log "  Or pre-create secret: $ns/$secret_name"
        return 1
    else
        log "Using existing cloudflared credentials secret: $ns/$secret_name"
    fi

    local api_host admin_host chat_host auth_host
    api_host="${SYNESIS_CF_API_HOST:-$(oc get route synesis-api -n synesis-gateway -o jsonpath='{.spec.host}' 2>/dev/null || true)}"
    admin_host="${SYNESIS_CF_ADMIN_HOST:-$(oc get route synesis-admin -n synesis-admin -o jsonpath='{.spec.host}' 2>/dev/null || true)}"
    chat_host="${SYNESIS_CF_CHAT_HOST:-$(oc get route synesis-webui -n synesis-webui -o jsonpath='{.spec.host}' 2>/dev/null || true)}"
    auth_host="${SYNESIS_CF_AUTH_HOST:-$(oc get route synesis-auth -n synesis-auth -o jsonpath='{.spec.host}' 2>/dev/null || true)}"

    api_host="${api_host:-synesis-api.apps.openshiftdemo.dev}"
    admin_host="${admin_host:-synesis-admin.apps.openshiftdemo.dev}"
    chat_host="${chat_host:-synesis.apps.openshiftdemo.dev}"
    auth_host="${auth_host:-synesis-auth.apps.openshiftdemo.dev}"

    local cfg_tmp
    cfg_tmp="$(mktemp)"
    cat > "$cfg_tmp" <<EOF
tunnel: ${tunnel_name}
credentials-file: /etc/cloudflared/credentials/credentials.json
ingress:
  - hostname: ${api_host}
    service: http://litellm-proxy.synesis-gateway.svc.cluster.local:4000
  - hostname: ${admin_host}
    service: http://synesis-admin.synesis-admin.svc.cluster.local:8080
  - hostname: ${chat_host}
    service: http://open-webui.synesis-webui.svc.cluster.local:8080
  - hostname: ${auth_host}
    service: http://synesis-keycloak-service.synesis-auth.svc.cluster.local:8080
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

    # Patch admin deployment (only if value differs)
    _patch_deployment_env "$ns" "synesis-admin" "SYNESIS_ADMIN_DATABASE_URL" "$admin_url" "admin"

    # Patch planner deployment (explicit container — not always containers[0])
    _patch_deployment_env "synesis-planner" "synesis-planner" "SYNESIS_TRACE_DATABASE_URL" "$planner_url" "planner"

    _ensure_litellm_database "$ns" "$cluster_name" || true
    _upsert_litellm_database_secret "$litellm_url"
    _upsert_litellm_db_credentials

    log "  Admin DB wired: $svc_host/$db_name (user=$db_user)"
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

    local helm_args=(
        upgrade --install "$release_name"
        oci://ghcr.io/berriai/litellm-helm
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

# Post-apply version: re-patches deployments that were just created by
# kustomize apply and still have the placeholder password.
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

    _patch_deployment_env "$ns" "synesis-admin" "SYNESIS_ADMIN_DATABASE_URL" "$admin_url" "admin"
    _patch_deployment_env "synesis-planner" "synesis-planner" "SYNESIS_TRACE_DATABASE_URL" "$planner_url" "planner"
    _ensure_litellm_database "$ns" "$cluster_name" || true
    _upsert_litellm_database_secret "$litellm_url"
    _patch_deployment_env "synesis-yarn" "synesis-yarn" "SYNESIS_YARN_ADMIN_DB_URL" "$admin_url" "yarn"
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

    # Patch admin deployment with Keycloak issuer URL
    local kc_host
    kc_host=$(oc get route synesis-auth -n "$ns" -o jsonpath='{.spec.host}' 2>/dev/null || echo "synesis-auth.apps.openshiftdemo.dev")
    local issuer_url="https://${kc_host}/realms/synesis"
    _patch_deployment_env "synesis-admin" "synesis-admin" "SYNESIS_KEYCLOAK_ISSUER_URL" "$issuer_url" "admin"
    _patch_deployment_env "synesis-yarn" "synesis-yarn" "SYNESIS_YARN_KEYCLOAK_ISSUER_URL" "$issuer_url" "yarn"
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
# Spot-check the **admin UI** image (build-images.sh artifact "admin" → REGISTRY/admin:tag,
# kustomize: synesis-admin → …/synesis/admin) so we do not depend on manifest ordering.
# When REF is not "latest", we check the same tag we're about to deploy.
# -----------------------------------------------------------------------
check_custom_images() {
    log "Checking Synesis admin image availability (synesis-admin workload)..."
    local built
    built=$(kustomize build "$OVERLAY_DIR" 2>/dev/null)
    # sed regex replacement; ${var//} cannot express capture groups
    # shellcheck disable=SC2001
    [[ "$REF_SAFE" != "latest" ]] && built=$(echo "$built" | sed "s|ghcr.io/supernovae/synesis/\([^:]*\):latest|ghcr.io/supernovae/synesis/\\1:${REF_SAFE}|g")
    local sample_image
    # Must match overlays */kustomization synesis-admin → ghcr.io/.../synesis/admin (not synesis-admin as path).
    sample_image=$(echo "$built" | grep 'image:' | grep -E 'synesis/admin(:|@)' | head -1 \
        | sed 's/.*image: *//' | tr -d '"' | tr -d "'" | awk '{print $1}' || true)
    if [[ -z "$sample_image" ]]; then
        sample_image=$(echo "$built" | grep 'image:' | grep 'ghcr.io.*synesis' | head -1 \
            | sed 's/.*image: *//' | tr -d '"' | tr -d "'" | awk '{print $1}' || true)
    fi

    if [[ -z "$sample_image" ]]; then
        sample_image=$(echo "$built" | grep 'image:' | grep 'synesis-' | head -1 \
            | sed 's/.*image: *//' | tr -d '"' | tr -d "'" | awk '{print $1}' || true)
        if [[ -n "$sample_image" && "$sample_image" != *"/"* ]]; then
            log "WARNING: Custom images still use bare names (e.g., $sample_image)."
            log "  Kubernetes will try docker.io/library/$sample_image which does not exist."
            log "  Ensure the kustomize overlay has an 'images:' block with your registry."
            log "  See: overlays/$MODE/kustomization.yaml"
            log ""
        fi
        return
    fi

    if command -v skopeo &>/dev/null; then
        if ! skopeo inspect --no-tags "docker://$sample_image" &>/dev/null; then
            log "WARNING: skopeo cannot inspect $sample_image (missing image, network, or anonymous auth)."
            log "  Build/push the admin image (same name build-images uses: REGISTRY/admin:tag):"
            [[ "$REF_SAFE" != "latest" ]] && log "    ./scripts/build-images.sh --only admin --push --tag $REF_SAFE"
            log "    ./scripts/build-images.sh --only admin --push"
            log "  Private GHCR: skopeo needs registry login (e.g. podman login ghcr.io); the cluster still pulls via imagePullSecrets."
            log "  If the cluster already pulls this image, you can ignore this warning."
            log ""
        else
            log "  Image check OK ($sample_image)"
        fi
    else
        log "  Skipping image pull check (skopeo not installed)"
        log "  Sample image: $sample_image"
    fi
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
log "Reconciling LiteLLM / WebUI client secrets (post-apply)..."
reconcile_litellm_webui_secrets

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
SYNESIS_NAMESPACES=(synesis-gateway synesis-planner synesis-rag synesis-webui synesis-admin synesis-yarn synesis-models synesis-lsp synesis-sandbox synesis-search)

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
wait_for_deployment synesis-planner synesis-mcp
wait_for_deployment synesis-yarn synesis-yarn
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
