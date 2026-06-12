# Admin Control Plane and Constitutions

## Purpose

Provide governance UX and APIs so organizations can manage policy/constitution behavior as first-class runtime configuration.

## Admin Control Plane Capabilities

- policy editor for thresholds, escalation rules, and hard boundaries
- constitution manager for ingest/version/activate/deprecate
- decision trace explorer for path visualization
- ambiguity analytics and conformance dashboards
- staged rollout and rollback controls

## Constitution Schema v1

Minimum object model:

- `constitution_id`, `name`, `version`, `status`
- `scope` (org/tenant/project/repo/team)
- `precedence` and hard-boundary markers
- `provenance` (source, owner, checksum/signature)
- `effective_window`
- `clauses[]` with:
  - `clause_id`
  - `category`
  - `constraint_kind`
  - `statement`
  - `machine_rule` (optional)
  - `applicability`
  - `evidence_requirements`
  - `actions`
  - `validation_recipe_id` (optional)

## Admin API Surface v1

Target endpoint groups:

- policy management
- constitution management
- Backstage/Developer Hub connector controls
- decision traces and analytics
- rollout and replay APIs

Baseline requirements:

- audit events for all mutable operations
- dry-run previews for activation/rollback
- scoped access control (org/tenant)
- traceability from decision to governing clauses

## Backstage / Developer Hub Connector

Connector API: `POST/GET/PATCH/DELETE /api/v1/developer-hub/connectors`

Sync and preview:
- `POST /connectors/{id}/sync` — pull entities and upsert into ingestion pipeline
- `GET  /connectors/{id}/sync/preview` — dry-run showing create/update/unchanged actions

Health and cache:
- `POST /connectors/{id}/test` — test Backstage API connectivity
- `GET  /connectors/{id}/health` — combined connectivity + sync freshness status
- `GET  /connectors/{id}/cache` — inspect cached entity snapshot

Entity-to-corpus mapping:
- Template → `golden_path_id` = entity name, `content_profile` = procedural, `constraint_source` = developer-hub
- Component → `content_profile` = reference, tags include lifecycle/type
- API → `content_profile` = api_spec
- System → `content_profile` = reference

Governance bridge (opt-in via annotations):
- `synesis.io/governance-constitution` → auto-create GovernanceClause under the named constitution
- `synesis.io/constraint-kind` → override constraint kind (default: guiding)
- `synesis.io/governance-category` → clause category (default: architecture)
- `synesis.io/validation-recipe` → link to validation recipe

Resilience:
- Cached entity snapshot fallback when Backstage is unreachable
- Auth token stored by reference (env var name), not plaintext in DB
- Incremental sync via content-hash comparison
