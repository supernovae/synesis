# Synesis Admin

FastAPI backend (`app/`) + Vite React SPA (`frontend/`) for operating Synesis: models, RAG, traces, observability, and settings.

## Quick reference

| Area | Purpose |
|------|---------|
| `/api/v1/*` | JSON API (authenticated; admin routes use `require_admin` where needed) |
| Auth | Keycloak OIDC (`SYNESIS_KEYCLOAK_ISSUER_URL`, realm **`synesis`**) + PATs (`syn-...`); no local `/api/v1/auth/login` — first-time operator steps: [docs/admin/KEYCLOAK_BOOTSTRAP.md](../../docs/admin/KEYCLOAK_BOOTSTRAP.md) |
| `/api/docs`, `/api/openapi.json`, `/api/redoc` | Swagger UI, OpenAPI schema, and ReDoc (same origin as the SPA) |
| `frontend/src/router.tsx` | Client routes |
| `frontend/src/api/hooks.ts` | TanStack Query hooks for API access |
| `app/services/provider_catalog.py` | Single source of truth for LLM provider labels and key env vars |

## UX principles (fix forward)

1. **Domain language** — Registry assigns *which model* serves a *role*; Provider Keys store *secrets* (cluster secret). Never imply the registry uploads API keys.
2. **Errors** — Surface FastAPI `detail` via `apiErrorMessage` / `ApiErrorBanner`; dismissible where the user can retry.
3. **Navigation** — Sidebar is canonical; breadcrumbs in `TopBar.tsx` should label new segments (including dynamic IDs).
4. **Dark mode** — New screens use `dark:` Tailwind variants like existing pages.

## Admin audit log — potential follow-ups

The **Settings → Admin audit** page and `admin_audit_events` table cover model registry, reconcile, provider keys, cost rates, and infra cost settings. Possible next steps:

- **SSE / live stream** — Add an audit channel similar to `GET /api/v1/events` (traces) so the UI updates without polling.
- **Broader instrumentation** — Call `record_admin_audit` from taxonomy, ingestion, integrations, and other routers for a single operator timeline.
- **Retention / prune** — Scheduled job or CNPG policy to trim old `admin_audit_events` rows so the table does not grow unbounded.

## Database URL and Helm

`SYNESIS_ADMIN_DATABASE_URL` is chart-managed. Configure Postgres through `postgres.mode` and the matching `postgres.*` values in `charts/synesis`; Helm writes `synesis-admin-db-url` and mounts it into the admin deployment.

Do not use `oc apply -k base/admin` as the deployment source of truth for a Helm-managed cluster. Change values and run `helm upgrade synesis ./charts/synesis -f my-synesis-values.yaml`.

## Archive storage

Coder session history and trace activity records can be archived before deletion. Admin writes gzip JSONL objects to S3 or an S3-compatible blob store using `SYNESIS_ADMIN_ARCHIVE_S3_BUCKET`, `SYNESIS_ADMIN_ARCHIVE_S3_PREFIX`, and optional `SYNESIS_ADMIN_ARCHIVE_S3_ENDPOINT_URL`.

See [docs/admin/ADMIN_ARCHIVE_STORAGE.md](../../docs/admin/ADMIN_ARCHIVE_STORAGE.md) for configuration, permissions, object layout, and operator behavior.

## Local test bootstrap

For local `pytest` runs in `base/admin`, use a dedicated `uv` venv and include both the admin module path and shared telemetry package on `PYTHONPATH`.

```bash
UV_CACHE_DIR=/tmp/uv-cache uv venv base/admin/.venv
UV_CACHE_DIR=/tmp/uv-cache uv pip install --python base/admin/.venv/bin/python -r base/admin/requirements-dev.txt

PYTHONPATH="/Users/bymiller/src/synesis/base/admin:/Users/bymiller/src/synesis/base/images/base-api/synesis-telemetry" \
  /Users/bymiller/src/synesis/base/admin/.venv/bin/python -m pytest \
  /Users/bymiller/src/synesis/base/admin/tests/test_yarn_router.py -q

PYTHONPATH="/Users/bymiller/src/synesis/base/admin:/Users/bymiller/src/synesis/base/images/base-api/synesis-telemetry" \
  /Users/bymiller/src/synesis/base/admin/.venv/bin/python -m pytest \
  /Users/bymiller/src/synesis/base/admin/tests/test_yarn_router.py::test_yarn_intelligence_includes_staff_kpis -q
```

## Related docs

- [docs/admin/KEYCLOAK_BOOTSTRAP.md](../../docs/admin/KEYCLOAK_BOOTSTRAP.md) — install order: `master` admin → user in **`synesis`** realm → **`synesis-admin`** role → first UI login → PATs.
- [docs/admin/YARN_TRANSITION_CALIBRATION_OBSERVABILITY.md](../../docs/admin/YARN_TRANSITION_CALIBRATION_OBSERVABILITY.md) — Coder transition-quality telemetry, calibration visibility, and operator playbook.
- [../../docs/ADMIN_QUALITY_UI.md](../../docs/ADMIN_QUALITY_UI.md) — RAG quality and feedback surfaces.
- [`.cursor/rules/admin-ui.mdc`](../../.cursor/rules/admin-ui.mdc) — Cursor guidance for this UI.
