# synesis-admin-mcp-ts

TypeScript-owned MCP transport and tool orchestration layer for Synesis Admin.

## What It Owns

- Admin tool catalog contract (name, description, JSON schema, minimum role)
- Tool invocation routing to Admin API endpoints
- Internal Streamable MCP endpoint (`/mcp`) for Admin API-mediated clients
- JSON utility endpoints used by the Admin Assistant:
  - `GET /v1/admin-tools`
  - `POST /v1/admin-tools/invoke`

## Auth + RBAC

- Requires `SYNESIS_INTERNAL_SERVICE_TOKEN` from the Admin API before processing requests.
- Validates the delegated Admin UI session/PAT via `GET /api/v1/auth/me`.
- Exposes a small authenticated user-safe tool set (`user`) plus curated Admin Ops tools (`org_admin` / `platform_admin`).
- Direct user bearer/PAT calls to `synesis-admin-mcp-ts` are rejected; callers must go through the Admin API.
- Per-tool role checks still apply (`platform_admin` for privileged operations like reconcile/purge/ingestion edits).
- Legacy Python compatibility endpoints (`/api/v1/internal/mcp/*`) have been removed; this service is the source of truth for Admin Assistant and support-safe MCP tools.

## Transition Calibration Tooling

The TS-owned catalog includes transition-quality operational tools:

- `yarn_transition_quality`
- `yarn_transition_events_tail`
- `yarn_transition_watch`
- `yarn_transition_incident_brief`

These call Admin API Yarn telemetry endpoints (including `GET /api/v1/yarn/transition-events`) and keep live debugging workflows available in Admin Assistant without Python-side MCP duplication.
