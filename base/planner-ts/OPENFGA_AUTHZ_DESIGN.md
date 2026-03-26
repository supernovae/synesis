# OpenFGA Authz Design (Planner/Admin/Yarn)

This document defines a staged OpenFGA rollout for shared authorization across `planner`, `admin`, and `yarn`.

## Goals

- Unify authorization decisions across services with one relationship model.
- Preserve current deny-by-default semantics.
- Keep current deterministic policy engine available as fallback during migration.
- Roll out safely with shadow logging before enforcement.

## Proposed Shared Contracts

- Shared request context:
  - `userId`
  - `orgId`
  - `tenantIds`
  - `tokenScopes`
  - `authMethod`
- Shared authorization request:
  - `resourceType`
  - `resourceId`
  - `action`
- Shared authorization decision:
  - `allow`
  - `reason`
  - `matchedRules`
  - `traceId`

## Tuple Model (Initial)

- `type user`
- `type org`
  - relations:
    - `member: [user]`
    - `admin: [user]`
- `type tenant`
  - relations:
    - `parent_org: [org]`
    - `member: [user, org#member]`
    - `admin: [user, org#admin]`
- `type planner_endpoint`
  - relations:
    - `tenant: [tenant]`
    - `can_invoke: [user, tenant#member, tenant#admin]`

## Planner Mapping (Phase 1)

- `POST /v1/chat/completions`:
  - resource: `planner_endpoint:chat_completions`
  - action: `invoke`
  - required:
    - token scope includes `model:*`
    - OpenFGA check allows `can_invoke`

The scope gate remains local; OpenFGA adds org/tenant relationship enforcement.

## Staged Rollout

1. **Schema + client readiness**
   - Add OpenFGA config/env scaffolding in each service.
   - Keep deterministic engine as primary.
2. **Shadow mode**
   - Execute OpenFGA checks in parallel, log decision deltas only.
   - Do not block requests on OpenFGA results yet.
3. **Soft enforcement**
   - Enforce OpenFGA for a small tenant cohort.
   - Keep deterministic fallback and explicit feature flag.
4. **Full enforcement**
   - Enforce OpenFGA globally.
   - Retain audit telemetry + trace lineage.

## Environment Variables (Planner TS)

- `SYNESIS_PLANNER_TS_OPENFGA_API_URL`
- `SYNESIS_PLANNER_TS_OPENFGA_STORE_ID`
- `SYNESIS_PLANNER_TS_OPENFGA_MODEL_ID`
- `SYNESIS_PLANNER_TS_OPENFGA_AUTH_TOKEN`

## Success Criteria

- No authorization drift between planner/admin/yarn for equivalent requests.
- All allow/deny decisions carry traceable IDs and rationale.
- Shadow-mode delta rate remains within agreed threshold before enforcement.
