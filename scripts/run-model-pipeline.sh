#!/usr/bin/env bash
set -euo pipefail

# Synesis Model Pipeline Runner — models.yaml as source of truth.
#
# Downloads models to per-role PVCs via KFP pipeline. Handles deployment
# scale-down before PVC cleanup and scale-up after download completes.
#
# Usage:
#   ./scripts/run-model-pipeline.sh --profile=small          # all GPU models for small
#   ./scripts/run-model-pipeline.sh --profile=medium         # all GPU models for medium
#   ./scripts/run-model-pipeline.sh --role=router            # just router (uses default model)
#   ./scripts/run-model-pipeline.sh --role=coder --profile=large  # coder with large profile override
#   ./scripts/run-model-pipeline.sh --role=router --dry-run  # show what would happen
#
# Environment:
#   KFP_HOST       KFP API URL (auto-detected from DSPA if not set)
#   KFP_TOKEN      Auth token (defaults to oc whoami -t)
#   ECR_URI        Container registry for pipeline image (optional)
#   SYNESIS_NS     Model namespace (default: synesis-models)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MODELS_YAML="$PROJECT_ROOT/models.yaml"
NS="${SYNESIS_NS:-synesis-models}"

# Use project venv if available (has PyYAML); fall back to system python3
PYTHON="${PROJECT_ROOT}/.venv/bin/python3"
[[ -x "$PYTHON" ]] || PYTHON="python3"

PROFILE=""
ROLE=""
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --profile=*) PROFILE="${arg#--profile=}" ;;
        --role=*) ROLE="${arg#--role=}" ;;
        --dry-run) DRY_RUN=true ;;
        -h|--help)
            echo "Usage: $0 --profile=<small|medium|large> [--role=<role>] [--dry-run]"
            echo "       $0 --role=<router|general|coder|critic>"
            exit 0
            ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

if [[ -z "$PROFILE" && -z "$ROLE" ]]; then
    echo "ERROR: Specify --profile=<name> and/or --role=<name>"
    echo "Usage: $0 --profile=small | --role=router | --role=coder --profile=large"
    exit 1
fi

log() { echo "[$(date +'%H:%M:%S')] $*"; }
warn() { echo "[$(date +'%H:%M:%S')] WARN: $*" >&2; }

# Use Python to parse models.yaml and produce role configs as shell-friendly output.
resolve_roles() {
    "$PYTHON" - "$MODELS_YAML" "$PROFILE" "$ROLE" <<'PYEOF'
import sys
import yaml

models_path, profile_name, single_role = sys.argv[1], sys.argv[2], sys.argv[3]

with open(models_path) as f:
    config = yaml.safe_load(f)

roles = config.get("roles", {})
profiles = config.get("profiles", {})

# Determine which roles to process
gpu_roles = ["router", "general", "coder", "critic"]

if single_role:
    if single_role not in roles:
        print(f"ERROR: Unknown role '{single_role}'. Available: {', '.join(roles.keys())}", file=sys.stderr)
        sys.exit(1)
    target_roles = [single_role]
else:
    target_roles = gpu_roles

# Get profile assignments if specified
assignments = {}
if profile_name:
    if profile_name not in profiles:
        print(f"ERROR: Unknown profile '{profile_name}'. Available: {', '.join(profiles.keys())}", file=sys.stderr)
        sys.exit(1)
    assignments = profiles[profile_name].get("assignments", {})

for role_name in target_roles:
    role_def = roles.get(role_name, {})
    assignment = assignments.get(role_name, {})

    # Skip roles not in profile (no device/quant configured)
    if profile_name and not single_role:
        if not assignment.get("device") and not assignment.get("quant") and not assignment.get("model_override"):
            if assignment.get("notes"):
                continue
            continue

    # Skip summarizer (no PVC, uses KServe hf:// download)
    if role_name == "summarizer":
        continue

    # Skip roles sharing another role's model (e.g. small critic shares router)
    if assignment.get("shared_with"):
        continue

    pvc_name = role_def.get("pvc_name", "")
    if not pvc_name:
        continue

    model_repo = assignment.get("model_override") or role_def.get("default_model", "")
    pvc_subpath = role_def.get("pvc_subpath", f"{role_name}-model")
    deployment_name = role_def.get("deployment_name", f"synesis-{role_name}")

    # Output as KEY=VALUE lines, one role block per separator
    print(f"ROLE={role_name}")
    print(f"MODEL_REPO={model_repo}")
    print(f"PVC_NAME={pvc_name}")
    print(f"PVC_SUBPATH={pvc_subpath}")
    print(f"DEPLOYMENT_NAME={deployment_name}")
    print("---")
PYEOF
}

ensure_pvc() {
    local pvc_name="$1"
    if oc get pvc "$pvc_name" -n "$NS" &>/dev/null; then
        log "  PVC $pvc_name exists"
    else
        log "  Creating PVC $pvc_name..."
        local manifest_file="$PROJECT_ROOT/pipelines/manifests/${pvc_name}-pvc.yaml"
        if [[ -f "$manifest_file" ]]; then
            oc apply -f "$manifest_file"
        else
            log "  ERROR: PVC manifest not found: $manifest_file"
            log "  Ensure efs-sc StorageClass exists and apply: oc apply -f pipelines/manifests/synesis-models-efs-pvc.yaml"
            exit 1
        fi
    fi
}

scale_down() {
    local deploy="$1"
    if oc get deployment "$deploy" -n "$NS" &>/dev/null; then
        ORIGINAL_REPLICAS=$(oc get deployment "$deploy" -n "$NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")
        if [[ "$ORIGINAL_REPLICAS" != "0" ]]; then
            log "  Scaling down $deploy (replicas=$ORIGINAL_REPLICAS -> 0)..."
            oc scale deployment "$deploy" -n "$NS" --replicas=0
            oc rollout status deployment/"$deploy" -n "$NS" --timeout=120s 2>/dev/null || sleep 10
        else
            log "  $deploy already at 0 replicas"
        fi
    else
        warn "  Deployment $deploy not found (first deploy? will create after pipeline)"
        ORIGINAL_REPLICAS="1"
    fi
}

scale_up() {
    local deploy="$1" replicas="${2:-1}"
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
    local model_repo="$1" pvc_name="$2" pvc_subpath="$3"
    log "  Submitting KFP pipeline: model=$model_repo pvc=$pvc_name subpath=$pvc_subpath"

    if command -v uv &>/dev/null; then
        uv run --with "kfp[kubernetes]" --project "$PROJECT_ROOT" python3 - \
            "$model_repo" "$pvc_name" "$pvc_subpath" "$PROJECT_ROOT" <<'PYEOF'
import os
import subprocess
import sys

model_repo, pvc_name, pvc_subpath, project_root = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

# Compile the unified pipeline
script = os.path.join(project_root, "pipelines", "model_pipeline.py")
subprocess.run([sys.executable, script], check=True, cwd=project_root, env=os.environ)

yaml_path = script.replace(".py", ".yaml")

# Discover KFP host
host = os.environ.get("KFP_HOST", "")
if not host:
    import shutil
    if shutil.which("oc"):
        for ns in ("synesis", "synesis-models"):
            r = subprocess.run(
                ["oc", "get", "dspa", "-n", ns, "-o",
                 "jsonpath={.items[0].status.components.apiServer.externalUrl}"],
                capture_output=True, text=True, check=False)
            if r.returncode == 0 and r.stdout.strip():
                host = r.stdout.strip()
                break
            r = subprocess.run(
                ["oc", "get", "route", "-n", ns, "-o", "jsonpath={.items[0].spec.host}"],
                capture_output=True, text=True, check=False)
            if r.returncode == 0 and r.stdout.strip():
                host = f"https://{r.stdout.strip()}"
                break
if not host:
    print("ERROR: Set KFP_HOST or ensure DSPA route is accessible", file=sys.stderr)
    sys.exit(1)

# Get token
token = os.environ.get("KFP_TOKEN", "")
if not token:
    r = subprocess.run(["oc", "whoami", "-t"], capture_output=True, text=True, check=False, timeout=5)
    if r.returncode == 0:
        token = r.stdout.strip()

from kfp import client
c = client.Client(host=host, existing_token=token or None, namespace="synesis-models")
run = c.create_run_from_pipeline_package(
    yaml_path,
    arguments={
        "model_repo": model_repo,
        "pvc_name": pvc_name,
        "pvc_subpath": pvc_subpath,
    },
)
print(f"Run ID: {run.run_id}")
print(f"URL: {host}/#/runs/details/{run.run_id}")
PYEOF
    else
        "$PYTHON" - "$model_repo" "$pvc_name" "$pvc_subpath" "$PROJECT_ROOT" <<'PYEOF'
import os, subprocess, sys
model_repo, pvc_name, pvc_subpath, project_root = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
script = os.path.join(project_root, "pipelines", "model_pipeline.py")
subprocess.run([sys.executable, script], check=True, cwd=project_root, env=os.environ)
yaml_path = script.replace(".py", ".yaml")
host = os.environ.get("KFP_HOST", "")
if not host:
    print("ERROR: Set KFP_HOST", file=sys.stderr); sys.exit(1)
token = os.environ.get("KFP_TOKEN", "")
if not token:
    r = subprocess.run(["oc", "whoami", "-t"], capture_output=True, text=True, check=False, timeout=5)
    if r.returncode == 0: token = r.stdout.strip()
from kfp import client
c = client.Client(host=host, existing_token=token or None, namespace="synesis-models")
run = c.create_run_from_pipeline_package(yaml_path, arguments={"model_repo": model_repo, "pvc_name": pvc_name, "pvc_subpath": pvc_subpath})
print(f"Run ID: {run.run_id}"); print(f"URL: {host}/#/runs/details/{run.run_id}")
PYEOF
    fi
}

# -----------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------
log "=== Synesis Model Pipeline ==="
[[ -n "$PROFILE" ]] && log "Profile: $PROFILE"
[[ -n "$ROLE" ]] && log "Role: $ROLE"
log ""

# Ensure namespace exists
oc create namespace "$NS" 2>/dev/null || true

# Ensure shared EFS PVC exists (single PVC for all models)
ensure_pvc "synesis-models-efs"

# Resolve roles from models.yaml
ROLE_CONFIGS=$(resolve_roles)
if [[ -z "$ROLE_CONFIGS" ]]; then
    log "No roles to deploy for the given profile/role."
    exit 0
fi

# Process each role
ORIGINAL_REPLICAS="1"
echo "$ROLE_CONFIGS" | while IFS= read -r line; do
    case "$line" in
        ROLE=*) CURRENT_ROLE="${line#ROLE=}" ;;
        MODEL_REPO=*) CURRENT_MODEL="${line#MODEL_REPO=}" ;;
        PVC_NAME=*) CURRENT_PVC="${line#PVC_NAME=}" ;;
        PVC_SUBPATH=*) CURRENT_SUBPATH="${line#PVC_SUBPATH=}" ;;
        DEPLOYMENT_NAME=*) CURRENT_DEPLOY="${line#DEPLOYMENT_NAME=}" ;;
        ---)
            log ""
            log "--- Deploying $CURRENT_ROLE: $CURRENT_MODEL ---"
            log "  PVC: $CURRENT_PVC, subpath: $CURRENT_SUBPATH"
            log "  Deployment: $CURRENT_DEPLOY"

            if [[ "$DRY_RUN" == "true" ]]; then
                log "  [DRY RUN] Would: scale down, run pipeline, scale up"
                continue
            fi

            scale_down "$CURRENT_DEPLOY"
            run_pipeline_for_role "$CURRENT_MODEL" "$CURRENT_PVC" "$CURRENT_SUBPATH"
            scale_up "$CURRENT_DEPLOY" "${ORIGINAL_REPLICAS:-1}"

            log "  $CURRENT_ROLE complete"
            ;;
    esac
done

log ""
log "=== All models deployed ==="
