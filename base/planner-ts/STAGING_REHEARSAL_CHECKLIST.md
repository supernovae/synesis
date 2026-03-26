# Planner TS Staging Rehearsal Checklist

Use this checklist before production cutover. Mark each item with `PASS` / `FAIL` and capture evidence.

Machine-readable companion template: `STAGING_REHEARSAL_RECORD_TEMPLATE.json`
Helper command to create a timestamped record: `npm run rehearsal:new`

## Metadata

- Date:
- Environment:
- Operator:
- Planner TS image/tag:
- Python planner fallback image/tag:

## 1) Gate Verification

- [ ] Run: `npm run verify:gates`
  - Expected: command exits `0`
  - Evidence:

- [ ] Optional parity compare run:
  - Command: `SYNESIS_PLANNER_TS_COMPARE_PY_BASELINE=true npm run verify:gates`
  - Expected: command exits `0` (or documented exceptions)
  - Evidence:

## 2) Service Health

- [ ] `GET /health`
  - Expected: `status=ok`, auth telemetry present (`auth.engine`, `auth.policyStats`)
  - Evidence:

- [ ] `GET /health/authz-events`
  - Expected: returns `auth.engine` + recent events array
  - Evidence:

## 3) API Contract Checks

- [ ] Non-stream chat completion
  - Endpoint: `POST /v1/chat/completions` (`stream=false`)
  - Expected:
    - `200`
    - OpenAI-compatible envelope
    - `authz_trace_id` present in body + header
  - Evidence:

- [ ] Stream chat completion
  - Endpoint: `POST /v1/chat/completions` (`stream=true`)
  - Expected:
    - `200`
    - SSE status events include JSON `event` payload
    - status payload includes `authz_trace_id`
    - final `[DONE]` emitted
  - Evidence:

## 4) Auth/Trust Boundary Checks

- [ ] Missing bearer enforcement (if required mode enabled)
  - Expected: `401 authentication_error`
  - Evidence:

- [ ] Invalid scope deny
  - Expected: `403` with deny rule signal
  - Evidence:

- [ ] Trusted forwarded identity path
  - Expected:
    - request allowed
    - matching `traceId` event in `/health/authz-events`
    - expected forwarded `userId` in event
  - Evidence:

## 5) Performance Smoke

- [ ] Confirm latency budget test pass
  - Command: `npm test -- tests/latency-budget.test.ts`
  - Expected: pass with configured budgets
  - Evidence:

- [ ] Confirm SSE conformance pass
  - Command: `npm test -- tests/sse-conformance.test.ts`
  - Expected: pass
  - Evidence:

## 6) Rollback Rehearsal

- [ ] Execute traffic switch back to Python planner in staging
  - Expected: rollback route completes without errors
  - Evidence:

- [ ] Validate Python planner health post-rollback
  - Expected: health and chat endpoints recover within acceptable time
  - Evidence:

## 7) Sign-off

- [ ] Engineering sign-off:
- [ ] Platform/Operations sign-off:
- [ ] Security sign-off:

## Outcome

- Final result: `PASS` / `FAIL`
- Notes:
