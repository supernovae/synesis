# Harness Power CLI

`synesis-power-cli` is a Python 3.12 operator CLI for repeatable harness feedback loops using Admin APIs only.

For step-by-step operational usage, see `docs/clients/HARNESS_POWER_CLI_RUNBOOK.md`.

## Scope

- Read-only against Admin APIs.
- No direct SQL, pod logs, or cluster shell access.
- Focused on KPI snapshots, session trajectory inspection, canary checklist generation, and A/B run scaffolds.

## Location

- Package: `tools/synesis-power-cli`
- Module entrypoint: `synesis_power_cli`
- Script entrypoint (when installed): `synesis-power`

## Prerequisites

- Python 3.12+
- Admin API reachable (default `http://127.0.0.1:8080`)
- Optional bearer token in `SYNESIS_ADMIN_TOKEN`

## Quickstart

From repo root:

```bash
uv run --project tools/synesis-power-cli python -m synesis_power_cli --help
```

Set environment variables:

```bash
export SYNESIS_ADMIN_BASE_URL="http://127.0.0.1:8080"
export SYNESIS_ADMIN_TOKEN="<bearer-token>"
```

## Commands

### KPI snapshot

Fetches:

- `/api/v1/yarn/intelligence`
- `/api/v1/yarn/performance`
- `/api/v1/usage/summary`

```bash
uv run --project tools/synesis-power-cli python -m synesis_power_cli \
  kpi snapshot --since-hours 24 --bucket-minutes 15 --format markdown
```

### Session inspect

Fetches:

- `/api/v1/yarn/sessions/{session_key}`

And summarizes trajectory fields such as completion-gate blocks, critic blocks, first-pass verify rate, and parser coverage.

```bash
uv run --project tools/synesis-power-cli python -m synesis_power_cli \
  session inspect --session-key "<session-key>" --format json
```

### Canary checklist

Parses prompt IDs from `docs/clients/CANARY_PROMPT_PACK.md` and emits a run checklist payload.

```bash
uv run --project tools/synesis-power-cli python -m synesis_power_cli \
  canary checklist --format markdown
```

### A/B scaffold

Builds A/B run manifests with comparable fields and derived delta targets.

```bash
uv run --project tools/synesis-power-cli python -m synesis_power_cli \
  ab scaffold --run-a-name "A-synesis" --run-b-name "B-control" --model-id "same-base-model"
```

## Output modes

- `--format json` for machine ingestion.
- `--format markdown` for operator review notes.
- `--output <path>` to write artifacts.

## Suggested loop

1. Run `kpi snapshot`.
2. Investigate outlier sessions via `session inspect`.
3. Generate canary run plan via `canary checklist`.
4. Generate A/B templates via `ab scaffold`.
5. Store JSON outputs per run for trend comparison.
