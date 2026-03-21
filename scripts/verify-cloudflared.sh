#!/usr/bin/env bash
set -euo pipefail

# Verify cloudflared tunnel deployment and config in-cluster.
#
# Usage:
#   ./scripts/verify-cloudflared.sh
#   ./scripts/verify-cloudflared.sh --namespace synesis-edge
#   ./scripts/verify-cloudflared.sh --check-hosts

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

NAMESPACE="synesis-edge"
DEPLOYMENT="cloudflared"
SECRET_NAME="cloudflared-credentials"
CONFIGMAP_NAME="cloudflared-config"
CHECK_HOSTS=false

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }
warn() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $*" >&2; }
err() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2; }

usage() {
    cat <<EOF
Usage: $0 [--namespace <ns>] [--check-hosts]

Options:
  --namespace <ns>   Namespace where cloudflared runs (default: synesis-edge)
  --check-hosts      Validate tunnel hostnames match current OpenShift Routes
  -h, --help         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --namespace)
            NAMESPACE="${2:-}"
            [[ -n "$NAMESPACE" ]] || { err "--namespace requires a value"; exit 1; }
            shift 2
            ;;
        --check-hosts)
            CHECK_HOSTS=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            err "Unknown arg: $1"
            usage
            exit 1
            ;;
    esac
done

log "=== Verify cloudflared tunnel ==="
log "Namespace: $NAMESPACE"

if ! oc get namespace "$NAMESPACE" >/dev/null 2>&1; then
    err "Namespace not found: $NAMESPACE"
    exit 1
fi

if ! oc get secret "$SECRET_NAME" -n "$NAMESPACE" >/dev/null 2>&1; then
    err "Missing secret: $NAMESPACE/$SECRET_NAME"
    exit 1
fi
log "Secret exists: $SECRET_NAME"

if ! oc get configmap "$CONFIGMAP_NAME" -n "$NAMESPACE" >/dev/null 2>&1; then
    err "Missing configmap: $NAMESPACE/$CONFIGMAP_NAME"
    exit 1
fi
log "ConfigMap exists: $CONFIGMAP_NAME"

if ! oc get deployment "$DEPLOYMENT" -n "$NAMESPACE" >/dev/null 2>&1; then
    err "Missing deployment: $NAMESPACE/$DEPLOYMENT"
    exit 1
fi
log "Deployment exists: $DEPLOYMENT"

log "Checking rollout status..."
if ! oc rollout status deployment/"$DEPLOYMENT" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1; then
    warn "Deployment rollout not healthy within timeout"
    oc get deployment "$DEPLOYMENT" -n "$NAMESPACE" -o wide || true
else
    log "Deployment rollout is healthy"
fi

PODS_RUNNING=$(oc get pods -n "$NAMESPACE" -l app.kubernetes.io/name=cloudflared --no-headers 2>/dev/null | awk '$3=="Running"{c++} END{print c+0}')
if [[ "${PODS_RUNNING:-0}" -lt 1 ]]; then
    err "No running cloudflared pods found"
    oc get pods -n "$NAMESPACE" -l app.kubernetes.io/name=cloudflared -o wide || true
    exit 1
fi
log "Running pods: $PODS_RUNNING"

CFG="$(oc get configmap "$CONFIGMAP_NAME" -n "$NAMESPACE" -o jsonpath='{.data.config\.yaml}' 2>/dev/null || true)"
if [[ -z "$CFG" ]]; then
    err "ConfigMap $CONFIGMAP_NAME has empty config.yaml"
    exit 1
fi

if ! printf '%s\n' "$CFG" | awk '/^ingress:/{found=1} END{exit(found?0:1)}'; then
    err "config.yaml missing ingress block"
    exit 1
fi
if ! printf '%s\n' "$CFG" | awk '/http_status:404/{found=1} END{exit(found?0:1)}'; then
    warn "Fallback rule (http_status:404) not found"
else
    log "Fallback rule present"
fi

if $CHECK_HOSTS; then
    log "Checking configured hostnames against OpenShift routes..."
    API_ROUTE="$(oc get route synesis-api -n synesis-gateway -o jsonpath='{.spec.host}' 2>/dev/null || true)"
    ADMIN_ROUTE="$(oc get route synesis-admin -n synesis-admin -o jsonpath='{.spec.host}' 2>/dev/null || true)"
    CHAT_ROUTE="$(oc get route synesis-webui -n synesis-webui -o jsonpath='{.spec.host}' 2>/dev/null || true)"
    AUTH_ROUTE="$(oc get route synesis-auth -n synesis-auth -o jsonpath='{.spec.host}' 2>/dev/null || true)"

    check_host() {
        local label="$1" expected="$2"
        [[ -n "$expected" ]] || { warn "$label route not found"; return 0; }
        if printf '%s\n' "$CFG" | awk -v h="$expected" '$0 ~ ("hostname: " h){ok=1} END{exit(ok?0:1)}'; then
            log "$label hostname found in tunnel config: $expected"
        else
            warn "$label hostname missing from tunnel config: $expected"
        fi
    }

    check_host "API" "$API_ROUTE"
    check_host "Admin" "$ADMIN_ROUTE"
    check_host "Chat" "$CHAT_ROUTE"
    check_host "Auth" "$AUTH_ROUTE"
fi

log "Recent cloudflared logs:"
oc logs -n "$NAMESPACE" deployment/"$DEPLOYMENT" --tail=40 || true

log "Verification complete."
