# Planner TS Cutover Rollback Runbook

This runbook stages production cutover onto `planner-ts` while keeping rollback immediate.

Companion checklist: `STAGING_REHEARSAL_CHECKLIST.md`
Machine-readable template: `STAGING_REHEARSAL_RECORD_TEMPLATE.json`
Record generator: `npm run rehearsal:new`

## Preconditions

- `planner-ts` gates pass locally:
  - `npm run verify:gates`
- Deployment artifacts for `planner-ts` are available.
- Operator can route traffic between planner service revisions without rebuilding images.

## Cutover Steps

1. **Deploy `planner-ts` as standby**
   - Verify readiness/health endpoints:
     - `GET /health`
     - `GET /health/authz-events`
2. **Shadow/limited traffic validation**
   - Confirm SSE contract:
     - status events contain JSON `event` payload and `authz_trace_id`
     - completion stream ends with `[DONE]`
   - Confirm authz telemetry:
     - `/health` `auth.policyStats` increments
     - `/health/authz-events` receives recent allow/deny decisions
3. **Promote `planner-ts` to primary**
   - Route production `/v1/chat/completions` traffic to TS service.
4. **Observe stabilization window**
   - Track p50/p95 latency, non-200 rates, timeout rates, and critic loop health.
   - Validate sampled responses for citation/grounding quality.

## Rollback Triggers

Rollback immediately if any of the following occur:

- sustained elevated non-200 rate
- major SSE client compatibility break
- repeated grounding/citation regression
- authz boundary regression (unexpected allow/deny behavior)
- oscillation/loop behavior materially worse than baseline

## Rollback Steps

1. Route traffic back to the previous stable `planner-ts` revision immediately.
2. Keep `planner-ts` running for forensic logs/telemetry collection.
3. Capture:
   - failing request IDs
   - `authz_trace_id` values
   - `/health` + `/health/authz-events` snapshots
4. Open remediation ticket with:
   - regression symptom
   - rollback timestamp
   - affected endpoints/clients
5. Patch and re-run:
   - `npm run verify:gates`
   - replay/parity checks before retrying cutover.

## Exit Criteria (Cutover Success)

- no rollback triggers during stabilization window
- latency/error metrics at or better than Python baseline
- SSE/OpenAI compatibility remains stable
- authz telemetry and trace lineage remain coherent across requests
