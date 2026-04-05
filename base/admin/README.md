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

## Database URL and `oc apply`

`SYNESIS_ADMIN_DATABASE_URL` in the Deployment manifest uses a **dev placeholder** password. **CloudNativePG** puts the real password in secret `synesis-admin-db-app`. **`scripts/deploy.sh`** (`ensure_admin_db`) patches the deployment with a URL-encoded connection string after the cluster is healthy.

If you run **`oc apply -k base/admin`** without going through deploy, the live DB URL can be reset to the placeholder → **migration auth failures** and restarts. Re-run **`./scripts/deploy.sh`** (or patch the env from the secret as in deploy.sh).

## Local test bootstrap

For local `pytest` runs in `base/admin`, use a dedicated venv and include both the admin module path and shared telemetry package on `PYTHONPATH`.

```bash
python3 -m venv base/admin/.venv
base/admin/.venv/bin/pip install -r base/admin/requirements.txt pytest

PYTHONPATH="/Users/bymiller/src/synesis/base/admin:/Users/bymiller/src/synesis/base/images/base-api/synesis-telemetry" \
  /Users/bymiller/src/synesis/base/admin/.venv/bin/pytest \
  /Users/bymiller/src/synesis/base/admin/tests/test_yarn_router.py -q

PYTHONPATH="/Users/bymiller/src/synesis/base/admin:/Users/bymiller/src/synesis/base/images/base-api/synesis-telemetry" \
  /Users/bymiller/src/synesis/base/admin/.venv/bin/pytest \
  /Users/bymiller/src/synesis/base/admin/tests/test_yarn_router.py::test_yarn_intelligence_includes_staff_kpis -q
```

## Related docs

- [docs/admin/KEYCLOAK_BOOTSTRAP.md](../../docs/admin/KEYCLOAK_BOOTSTRAP.md) — install order: `master` admin → user in **`synesis`** realm → **`synesis-admin`** role → first UI login → PATs.
- [docs/admin/TODO.md](../../docs/admin/TODO.md) — backlog, API explorer, future admin MCP.
- [`.cursor/rules/admin-ui.mdc`](../../.cursor/rules/admin-ui.mdc) — Cursor guidance for this UI.
