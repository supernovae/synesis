# Model Capability Matrix Rollout Runbook

This runbook is for operators rolling out capability-matrix policy controls.

## Goals

- keep the system safe by default (`global_optimizations_enabled=false`)
- observe model-specific breakage before broad enablement
- provide fast rollback without code deploys

## Controls

- Global posture:
  - `mode=shadow`: compute + trace only, do not enforce.
  - `mode=enforced`: apply effective capabilities.
- Global default:
  - `global_optimizations_enabled=false` (recommended baseline).
- Override rows:
  - enable specific capabilities for `family_prefix`, `model_path_prefix`, or `exact_model`.

Common Yarn capability toggles:

- `yarn.phase_execution_policy_enabled`
- `yarn.reducers_enabled`
- `yarn.transcript_prune_enabled`
- `yarn.json_compaction_enabled`
- `yarn.content_dedupe_enabled`
- `yarn.response_dedupe_enabled`
- `yarn.historical_normalize_enabled`

## Rollout Stages

### Stage A - Shadow

1. Set global mode to `shadow`.
2. Keep `global_optimizations_enabled=false`.
3. Add candidate overrides for models under evaluation.
4. Validate telemetry:
   - Yarn session events: `capability_matrix_resolution_v1`
   - Yarn request forensics: `request_forensics_v1.metadataJson.capabilityMatrix`
   - Planner traces: `trace_context.capability_matrix_*`
   - WebUI logs: `capability_matrix_resolution_v1`

Exit criteria:

- selector matches are deterministic and expected
- no unexpected model routing/selection mismatches

### Stage B - Enforced, Narrow Allowlist

1. Switch global mode to `enforced`.
2. Keep `global_optimizations_enabled=false`.
3. Add explicit overrides only for known-stable models/families.
4. Monitor regressions:
   - edit-context misses
   - repeated verification loops
   - fallback/hard-stop events
   - tool-loop soft-fails

Exit criteria:

- target models show stable loop behavior
- no widespread increase in retries/hard-stops

### Stage C - Expand Coverage

1. Add model/family/path overrides incrementally.
2. Prefer family/path rules only after exact-model stability is demonstrated.
3. Keep audit trail for each change and compare traces before/after.

## Fast Rollback

Use one of these immediately if regressions spike:

1. Set global mode to `enforced`, `global_optimizations_enabled=false`.
2. Delete or disable the problematic override row.
3. If needed, switch to `mode=shadow` while investigating.

No service redeploy is required; services poll admin and refresh automatically.

## Operational Checks

- Admin page: `Settings -> Capability Matrix`
- Endpoint: `GET /api/v1/governance/capability-matrix/effective`
- Audit trail: `governance.capability_matrix.*` actions

## Emergency Kill Switches (Service Local)

Matrix policy is primary control. Existing env flags remain emergency hard-kill switches.

- Yarn reducers: `SYNESIS_YARN_REDUCERS_ENABLED=false`
- Yarn governance bypass: `SYNESIS_YARN_GOVERNANCE_DISABLED=true`

Use env overrides only for incident response, then reconcile matrix policy after stabilization.
