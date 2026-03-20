# Synesis Admin — backlog and doc/UX gaps

Single-operator deploy (`deploy.sh`) is the target; we fix forward without legacy compatibility.

## API discoverability

- [ ] **Ship an API explorer in-cluster or linked from the admin UI** — e.g. embed [Scalar](https://github.com/scalar/scalar), [Stoplight Elements](https://github.com/stoplightio/elements), or serve Swagger UI at a stable URL. FastAPI already exposes OpenAPI at `/api/openapi.json` and interactive docs at `/api/docs` and ReDoc at `/api/redoc` (same origin as the admin service).
- [ ] **Publish OpenAPI externally** — optional: export `openapi.json` into docs or CI artifacts for versioned API reference.
- [ ] **Consistent error bodies** — prefer `{ "detail": "..." }` or validation `{ "detail": [...] }` everywhere; frontend uses [`apiErrorMessage`](../../base/admin/frontend/src/api/errorMessage.ts).

## Admin MCP (for in-app assistant) — not designed here

- [ ] **MCP server over the admin JSON API** — expose tools such as `list_traces`, `get_trace`, `list_models`, `get_health`, aligned with `/api/v1/*` routes and OpenAPI. Goal: the **Admin Assistant** (or a Cursor MCP) can navigate and answer operational questions without duplicating business logic.
- [ ] **Auth model** — PAT or OAuth scopes for MCP clients; rate limits; read-only vs admin tools.

## Features implied by docs or UI that need finishing

- [ ] **Ingestion sources UI** — backend hooks exist (`useIngestionSources`, `useCreateIngestionSource` were imported then removed as unused); wire a minimal “sources” panel or remove API surface until ready.
- [ ] **System Config** — page is read-only; if settings should be editable, add PUT endpoints + audit log + confirm destructive changes.
- [ ] **SSE `/api/v1/events`** — verify the admin dashboard subscribes and invalidates caches everywhere it should (traces, etc.).

## UX consistency (ongoing)

- [ ] **Breadcrumbs** — extend `breadcrumbLabels` / `breadcrumbSegmentLabel` in `TopBar.tsx` when adding routes.
- [ ] **Mutations** — use [`ApiErrorBanner`](../../base/admin/frontend/src/components/common/ApiErrorBanner.tsx) for user-visible failures; reset mutation state on modal close.
- [ ] **Terminology** — “Provider API Keys” for the settings screen; “Model Registry” for role ↔ model assignment; keep in sync with [`provider_catalog.py`](../../base/admin/app/services/provider_catalog.py).
