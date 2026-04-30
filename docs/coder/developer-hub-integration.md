# Developer Hub Integration

Connect a Backstage or Red Hat Developer Hub (RHDH) instance to Synesis so that golden paths, templates, components, APIs, and systems are automatically synced into the RAG corpus and optionally bridged to governance clauses.

## Prerequisites

- A running Backstage or RHDH instance with the Catalog backend enabled
- The Synesis admin service deployed with Postgres (Alembic migration `023_devhub_connector` applied)
- Network connectivity from the admin pod to the Backstage instance
- (Optional) A service account token if Backstage requires authentication

## Quick Start

### 1. Create a connector

```bash
curl -X POST https://admin.synesis.example/api/v1/developer-hub/connectors \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Developer Hub",
    "base_url": "https://backstage.example.com",
    "auth_type": "bearer",
    "auth_token_ref": "DEVHUB_SERVICE_TOKEN",
    "entity_kinds": ["Template", "Component", "API", "System"],
    "org_id": "my-org",
    "sync_interval_minutes": 60
  }'
```

The `auth_token_ref` is an **environment variable name** (or literal token if the env var is not set). For production, set the env var on the admin deployment:

```yaml
env:
  - name: DEVHUB_SERVICE_TOKEN
    valueFrom:
      secretKeyRef:
        name: devhub-credentials
        key: token
```

### 2. Test connectivity

```bash
curl -X POST https://admin.synesis.example/api/v1/developer-hub/connectors/{connector_id}/test \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Returns `{"status": "ok", "detail": {"reachable": true, ...}}` on success.

### 3. Preview what will be synced

```bash
curl https://admin.synesis.example/api/v1/developer-hub/connectors/{connector_id}/sync/preview \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Returns a list of entities with predicted actions (`create`, `update`, `unchanged`) without modifying anything.

### 4. Trigger a sync

```bash
curl -X POST https://admin.synesis.example/api/v1/developer-hub/connectors/{connector_id}/sync \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Returns a `SyncResult` with counts of created, updated, unchanged, and errored items. Synced entities become `IngestionItem` records in `pending` status, ready for the indexer to pick up and index into NornicDB.

## Auth Types

| `auth_type` | Behavior |
|-------------|----------|
| `none`      | No authentication header sent |
| `bearer`    | `Authorization: Bearer <token>` header; token resolved from `auth_token_ref` env var or literal value |
| `oauth`     | Reserved for future OAuth2 client credentials flow |

## Entity-to-Corpus Mapping

Each synced entity becomes an `IngestionItem` with metadata populated for the current graph schema:

| Entity Kind | `handler` | `content_profile` | `golden_path_id` | `constraint_source` |
|-------------|-----------|-------------------|-------------------|---------------------|
| Template    | `devhub_template` | `procedural` | entity name | `developer-hub` |
| Component   | `devhub_component` | `reference` | -- | `developer-hub` |
| API         | `devhub_api` | `api_spec` | -- | `developer-hub` |
| System      | `devhub_system` | `reference` | -- | `developer-hub` |

Tags are auto-generated from the entity's Backstage tags plus `devhub-kind:<kind>`, `devhub-type:<spec.type>`, and `lifecycle:<spec.lifecycle>`.

Items are keyed by URI (`devhub://<connector_id>/<entity_ref>`) with incremental sync via content-hash comparison. Only changed entities are reset to `pending` for re-indexing.

## Governance Bridge

Template entities with specific Backstage annotations are automatically bridged to governance clauses. This is **opt-in** — only templates with the `synesis.io/governance-constitution` annotation trigger clause creation.

### Supported annotations

Add these to your Backstage template's `metadata.annotations`:

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: go-microservice
  annotations:
    synesis.io/governance-constitution: "org-standards"
    synesis.io/constraint-kind: "guiding"
    synesis.io/governance-category: "architecture"
    synesis.io/validation-recipe: "go-lint-recipe"
```

| Annotation | Effect | Default |
|------------|--------|---------|
| `synesis.io/governance-constitution` | Required. Constitution ID to create the clause under | -- (skipped if absent) |
| `synesis.io/constraint-kind` | `hard`, `guiding`, or `advisory` | `guiding` |
| `synesis.io/governance-category` | Clause category | `architecture` |
| `synesis.io/validation-recipe` | Links to a validation recipe ID | -- |

The clause ID is deterministic (`devhub-<connector_id>-<template_name>`), so re-syncing updates the existing clause rather than creating duplicates.

## Cached Snapshot Fallback

When the Backstage API is unreachable during sync, the engine falls back to the last known-good entity snapshot stored in the connector's `cached_entity_snapshot` column. The sync status is set to `fallback_cached` to indicate stale data was used.

Inspect the cache:

```bash
curl https://admin.synesis.example/api/v1/developer-hub/connectors/{connector_id}/cache \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Health Monitoring

```bash
curl https://admin.synesis.example/api/v1/developer-hub/connectors/{connector_id}/health \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Returns connectivity status, last sync age, and whether the sync is overdue (age exceeds 1.5x the configured interval).

## Connector Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/developer-hub/connectors` | POST | Create connector |
| `/api/v1/developer-hub/connectors` | GET | List connectors (filter by `org_id`, `enabled`) |
| `/api/v1/developer-hub/connectors/{id}` | GET | Get connector detail |
| `/api/v1/developer-hub/connectors/{id}` | PATCH | Update connector config |
| `/api/v1/developer-hub/connectors/{id}` | DELETE | Remove connector |
| `/api/v1/developer-hub/connectors/{id}/test` | POST | Test Backstage API connectivity |
| `/api/v1/developer-hub/connectors/{id}/sync` | POST | Trigger sync |
| `/api/v1/developer-hub/connectors/{id}/sync/preview` | GET | Dry-run sync preview |
| `/api/v1/developer-hub/connectors/{id}/cache` | GET | Inspect cached snapshot |
| `/api/v1/developer-hub/connectors/{id}/health` | GET | Health and freshness status |

All mutating endpoints produce admin audit events.

## Troubleshooting

**"Connector not found"** — The `connector_id` in the URL must match the auto-generated slug (e.g., `devhub-a1b2c3d4e5f6`), not the `name` field.

**Test returns `reachable: false`** — Check network connectivity from the admin pod. Verify `base_url` includes the correct port (Backstage default is 7007). Verify the auth token is valid.

**Sync shows 0 entities** — Verify `entity_kinds` includes the kinds present in your catalog. Try with `["Component"]` first since most Backstage instances have components. Check that your Backstage instance exposes `/api/catalog/entities`.

**Governance clauses not created** — Clauses are only created for Template entities with the `synesis.io/governance-constitution` annotation. The referenced constitution must exist in the governance system.

**Items stuck in "pending"** — Synced items need the indexer to process them. Check the indexer is running and can reach the admin API for item claiming.
