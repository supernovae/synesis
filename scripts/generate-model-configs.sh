#!/usr/bin/env bash
set -euo pipefail

# Synesis Model Config Generator
#
# Reads models.yaml for a given profile and validates that all deployment
# YAMLs, LiteLLM config, and planner env vars are consistent.
#
# Usage:
#   ./scripts/generate-model-configs.sh --profile=small [--dry-run] [--validate-only]
#
# Modes:
#   (default)       Print generated env vars and validate consistency
#   --validate-only Check models.yaml against deployed manifests
#   --dry-run       Show what would change without writing files

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

PROFILE=""
DRY_RUN=false
VALIDATE_ONLY=false

for arg in "$@"; do
    case "$arg" in
        --profile=*) PROFILE="${arg#--profile=}" ;;
        --dry-run) DRY_RUN=true ;;
        --validate-only) VALIDATE_ONLY=true ;;
        -h|--help)
            echo "Usage: $0 --profile=<small|medium|large> [--dry-run] [--validate-only]"
            exit 0
            ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

if [[ -z "$PROFILE" ]]; then
    echo "ERROR: --profile is required (small, medium, large)"
    echo "Usage: $0 --profile=<small|medium|large>"
    exit 1
fi

MODELS_YAML="$PROJECT_ROOT/models.yaml"

# Use project venv if available (has PyYAML); fall back to system python3
PYTHON="${PROJECT_ROOT}/.venv/bin/python3"
[[ -x "$PYTHON" ]] || PYTHON="python3"

if [[ ! -f "$MODELS_YAML" ]]; then
    echo "ERROR: models.yaml not found at $MODELS_YAML"
    exit 1
fi

log() {
    echo "[model-config] $*"
}

# Use Python to parse YAML and generate configs -- bash YAML parsing is fragile.
"$PYTHON" - "$MODELS_YAML" "$PROFILE" "$DRY_RUN" "$VALIDATE_ONLY" "$PROJECT_ROOT" <<'PYTHON_SCRIPT'
import sys
import yaml
from pathlib import Path

models_yaml_path = sys.argv[1]
profile_name = sys.argv[2]
dry_run = sys.argv[3] == "True"
validate_only = sys.argv[4] == "True"
project_root = Path(sys.argv[5])

with open(models_yaml_path) as f:
    config = yaml.safe_load(f)

roles = config.get("roles", {})
profiles = config.get("profiles", {})

if profile_name not in profiles:
    print(f"ERROR: Profile '{profile_name}' not found. Available: {', '.join(profiles.keys())}")
    sys.exit(1)

profile = profiles[profile_name]
assignments = profile.get("assignments", {})

print(f"Profile: {profile_name}")
print(f"  Description: {profile.get('description', 'N/A')}")
print(f"  Instance type: {profile.get('instance_type', 'N/A')}")
print(f"  GPUs: {profile.get('gpus', 'N/A')}")
print()

# Build endpoint map: role -> service URL
NAMESPACE = "synesis-models"
PORT = 8080

def service_url(role_name: str) -> str:
    role_def = roles.get(role_name, {})
    svc = role_def.get("service_name", f"synesis-{role_name}")
    ns = role_def.get("namespace", NAMESPACE)
    return f"http://{svc}.{ns}.svc.cluster.local:{PORT}/v1"

def served_name(role_name: str) -> str:
    return roles.get(role_name, {}).get("served_model_name", f"synesis-{role_name}")

def model_repo(role_name: str) -> str:
    assignment = assignments.get(role_name, {})
    override = assignment.get("model_override")
    if override:
        return override
    return roles.get(role_name, {}).get("default_model", "")

# Print role assignments
print("Role Assignments:")
for role_name in ["router", "general", "coder", "critic", "summarizer"]:
    assignment = assignments.get(role_name, {})
    if not assignment or (isinstance(assignment, dict) and not assignment.get("device") and not assignment.get("model_override") and not assignment.get("quant")):
        if assignment.get("notes"):
            print(f"  {role_name}: SKIPPED ({assignment['notes'].strip()[:80]})")
        else:
            print(f"  {role_name}: SKIPPED (not in profile)")
        continue
    repo = model_repo(role_name)
    quant = assignment.get("quant", "auto")
    device = assignment.get("device", "gpu")
    gpu = assignment.get("gpu", "N/A")
    tp = assignment.get("tp", 1)
    replicas = assignment.get("replicas", 1)
    print(f"  {role_name}: {repo} [{quant}] on {device} (gpu={gpu}, tp={tp}, replicas={replicas})")

print()

# Generate planner env var mapping
# V3 mapping: router serves supervisor/planner/advisor roles, general serves executor/worker
print("Planner Environment Variables (for base/planner/deployment.yaml):")
print()

# Determine which model handles each planner role
# Router handles: supervisor, planner, advisor
# General handles: executor (worker) -- or router if no general
# Critic handles: critic
has_general = bool(assignments.get("general", {}).get("device") or assignments.get("general", {}).get("quant"))

env_vars = {
    "SYNESIS_SUPERVISOR_MODEL_URL": service_url("router"),
    "SYNESIS_SUPERVISOR_MODEL_NAME": served_name("router"),
    "SYNESIS_PLANNER_MODEL_URL": service_url("router"),
    "SYNESIS_PLANNER_MODEL_NAME": served_name("router"),
    "SYNESIS_ADVISOR_MODEL_URL": service_url("router"),
    "SYNESIS_ADVISOR_MODEL_NAME": served_name("router"),
    "SYNESIS_CRITIC_MODEL_URL": service_url("critic"),
    "SYNESIS_CRITIC_MODEL_NAME": served_name("critic"),
    "SYNESIS_SUMMARIZER_MODEL_URL": service_url("summarizer"),
    "SYNESIS_SUMMARIZER_MODEL_NAME": served_name("summarizer"),
}

if has_general:
    env_vars["SYNESIS_EXECUTOR_MODEL_URL"] = service_url("general")
    env_vars["SYNESIS_EXECUTOR_MODEL_NAME"] = served_name("general")
else:
    env_vars["SYNESIS_EXECUTOR_MODEL_URL"] = service_url("critic")
    env_vars["SYNESIS_EXECUTOR_MODEL_NAME"] = served_name("critic")

for k, v in sorted(env_vars.items()):
    print(f"  {k}={v}")

print()

# Validate against existing deployment.yaml
planner_deployment = project_root / "base" / "planner" / "deployment.yaml"
if planner_deployment.exists():
    content = planner_deployment.read_text()
    mismatches = []
    for key, expected in env_vars.items():
        if key in content:
            import re
            pattern = rf'name: {key}\s+value: ["\']?([^"\']+)["\']?'
            match = re.search(pattern, content)
            if match:
                actual = match.group(1).strip().strip('"').strip("'")
                if actual != expected:
                    mismatches.append(f"  {key}: expected={expected} actual={actual}")
    if mismatches:
        print("VALIDATION: Planner deployment.yaml MISMATCHES (update needed):")
        for m in mismatches:
            print(m)
    else:
        print("VALIDATION: Planner deployment.yaml OK (or env vars not yet present)")
else:
    print("VALIDATION: Planner deployment.yaml not found")

print()

# Validate LiteLLM config
litellm_config = project_root / "base" / "gateway" / "litellm-config.yaml"
if litellm_config.exists():
    print("VALIDATION: LiteLLM config exists at base/gateway/litellm-config.yaml")
    lc = yaml.safe_load(litellm_config.read_text())
    data = lc.get("data", {})
    config_yaml = data.get("config.yaml", "")
    if config_yaml:
        inner = yaml.safe_load(config_yaml)
        model_list = inner.get("model_list", [])
        model_names = [m.get("model_name") for m in model_list]
        print(f"  Current models in LiteLLM: {model_names}")
        for needed in ["synesis-agent", "synesis-router", "synesis-critic"]:
            if needed not in model_names:
                print(f"  MISSING: {needed} not in LiteLLM config")
else:
    print("VALIDATION: LiteLLM config not found")

print()

# Print summary of what needs to be created/updated
print("Files that need updating for this profile:")
ms_dir = project_root / "base" / "model-serving"
for role_name in ["router", "general", "coder", "critic"]:
    assignment = assignments.get(role_name, {})
    if not assignment.get("device") and not assignment.get("quant") and not assignment.get("model_override"):
        continue
    yaml_file = ms_dir / f"deployment-vllm-{role_name}.yaml"
    status = "EXISTS" if yaml_file.exists() else "NEEDS CREATION"
    print(f"  base/model-serving/deployment-vllm-{role_name}.yaml: {status}")

print(f"  base/gateway/litellm-config.yaml: UPDATE NEEDED")
print(f"  base/planner/deployment.yaml: UPDATE NEEDED")
print()
print("Done. Run with --validate-only to check consistency without changes.")
PYTHON_SCRIPT
