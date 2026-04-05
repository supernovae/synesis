# Harness Power CLI Runbook

This runbook describes how to operate `synesis-power-cli` for routine harness feedback loops.

## Purpose

- Run a repeatable KPI + session + canary loop from Admin APIs.
- Generate artifacts for trend tracking and change reviews.
- Keep investigations fast and consistent across operators.

## Tooling

- CLI package: `tools/synesis-power-cli`
- Base guide: `docs/clients/HARNESS_POWER_CLI.md`
- Canary pack: `docs/clients/CANARY_PROMPT_PACK.md`
- KPI SQL reference: `docs/clients/YARN_KPI_ALERT_PACK.md`

## Preconditions

- Admin API reachable.
- Operator has a valid bearer token for Admin routes.
- Python 3.12 and `uv` available.

Recommended environment:

```bash
export SYNESIS_ADMIN_BASE_URL="http://127.0.0.1:8080"
export SYNESIS_ADMIN_TOKEN="<bearer-token>"
```

## Quick Commands

Copy/paste these first, then customize paths/session keys as needed.

```bash
# 1) KPI snapshot (24h)
uv run --project tools/synesis-power-cli python -m synesis_power_cli \
  kpi snapshot --since-hours 24 --bucket-minutes 15 --format json \
  --output artifacts/power-cli/kpi-24h.json

# 2) Session inspect
uv run --project tools/synesis-power-cli python -m synesis_power_cli \
  session inspect --session-key "<session-key>" --format markdown \
  --output artifacts/power-cli/session-<session-key>.md

# 3) Canary checklist
uv run --project tools/synesis-power-cli python -m synesis_power_cli \
  canary checklist --format json \
  --output artifacts/power-cli/canary-checklist.json

# 4) A/B scaffold
uv run --project tools/synesis-power-cli python -m synesis_power_cli \
  ab scaffold --run-a-name "A-synesis" --run-b-name "B-control" \
  --model-id "same-base-model" --format json \
  --output artifacts/power-cli/ab-scaffold.json
```

## Standard Operating Loop

Run this loop after deploys and at least once daily for active environments.

### 1) Capture KPI snapshot

```bash
uv run --project tools/synesis-power-cli python -m synesis_power_cli \
  kpi snapshot --since-hours 24 --bucket-minutes 15 --format json \
  --output artifacts/power-cli/kpi-24h.json
```

What to watch:

- `completion_gate_blocked_rate`
- `critic_block_rate`
- `first_pass_verify_rate`
- `structured_error_coverage`
- `performance_summary.error_rate`

### 2) Identify candidate sessions

- Use Admin UI Yarn Overview + Sessions to find outliers (high errors, high latency, high block rates).
- Pick 2-5 representative session keys.

### 3) Inspect sessions

```bash
uv run --project tools/synesis-power-cli python -m synesis_power_cli \
  session inspect --session-key "<session-key>" --format markdown \
  --output artifacts/power-cli/session-<session-key>.md
```

What to watch:

- `trajectory_events`
- `completion_gate_blocked_events`
- `critic_blocked_events`
- `first_pass_verify_ok_rate`
- `avg_structured_error_coverage`

### 4) Prepare canary runs

```bash
uv run --project tools/synesis-power-cli python -m synesis_power_cli \
  canary checklist --format json \
  --output artifacts/power-cli/canary-checklist.json
```

Validate prompt IDs and required capture fields before running clients.

### 5) Prepare A/B manifests

```bash
uv run --project tools/synesis-power-cli python -m synesis_power_cli \
  ab scaffold --run-a-name "A-synesis" --run-b-name "B-control" \
  --model-id "same-base-model" --format json \
  --output artifacts/power-cli/ab-scaffold.json
```

Use scaffold fields as the minimum schema for comparisons.

## Cadence

- Post-deploy: run full loop.
- Daily: run steps 1-3.
- Weekly review: aggregate artifacts and compare to prior week.

## Escalation Heuristics

Investigate immediately when any condition persists for more than one review window:

- `completion_gate_blocked_rate > 0.25`
- `critic_block_rate > 0.20`
- `first_pass_verify_rate` drops by `>= 20%` from baseline
- `structured_error_coverage < 0.35`

Use `docs/clients/YARN_KPI_ALERT_PACK.md` for SQL-level cross-checks.

## Artifact Convention

Store outputs under a timestamped folder, for example:

- `artifacts/power-cli/2026-04-05/kpi-24h.json`
- `artifacts/power-cli/2026-04-05/session-<key>.md`
- `artifacts/power-cli/2026-04-05/canary-checklist.json`
- `artifacts/power-cli/2026-04-05/ab-scaffold.json`

This makes weekly trend diffs straightforward.

## Troubleshooting

- 401/403 errors:
  - Verify `SYNESIS_ADMIN_TOKEN`.
  - Confirm operator role includes required admin/observability access.
- Connection errors:
  - Verify `SYNESIS_ADMIN_BASE_URL`.
  - Confirm admin service health.
- Empty data:
  - Increase `--since-hours` (for example, 72).
  - Verify recent Yarn activity exists in the environment.
