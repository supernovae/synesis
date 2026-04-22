# synesis-admin-mcp-ts

TypeScript-owned MCP transport and tool orchestration layer for Synesis Admin.

## What It Owns

- Admin tool catalog contract (name, description, JSON schema, minimum role)
- Tool invocation routing to Admin API endpoints
- Streamable MCP endpoint (`/mcp`) for MCP clients
- JSON utility endpoints used by the Admin Assistant:
  - `GET /v1/admin-tools`
  - `POST /v1/admin-tools/invoke`

## Auth + RBAC

- Uses the same bearer token as Admin UI requests.
- Validates session via `GET /api/v1/auth/me`.
- Enforces **admin-only** access (`org_admin` / `platform_admin`) for all Admin MCP tools.
- Per-tool role checks still apply (`platform_admin` for privileged operations like reconcile/purge/ingestion edits).
- Legacy Python compatibility endpoints (`/api/v1/internal/mcp/*`) are retained for older callers but are no longer the primary source of truth.

## Transition Calibration Tooling

The TS-owned catalog includes transition-quality operational tools:

- `yarn_transition_quality`
- `yarn_transition_events_tail`
- `yarn_transition_watch`
- `yarn_transition_incident_brief`

These call Admin API Yarn telemetry endpoints (including `GET /api/v1/yarn/transition-events`) and keep live debugging workflows available in Admin Assistant without Python-side MCP duplication.

