# Synesis Admin

FastAPI backend (`app/`) + Vite React SPA (`frontend/`) for operating Synesis: models, RAG, traces, observability, and settings.

## Quick reference

| Area | Purpose |
|------|---------|
| `/api/v1/*` | JSON API (authenticated; admin routes use `require_admin` where needed) |
| `/api/docs`, `/api/openapi.json`, `/api/redoc` | Swagger UI, OpenAPI schema, and ReDoc (same origin as the SPA) |
| `frontend/src/router.tsx` | Client routes |
| `frontend/src/api/hooks.ts` | TanStack Query hooks for API access |
| `app/services/provider_catalog.py` | Single source of truth for LLM provider labels and key env vars |

## UX principles (fix forward)

1. **Domain language** — Registry assigns *which model* serves a *role*; Provider Keys store *secrets* (cluster secret). Never imply the registry uploads API keys.
2. **Errors** — Surface FastAPI `detail` via `apiErrorMessage` / `ApiErrorBanner`; dismissible where the user can retry.
3. **Navigation** — Sidebar is canonical; breadcrumbs in `TopBar.tsx` should label new segments (including dynamic IDs).
4. **Dark mode** — New screens use `dark:` Tailwind variants like existing pages.

## Database URL and `oc apply`

`SYNESIS_ADMIN_DATABASE_URL` in the Deployment manifest uses a **dev placeholder** password. **CloudNativePG** puts the real password in secret `synesis-admin-db-app`. **`scripts/deploy.sh`** (`ensure_admin_db`) patches the deployment with a URL-encoded connection string after the cluster is healthy.

If you run **`oc apply -k base/admin`** without going through deploy, the live DB URL can be reset to the placeholder → **migration auth failures** and restarts. Re-run **`./scripts/deploy.sh`** (or patch the env from the secret as in deploy.sh).

## Related docs

- [docs/admin/TODO.md](../../docs/admin/TODO.md) — backlog, API explorer, future admin MCP.
- [`.cursor/rules/admin-ui.mdc`](../../.cursor/rules/admin-ui.mdc) — Cursor guidance for this UI.
