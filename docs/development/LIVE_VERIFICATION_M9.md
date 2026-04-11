# M9: Live Yarn Verification Suite

Repeatable live-system tests that validate reducer runtime behavior, telemetry claims, and token-efficiency improvements on deployed Yarn.

## Quick start

### Prerequisites

| Variable | Required | Purpose |
|----------|----------|---------|
| `SYNESIS_YARN_EVAL_URL` | Yes (or `SYNESIS_YARN_URL`) | Yarn OpenAI base URL — **CI uses** `SYNESIS_YARN_EVAL_URL` (e.g. `https://coder.kybern.dev`) |
| `SYNESIS_TEST_PAT_TOKEN` | For chat scenarios | PAT for user-space `/v1` (GitHub secret in CI); locally: `SYNESIS_TEST_AUTH` / `SYNESIS_TEST_TOKEN` |
| `SYNESIS_VERIFY_MODE` | No (default `safe`) | `safe` or `full` |
| `SYNESIS_VERIFY_MODEL` | No (default `synesis-core`) | Model to use for chat completions |

See **[CI_GITHUB_VALIDATION.md](./CI_GITHUB_VALIDATION.md)** for GitHub Variables/Secrets names used by `yarn-live-verify.yml`.

> **Auth resolution (PAT only):** `SYNESIS_TEST_PAT_TOKEN` → `SYNESIS_TEST_AUTH` → `SYNESIS_TEST_TOKEN`. Do not use the internal service token here.

### One-command runs

```bash
cd base/yarn-ts

# CI-style names (repository variable + PAT secret):
SYNESIS_YARN_EVAL_URL=https://coder.kybern.dev SYNESIS_TEST_PAT_TOKEN=syn-… npm run verify:live

# Local aliases:
SYNESIS_YARN_URL=https://… SYNESIS_TEST_AUTH=syn-… npm run verify:live

# Full mode — adds Claude Messages API scenarios
SYNESIS_YARN_EVAL_URL=https://… npm run verify:live:full

# Save JSON report
SYNESIS_YARN_EVAL_URL=https://… npx tsx scripts/live-verify.ts --json report.json

# A-B comparison (reducer savings analysis)
SYNESIS_YARN_EVAL_URL=https://… npm run verify:ab
SYNESIS_YARN_EVAL_URL=https://… npx tsx scripts/ab-reducer-compare.ts --json ab-report.json
```

## What the harness validates

### Phase 1 — Health & models

1. `GET /health` returns 200
2. `GET /v1/models` returns 200 with model list

### Phase 2 — Reducer scenarios

For each reducer family (`pytest`, `tsc`, `lint`, `git`, `search`):
- Sends an OpenAI `chat/completions` request with a tool result message containing realistic fixture output
- Asserts HTTP 200

In `full` mode, also sends Claude Messages API equivalents.

### Phase 3 — Telemetry deltas

Captures `/health/telemetry` before and after all scenarios, then asserts:

| Assertion | Pass condition |
|-----------|---------------|
| `reducedCount` | Positive (at least one reduction occurred) |
| `family.<name>` | Incremented for each passed scenario |
| `reducerFailures` | Zero (no reducer errors) |

### Phase 4 — Lifecycle check

Reads `toolResultReduction.lifecycle` from telemetry and reports each reducer family's state (`enabled` / `degraded` / `disabled`), success count, and failure count.

## Interpreting the report

### JSON report structure

```json
{
  "url": "https://...",
  "mode": "safe",
  "model": "synesis-core",
  "startedAt": "2026-03-25T...",
  "durationMs": 12345,
  "health": { "pass": true },
  "models": { "pass": true, "count": 3, "ids": ["synesis-pulse", ...] },
  "telemetryBefore": { ... },
  "telemetryAfter": { ... },
  "telemetryDelta": {
    "reducedCount": 5,
    "tokensSavedEstimateTotal": 800,
    "family.pytest": 1,
    ...
  },
  "telemetryAssertions": [
    { "key": "reducedCount", "expected": "positive", "actual": 5, "pass": true },
    { "key": "family.pytest", "expected": 1, "actual": 1, "pass": true },
    { "key": "reducerFailures", "expected": "zero", "actual": 0, "pass": true }
  ],
  "scenarios": [ ... ],
  "summary": { "total": 12, "passed": 12, "failed": 0, "tokensSaved": 800 }
}
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | All checks passed |
| 1 | Hard failure (endpoint unreachable, HTTP errors on scenarios) |
| 2 | Script crash |

Telemetry assertion misses are **warnings**, not hard failures — they indicate the reducer path may not have been exercised (e.g. fixture too small to trigger reduction) but don't block the run.

## A-B comparison runner

The `ab-reducer-compare.ts` script:

1. Sends identical payloads through the live Yarn (current reducer config)
2. Captures telemetry deltas per family
3. Computes a local baseline (raw fixture sizes without reduction) for comparison
4. Reports: reduction ratio, estimated token savings, average latency, failures, fallback counts

Use this after changing reducer profiles (`balanced` → `aggressive`) or toggling families to measure the impact.

## Regression patterns

| Symptom | Likely cause | Action |
|---------|-------------|--------|
| `reducedCount` = 0 | Reducers disabled or fixtures below threshold | Check `SYNESIS_YARN_REDUCERS_ENABLED` and `SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS` |
| `family.X` = 0 but scenario passed | Classifier didn't match the fixture to family X | Review `classifier.ts` patterns; check fixture content vs classifier heuristics |
| `reducerFailures` > 0 | A reducer threw during `reduce()` | Check `/health/telemetry` lifecycle for `lastError`; the system fell back to artifact summary safely |
| `fallbackToArtifactCount` high | Reducers not matching most content | Expected for generic tool output; add new reducer families to cover patterns |
| High latency spike | Upstream model slow, not reducer overhead | Reducers run synchronously pre-model-call; check model endpoint health |

## Fixtures

Live fixtures under `base/yarn-ts/tests/fixtures/live/` are larger and more realistic than unit test fixtures:

| Fixture | Family | Content |
|---------|--------|---------|
| `pytest-large.txt` | pytest | 147-test session with 5 failures |
| `tsc-large.txt` | tsc | 19 errors across 10 files |
| `lint-large.txt` | lint | 21 ruff/eslint findings |
| `git-large.txt` | git | Multi-file diff with staged/unstaged changes |
| `search-large.txt` | search | 16 ripgrep matches across multiple files |

## Adding new reducer families

When expanding beyond the initial 5 families:

1. Add a fixture file under `tests/fixtures/live/<family>-large.txt`
2. Add an entry in `buildScenarios()` in `scripts/live-verify.ts`
3. Add an entry in `SCENARIOS` in `scripts/ab-reducer-compare.ts`
4. Add fixture under `tests/fixtures/reducers/<family>.txt` for unit tests
5. Add regression test in `tests/reducer-regression.test.ts`
6. Run `npm run verify:live` to confirm the new family exercises the expected path

## CI integration (future)

The harness is designed for eventual CI integration:

- **Manual dispatch**: `gh workflow run yarn-live-verify.yml`
- **Gate behavior**: Hard fail on endpoint errors; warn on telemetry assertion misses
- **Nightly schedule**: Optional cron against staging
- **Artifact archival**: `--json report.json` output uploaded as workflow artifact
