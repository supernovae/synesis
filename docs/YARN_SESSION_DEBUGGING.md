# Yarn Session Debugging

This guide explains how to debug problematic Yarn sessions without enabling full, always-on tracing.

## What Phase 2 Adds

Yarn now uses adaptive diagnostics:

- Low, deterministic baseline sampling (`SYNESIS_YARN_DIAGNOSTICS_BASE_SAMPLE_RATE`, default `0.02`)
- Forced capture on failures/escalations (`SYNESIS_YARN_DIAGNOSTICS_ON_FAILURE=true`)
- Forced capture on potential waffling/tool-loop behavior (`SYNESIS_YARN_DIAGNOSTICS_TOOL_LOOP_THRESHOLD=8`)
- Compact snapshots persisted to Redis with TTL (`SYNESIS_YARN_DIAGNOSTICS_SNAPSHOT_TTL_SECONDS=86400`)

Snapshots are intentionally compact and include:

- request/session identifiers (hashed where sensitive)
- usage totals (in/out/cached tokens, estimated cost)
- tool loop count and per-tool success/error trail
- capture reasons (error, escalation, tool-loop threshold)

## Required Configuration

Set in `base/yarn/deployment.yaml` (defaults are already included):

- `SYNESIS_YARN_DIAGNOSTICS_ENABLED=true`
- `SYNESIS_YARN_DIAGNOSTICS_BASE_SAMPLE_RATE=0.02`
- `SYNESIS_YARN_DIAGNOSTICS_ON_FAILURE=true`
- `SYNESIS_YARN_DIAGNOSTICS_TOOL_LOOP_THRESHOLD=8`
- `SYNESIS_YARN_DIAGNOSTICS_MAX_TOOL_EVENTS=20`
- `SYNESIS_YARN_DIAGNOSTICS_SNAPSHOT_TTL_SECONDS=86400`

## Debug Flow

1. Capture a `request_id` from the client response header `X-Request-Id`.
2. Fetch snapshot details from Yarn (admin/org-admin token required):

```bash
curl -sS "https://<yarn-route>/v1/diagnostics/<request_id>" \
  -H "Authorization: Bearer <admin-or-org-admin-token>" | jq .
```

3. Correlate with pod logs:

```bash
oc -n synesis-yarn logs deploy/synesis-yarn --since=2h | rg "yarn_session_diagnostics|<request_id>"
```

4. If needed, inspect session state in Redis:

```bash
oc -n synesis-rag exec deploy/synesis-redis -- redis-cli --scan --pattern "yarn:session:*"
oc -n synesis-rag exec deploy/synesis-redis -- redis-cli GET "yarn:diag:<request_id>"
```

## Interpreting Common Reasons

- `error`: request failed (model/tool/runtime error path)
- `escalated` / `escalation_signal`: request escalated to planner path
- `tool_loop_threshold`: repeated tool loop behavior likely indicates oscillation/waffling
- `tool_loop_limit_exceeded`: non-streaming loop exhausted max loop budget

## Tuning Guidance

- If incidents are missed, raise `SYNESIS_YARN_DIAGNOSTICS_BASE_SAMPLE_RATE` gradually (for example `0.02 -> 0.05`).
- If logs are too noisy, lower base sample rate first; keep failure sampling on.
- Keep `SYNESIS_YARN_DIAGNOSTICS_MAX_TOOL_EVENTS` modest to bound log payload size.
