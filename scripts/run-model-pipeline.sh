#!/usr/bin/env bash
set -euo pipefail

# Synesis Model Pipeline Runner — DB-first model registry.
#
# Downloads one model repository to a PVC subpath through the unified KFP
# pipeline. The script no longer reads models.yaml.
#
# Usage:
#   ./scripts/run-model-pipeline.sh --role=router --model-repo=<hf-repo>
#   ./scripts/run-model-pipeline.sh --role=coder --model-repo=<hf-repo> --dry-run
#
# Environment:
#   KFP_HOST       KFP API URL (auto-detected from DSPA if not set)
#   KFP_TOKEN      Auth token (defaults to oc whoami -t)
#   SYNESIS_NS     Model namespace (default: synesis-models)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
NS="${SYNESIS_NS:-synesis-models}"

ROLE=""
MODEL_REPO=""
PVC_NAME="synesis-models-efs"
PVC_SUBPATH=""
DEPLOYMENT_NAME=""
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --role=*) ROLE="${arg#--role=}" ;;
        --model-repo=*) MODEL_REPO="${arg#--model-repo=}" ;;
        --pvc-name=*) PVC_NAME="${arg#--pvc-name=}" ;;
        --pvc-subpath=*) PVC_SUBPATH="${arg#--pvc-subpath=}" ;;
        --deployment-name=*) DEPLOYMENT_NAME="${arg#--deployment-name=}" ;;
        --namespace=*) NS="${arg#--namespace=}" ;;
        --dry-run) DRY_RUN=true ;;
        -h|--help)
            echo "Usage: $0 --role=<router|general|coder|critic|summarizer|custom> --model-repo=<hf-repo> [options]"
            echo "Options:"
            echo "  --pvc-name=<name>          PVC name (default: synesis-models-efs)"
            echo "  --pvc-subpath=<subpath>    PVC subpath (default: <role>-model)"
            echo "  --deployment-name=<name>   Deployment to scale during update (default: synesis-<role>)"
            echo "  --namespace=<ns>           Namespace (default: synesis-models)"
            echo "  --dry-run                  Print actions without executing"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg"
            exit 1
            ;;
    esac
done

if [[ -z "$ROLE" ]]; then
    echo "ERROR: --role is required"
    exit 1
fi
if [[ -z "$MODEL_REPO" ]]; then
    echo "ERROR: --model-repo is required"
    exit 1
fi
if [[ -z "$PVC_SUBPATH" ]]; then
    PVC_SUBPATH="${ROLE}-model"
fi
if [[ -z "$DEPLOYMENT_NAME" ]]; then
    DEPLOYMENT_NAME="synesis-${ROLE}"
fi

log() { echo "[$(date +'%H:%M:%S')] $*"; }
warn() { echo "[$(date +'%H:%M:%S')] WARN: $*" >&2; }

ensure_pvc() {
    local pvc_name="$1"
    if oc get pvc "$pvc_name" -n "$NS" &>/dev/null; then
        log "  PVC $pvc_name exists"
        return
    fi

    local manifest_file="$PROJECT_ROOT/pipelines/manifests/${pvc_name}-pvc.yaml"
    if [[ -f "$manifest_file" ]]; then
        log "  Creating PVC $pvc_name from $manifest_file..."
        oc apply -f "$manifest_file"
        return
    fi

    log "  ERROR: PVC $pvc_name not found and no manifest exists at $manifest_file"
    log "  Provide --pvc-name with an existing claim or create the PVC first."
    exit 1
}

ORIGINAL_REPLICAS="1"
scale_down() {
    local deploy="$1"
    if oc get deployment "$deploy" -n "$NS" &>/dev/null; then
        ORIGINAL_REPLICAS="$(oc get deployment "$deploy" -n "$NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")"
        if [[ "$ORIGINAL_REPLICAS" != "0" ]]; then
            log "  Scaling down $deploy (replicas=$ORIGINAL_REPLICAS -> 0)..."
            oc scale deployment "$deploy" -n "$NS" --replicas=0
            oc rollout status deployment/"$deploy" -n "$NS" --timeout=120s 2>/dev/null || sleep 10
        else
            log "  $deploy already at 0 replicas"
        fi
    else
        warn "  Deployment $deploy not found; continuing without scale-down"
        ORIGINAL_REPLICAS="1"
    fi
}

scale_up() {
    local deploy="$1"
    local replicas="${2:-1}"
    if oc get deployment "$deploy" -n "$NS" &>/dev/null; then
        log "  Scaling up $deploy (replicas=$replicas)..."
        oc scale deployment "$deploy" -n "$NS" --replicas="$replicas"
        log "  Waiting for rollout..."
        oc rollout status deployment/"$deploy" -n "$NS" --timeout=600s || {
            warn "  Rollout timeout for $deploy — model may still be loading"
        }
    else
        warn "  Deployment $deploy not found — apply manifests with deploy.sh"
    fi
}

run_pipeline_for_role() {
    local model_repo="$1"
    local pvc_name="$2"
    local pvc_subpath="$3"
    local namespace="$4"
    log "  Submitting KFP pipeline: model=$model_repo pvc=$pvc_name subpath=$pvc_subpath ns=$namespace"

    if command -v uv &>/dev/null; then
        uv run --with "kfp[kubernetes]" --project "$PROJECT_ROOT" python3 - \
            "$model_repo" "$pvc_name" "$pvc_subpath" "$PROJECT_ROOT" "$namespace" <<'PYEOF'
import os
import subprocess
import sys

model_repo, pvc_name, pvc_subpath, project_root, namespace = sys.argv[1:6]
script = os.path.join(project_root, "pipelines", "model_pipeline.py")
subprocess.run([sys.executable, script], check=True, cwd=project_root, env=os.environ)
yaml_path = script.replace(".py", ".yaml")

host = os.environ.get("KFP_HOST", "")
if not host:
    import shutil

    if shutil.which("oc"):
        for ns in (namespace, "synesis"):
            r = subprocess.run(
                ["oc", "get", "dspa", "-n", ns, "-o", "jsonpath={.items[0].status.components.apiServer.externalUrl}"],
                capture_output=True,
                text=True,
                check=False,
            )
            if r.returncode == 0 and r.stdout.strip():
                host = r.stdout.strip()
                break
            r = subprocess.run(
                ["oc", "get", "route", "-n", ns, "-o", "jsonpath={.items[0].spec.host}"],
                capture_output=True,
                text=True,
                check=False,
            )
            if r.returncode == 0 and r.stdout.strip():
                host = f"https://{r.stdout.strip()}"
                break

if not host:
    print("ERROR: Set KFP_HOST or ensure DSPA/route is accessible", file=sys.stderr)
    sys.exit(1)

token = os.environ.get("KFP_TOKEN", "")
if not token:
    r = subprocess.run(["oc", "whoami", "-t"], capture_output=True, text=True, check=False, timeout=5)
    if r.returncode == 0:
        token = r.stdout.strip()

from kfp import client

c = client.Client(host=host, existing_token=token or None, namespace=namespace)
run = c.create_run_from_pipeline_package(
    yaml_path,
    arguments={"model_repo": model_repo, "pvc_name": pvc_name, "pvc_subpath": pvc_subpath},
)
print(f"Run ID: {run.run_id}")
print(f"URL: {host}/#/runs/details/{run.run_id}")
PYEOF
    else
        echo "ERROR: uv is required to run the model pipeline helper"
        exit 1
    fi
}

log "=== Synesis Model Pipeline ==="
log "Role: $ROLE"
log "Model repo: $MODEL_REPO"
log "PVC: $PVC_NAME / $PVC_SUBPATH"
log "Deployment: $DEPLOYMENT_NAME"
log "Namespace: $NS"
log ""

if [[ "$DRY_RUN" == "true" ]]; then
    log "[DRY RUN] Would ensure namespace/PVC, scale deployment, run KFP pipeline, and scale deployment back."
    exit 0
fi

oc create namespace "$NS" 2>/dev/null || true
ensure_pvc "$PVC_NAME"
scale_down "$DEPLOYMENT_NAME"
run_pipeline_for_role "$MODEL_REPO" "$PVC_NAME" "$PVC_SUBPATH" "$NS"
scale_up "$DEPLOYMENT_NAME" "${ORIGINAL_REPLICAS:-1}"

log ""
log "=== Model deployment workflow complete ==="
