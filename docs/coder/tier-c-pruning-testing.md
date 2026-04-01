# Tier C and Tool Pruning Testing

This document is the operator runbook for validating:

- Tier C validation fallback behavior (`coder-normalizer` role)
- Tool schema pruning behavior (`maxEffectiveTools` + pruning policy)

## Prerequisites

- Yarn is deployed and reachable.
- A Tier C model is assigned in Admin Model Registry to role `coder-normalizer`.
- You have:
  - a coder PAT/token for `/v1/chat/completions`
  - an internal service token for `/health/telemetry` (recommended for metrics deltas)

## Enable runtime flags

### Full-mode deploy

`scripts/deploy.sh` supports full mode and patches Tier C/pruning env vars automatically:

```bash
SYNESIS_YARN_FULL_FEATURES=true ./scripts/deploy.sh
```

### Optional explicit overrides

```bash
SYNESIS_YARN_FULL_FEATURES=true \
SYNESIS_YARN_VALIDATION_TIER_C_ROLE=coder-normalizer \
SYNESIS_YARN_VALIDATION_TIER_C_TIMEOUT_MS=1500 \
SYNESIS_YARN_VALIDATION_TIER_C_MAX_INPUT_CHARS=8000 \
SYNESIS_YARN_VALIDATION_TIER_C_MAX_FINDINGS=8 \
SYNESIS_YARN_TOOL_SCHEMA_PRUNING_MAX_OVERRIDE=0 \
./scripts/deploy.sh
```

## Baseline verification

From `base/yarn-ts`, run full live verification:

```bash
SYNESIS_YARN_URL="https://<your-yarn-url>" \
SYNESIS_TEST_AUTH="<coder-pat>" \
SYNESIS_VERIFY_MODE=full \
SYNESIS_VERIFY_MODEL=synesis-core \
npm run verify:live -- --json verify-core.json
```

Run again for `synesis-pulse` and `synesis-horizon` to compare baseline latencies.

## Tier comparison run (single table)

Use the dedicated tier compare runner to execute the same payload across pulse/core/horizon:

```bash
SYNESIS_YARN_URL="https://<your-yarn-url>" \
SYNESIS_TEST_AUTH="<coder-pat>" \
SYNESIS_TELEMETRY_TOKEN="<internal-service-token>" \
npm run verify:tiers
```

Optional:

```bash
SYNESIS_TIER_MODELS="synesis-pulse,synesis-core,synesis-horizon" \
SYNESIS_TIER_ROUNDS=10 \
npm run verify:tiers
```

Output includes:

- avg/p95 latency
- Tier C attempts/success/fallback/errors
- pruned requests, tools pruned total, pruning rate

## A/B reduction telemetry view

```bash
SYNESIS_YARN_URL="https://<your-yarn-url>" \
SYNESIS_TEST_AUTH="<coder-pat>" \
SYNESIS_VERIFY_MODEL=synesis-core \
npm run verify:ab -- --json ab-core.json
```

## Metrics to watch

Query `/health/telemetry` and inspect:

- `validationNormalization.tierCAttemptCount`
- `validationNormalization.tierCSuccessCount`
- `validationNormalization.tierCFallbackCount`
- `validationNormalization.tierCErrorCount`
- `toolSchemaPruning.requestsConsidered`
- `toolSchemaPruning.requestsPruned`
- `toolSchemaPruning.toolsPrunedTotal`

## Tuning guidance

- If `tierCErrorCount` rises: increase `SYNESIS_YARN_VALIDATION_TIER_C_TIMEOUT_MS` slightly (for example 1500 -> 2000).
- If `tierCSuccessCount` is near zero despite noisy inputs: validate `coder-normalizer` role assignment and model JSON reliability.
- If pruning rate is high with degraded outcomes: lower `SYNESIS_YARN_TOOL_SCHEMA_PRUNING_MAX_OVERRIDE` only if adapter limits are too aggressive, or relax pruning policy after evaluation.
- Keep Tier C model non-thinking and small/fast for best latency-cost profile.
