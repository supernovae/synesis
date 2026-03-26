#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_PATH="${ROOT_DIR}/STAGING_REHEARSAL_RECORD_TEMPLATE.json"
OUTPUT_DIR="${ROOT_DIR}/rehearsals"

DRY_RUN="false"
OUTPUT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    --output)
      OUTPUT_PATH="${2:-}"
      shift 2
      ;;
    *)
      echo "[rehearsal:new] Unknown argument: $1" >&2
      echo "Usage: npm run rehearsal:new -- [--dry-run] [--output path]" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "${TEMPLATE_PATH}" ]]; then
  echo "[rehearsal:new] Template not found: ${TEMPLATE_PATH}" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
default_output="${OUTPUT_DIR}/rehearsal-${timestamp}.json"
target_path="${OUTPUT_PATH:-${default_output}}"

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[rehearsal:new] DRY RUN"
  echo "[rehearsal:new] Template: ${TEMPLATE_PATH}"
  echo "[rehearsal:new] Would write: ${target_path}"
  exit 0
fi

mkdir -p "$(dirname "${target_path}")"

node - "${TEMPLATE_PATH}" "${target_path}" <<'EOF'
const fs = require("node:fs");

const templatePath = process.argv[2];
const targetPath = process.argv[3];

const data = JSON.parse(fs.readFileSync(templatePath, "utf8"));
if (!data.metadata || typeof data.metadata !== "object") {
  data.metadata = {};
}
data.metadata.date = new Date().toISOString();

fs.writeFileSync(targetPath, JSON.stringify(data, null, 2) + "\n", "utf8");
EOF

echo "[rehearsal:new] Created ${target_path}"
