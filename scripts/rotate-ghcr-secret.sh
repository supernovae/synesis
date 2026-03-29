#!/usr/bin/env bash
set -euo pipefail

# Rotate the GHCR pull secret across all Synesis namespaces.
#
# Usage:
#   ./scripts/rotate-ghcr-secret.sh                    # interactive prompt
#   GITHUB_TOKEN=ghp_... ./scripts/rotate-ghcr-secret.sh   # non-interactive
#   ./scripts/rotate-ghcr-secret.sh --dry-run          # preview only
#
# The script discovers every namespace labelled app.kubernetes.io/part-of=synesis,
# replaces or creates `ghcr-pull-secret`, links it to the `default` SA, and
# optionally triggers a rollout restart on deployments still in ImagePullBackOff.

SECRET_NAME="ghcr-pull-secret"
DRY_RUN=false
RESTART=false

for arg in "$@"; do
    case "$arg" in
        --dry-run)  DRY_RUN=true ;;
        --restart)  RESTART=true ;;
        --help|-h)
            echo "Usage: $0 [--dry-run] [--restart]"
            echo ""
            echo "Rotates ghcr-pull-secret in every synesis-* namespace."
            echo ""
            echo "Options:"
            echo "  --dry-run   Show what would happen without making changes"
            echo "  --restart   Rollout-restart deployments with ImagePullBackOff pods"
            echo ""
            echo "Environment:"
            echo "  GITHUB_USERNAME / GITHUB_USER  GitHub username (default: supernovae)"
            echo "  GITHUB_TOKEN                   PAT with read:packages scope"
            exit 0
            ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

log()  { echo "[$(date +'%H:%M:%S')] $*"; }
warn() { echo "[$(date +'%H:%M:%S')] WARN: $*" >&2; }
err()  { echo "[$(date +'%H:%M:%S')] ERROR: $*" >&2; }

if ! oc whoami &>/dev/null; then
    err "Not logged into an OpenShift cluster. Run 'oc login' first."
    exit 1
fi

GH_USER="${GITHUB_USERNAME:-${GITHUB_USER:-supernovae}}"
GH_TOKEN="${GITHUB_TOKEN:-}"

if [[ -z "$GH_TOKEN" ]]; then
    if [[ ! -t 0 ]]; then
        err "No GITHUB_TOKEN set and stdin is not a terminal. Cannot prompt."
        exit 1
    fi
    echo ""
    echo "  This PAT needs the read:packages scope."
    echo "  Create one at: https://github.com/settings/tokens/new?scopes=read:packages"
    echo ""
    read -rp  "  GitHub username [${GH_USER}]: " input_user
    [[ -n "$input_user" ]] && GH_USER="$input_user"
    read -rsp "  GitHub PAT (read:packages): " GH_TOKEN && echo ""
    if [[ -z "$GH_TOKEN" ]]; then
        err "Token cannot be empty."
        exit 1
    fi
fi

NAMESPACES=()
while IFS= read -r ns; do
    [[ -n "$ns" ]] && NAMESPACES+=("$ns")
done < <(oc get ns -l app.kubernetes.io/part-of=synesis \
    --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null)

if [[ ${#NAMESPACES[@]} -eq 0 ]]; then
    err "No namespaces with label app.kubernetes.io/part-of=synesis found."
    exit 1
fi

log "Rotating $SECRET_NAME for user=$GH_USER across ${#NAMESPACES[@]} namespaces"
[[ "$DRY_RUN" == "true" ]] && log "(dry-run — no changes will be made)"
echo ""

for ns in "${NAMESPACES[@]}"; do
    if [[ "$DRY_RUN" == "true" ]]; then
        log "  [dry-run] would update $ns/$SECRET_NAME"
        continue
    fi

    oc create secret docker-registry "$SECRET_NAME" \
        --docker-server=ghcr.io \
        --docker-username="$GH_USER" \
        --docker-password="$GH_TOKEN" \
        -n "$ns" \
        --dry-run=client -o yaml | oc apply -f - >/dev/null 2>&1

    oc secrets link default "$SECRET_NAME" --for=pull -n "$ns" 2>/dev/null || true

    log "  $ns — updated"
done

echo ""
log "Secret rotation complete."

if [[ "$RESTART" == "true" && "$DRY_RUN" != "true" ]]; then
    log ""
    log "Checking for deployments with ImagePullBackOff pods..."
    for ns in "${NAMESPACES[@]}"; do
        while IFS= read -r dep; do
            [[ -z "$dep" ]] && continue
            backoff=$(oc get pods -n "$ns" -l "app.kubernetes.io/name=$dep" \
                -o jsonpath='{.items[?(@.status.containerStatuses[0].state.waiting.reason=="ImagePullBackOff")].metadata.name}' 2>/dev/null || true)
            if [[ -n "$backoff" ]]; then
                log "  Restarting $ns/$dep (pods in ImagePullBackOff)"
                oc rollout restart deployment/"$dep" -n "$ns"
            fi
        done < <(oc get deployments -n "$ns" --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null)
    done
    log "Done. Watch rollout with: oc get pods -n <namespace> -w"
else
    log ""
    log "Tip: run with --restart to rollout-restart any deployments stuck on ImagePullBackOff."
    log "Or manually:  oc rollout restart deployment/<name> -n <namespace>"
fi
