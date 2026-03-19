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
#
# Examples:
#   ./scripts/deploy.sh api                     # default — API providers, latest images
#   ./scripts/deploy.sh api v1.2.0              # API providers, release tag
#   ./scripts/deploy.sh model                   # self-hosted GPU inference
#   SYNESIS_REF=pr-456 ./scripts/deploy.sh api  # deploy PR branch images

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
    local existing_key=""

    oc create namespace "$ns" 2>/dev/null || true

    if oc get secret "$secret_name" -n "$ns" &>/dev/null; then
        existing_key=$(oc get secret "$secret_name" -n "$ns" \
            -o jsonpath='{.data.master-key}' 2>/dev/null | base64 -d 2>/dev/null || true)
    fi

    if [[ -z "$existing_key" ]] || [[ "$existing_key" == "sk-synesis-change-me" ]]; then
        LITELLM_KEY="sk-synesis-$(openssl rand -hex 24)"
        log "Generating LiteLLM API key..."

        oc create secret generic "$secret_name" \
            -n "$ns" \
            --from-literal=master-key="$LITELLM_KEY" \
            --dry-run=client -o yaml | oc apply -f -

        log "  Key stored in secret $ns/$secret_name"
    else
        LITELLM_KEY="$existing_key"
        log "LiteLLM API key already exists in $ns/$secret_name"
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

    if [[ -n "$key" ]] && [[ "$key" != "sk-or-v1-REPLACE_ME" ]]; then
        return 0
    fi

    log ""
    log "OPENROUTER_API_KEY missing in $ns/$secret_name — LiteLLM will return 401 from OpenRouter."
    log "  Re-running provider key setup..."
    ensure_openrouter_key

    if oc get deployment litellm-proxy -n "$ns" &>/dev/null; then
        log "  Restarting litellm-proxy to reload envFrom..."
        oc rollout restart deployment/litellm-proxy -n "$ns" 2>/dev/null || true
    fi
}

# Heal litellm-secrets / webui-api-key if an older release applied placeholder
# Secrets from kustomize (now removed) and clobbered real keys.
reconcile_litellm_webui_secrets() {
    local gw="synesis-gateway"
    local wu="synesis-webui"
    local mk="" wk="" changed="false"

    oc create namespace "$gw" 2>/dev/null || true
    oc create namespace "$wu" 2>/dev/null || true

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

    if [[ -n "$mk" ]] && [[ "$mk" != "sk-synesis-change-me" ]]; then
        if [[ "$wk" != "$mk" ]] || [[ -z "$wk" ]] || [[ "$wk" == "sk-synesis-change-me" ]]; then
            oc create secret generic webui-api-key \
                -n "$wu" \
                --from-literal=api-key="$mk" \
                --dry-run=client -o yaml | oc apply -f -
            log "  Synced webui-api-key from litellm-secrets (was missing or out of date)"
            changed="true"
        fi
    elif [[ -n "$wk" ]] && [[ "$wk" != "sk-synesis-change-me" ]]; then
        oc create secret generic litellm-secrets \
            -n "$gw" \
            --from-literal=master-key="$wk" \
            --dry-run=client -o yaml | oc apply -f -
        log "  Restored litellm-secrets from existing webui-api-key"
    else
        local newk="sk-synesis-$(openssl rand -hex 24)"
        oc create secret generic litellm-secrets \
            -n "$gw" \
            --from-literal=master-key="$newk" \
            --dry-run=client -o yaml | oc apply -f -
        oc create secret generic webui-api-key \
            -n "$wu" \
            --from-literal=api-key="$newk" \
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

    # Patch admin deployment (only if value differs)
    _patch_deployment_env "$ns" "synesis-admin" "SYNESIS_ADMIN_DATABASE_URL" "$admin_url" "admin"

    # Patch planner deployment (explicit container — not always containers[0])
    _patch_deployment_env "synesis-planner" "synesis-planner" "SYNESIS_TRACE_DATABASE_URL" "$planner_url" "planner"

    log "  Admin DB wired: $svc_host/$db_name (user=$db_user)"
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

    _patch_deployment_env "$ns" "synesis-admin" "SYNESIS_ADMIN_DATABASE_URL" "$admin_url" "admin"
    _patch_deployment_env "synesis-planner" "synesis-planner" "SYNESIS_TRACE_DATABASE_URL" "$planner_url" "planner"
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
log ""

ensure_litellm_key
ensure_webui_key

if [[ "$MODE" == "api" ]]; then
    ensure_openrouter_key
fi

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
log "Setting up admin ConfigMaps..."
ensure_admin_configmaps

log ""
log "Setting up admin Postgres..."
ensure_admin_db

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
# Spot-check one image from the kustomize output to catch the common
# mistake of deploying before building/pushing images.
# When REF is not "latest", we check the same tag we're about to deploy.
# -----------------------------------------------------------------------
check_custom_images() {
    log "Checking custom image availability..."
    local built
    built=$(kustomize build "$OVERLAY_DIR" 2>/dev/null)
    [[ "$REF_SAFE" != "latest" ]] && built=$(echo "$built" | sed "s|ghcr.io/supernovae/synesis/\([^:]*\):latest|ghcr.io/supernovae/synesis/\\1:${REF_SAFE}|g")
    local sample_image
    sample_image=$(echo "$built" | grep 'image:' | grep 'ghcr.io.*synesis' | head -1 \
        | sed 's/.*image: *//' | tr -d '"' | tr -d "'" || true)

    if [[ -z "$sample_image" ]]; then
        sample_image=$(echo "$built" | grep 'image:' | grep 'synesis-' | head -1 \
            | sed 's/.*image: *//' | tr -d '"' | tr -d "'" || true)
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
            log "WARNING: Cannot reach image $sample_image"
            log "  Build and push images first:"
            [[ "$REF_SAFE" != "latest" ]] && log "    ./scripts/build-images.sh --push --tag $REF_SAFE"
            log "    ./scripts/build-images.sh --push"
            log "  If the repo is private, create a pull secret in each namespace."
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
log "Reconciling LiteLLM / WebUI client secrets (post-apply)..."
reconcile_litellm_webui_secrets

# -----------------------------------------------------------------------
# Keep Deployments and ReplicaSets under control (idempotent, less cruft).
# - Set revisionHistoryLimit=2 on Synesis Deployments so new rollouts don't pile up.
# - Delete old ReplicaSets with 0 replicas so failed or superseded rollouts don't linger.
# -----------------------------------------------------------------------
SYNESIS_NAMESPACES=(synesis-gateway synesis-planner synesis-rag synesis-webui synesis-admin synesis-models synesis-lsp synesis-sandbox synesis-search)

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
    _patch_configmap_hash synesis-gateway  litellm-proxy  litellm-config
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

wait_for_deployment synesis-gateway litellm-proxy
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
wait_for_deployment synesis-rag embedder
wait_for_deployment synesis-rag keyword-service
wait_for_deployment synesis-rag gliner-service
wait_for_deployment synesis-search searxng
wait_for_deployment synesis-admin synesis-admin
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
    log "  Configure model endpoints via Admin UI or overlays/api/litellm-config-openrouter.yaml"
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

log ""
log "============================================================"
log "  API endpoint:  https://$ROUTE_HOST"
log "  API key:       $LITELLM_KEY"
log "  Web UI:        https://$WEBUI_HOST"
log "  Admin UI:      https://$ADMIN_HOST"
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
log "Next: deploy the indexer queue CronJob (after Milvus is healthy):"
log "  ./scripts/deploy-indexer.sh"
log "  ./scripts/deploy-indexer.sh --run   # process pending items now"
log ""
log "Open WebUI (SSO via Keycloak):"
log "  Browse to https://$WEBUI_HOST"
log "  Click 'Sign in with Keycloak' to register or log in."
log "  Models are pre-configured -- select 'synesis-agent' to start."
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
