# OpenFGA Authorization — Enforcement Architecture

OpenFGA is the **single authorization decision point** across planner-ts,
yarn-ts, and admin. Staged rollout and deterministic fallback engines have
been removed. Schema source of truth: `authz/openfga/schema.fga`.

## Principal contract (all callers)

Every request to planner-ts or yarn-ts must carry a **non-forgeable principal**:

| Path | Identity source | Validation |
|------|----------------|------------|
| End-user PAT (`syn-*`) | Bearer token → Postgres lookup | DB hash match; `user_id`, `org_id`, `tenant_ids`, `role`, `scopes` from row |
| Keycloak JWT | Bearer token → JWKS verification | `sub` claim = principal ID |
| Internal gateway (forwarded) | `SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN` match + `x-openwebui-*` headers | Only trusted when bearer equals internal service token |

**No internal shortcut exists.** MCP servers, Yarn, or any service calling
planner RAG endpoints must use the end-user's PAT/JWT or the internal
service token path with forwarded identity. Planner-ts runs FGA checks on
the resolved principal identically for all paths.

## Authorization flow

1. **Identity resolve** — PAT DB lookup or JWT verification
2. **Scope check** — PAT `tokenScopes` must include required prefix (`model:` for planner, `coder:` for yarn)
3. **OpenFGA check** — `user:<id>` + `can_invoke` on `planner_endpoint:chat_completions` (or `yarn_endpoint:completions`)
4. **RAG gate** (planner only) — `can_read_public` or `can_read_org`/`can_read_tenant` on `rag_catalog:default` before retrieval
5. **Milvus scope filter** — data-plane visibility/ACL enforcement

## Environment variables (all services)

- `SYNESIS_OPENFGA_API_URL`
- `SYNESIS_OPENFGA_STORE_ID`
- `SYNESIS_OPENFGA_MODEL_ID`
- `SYNESIS_OPENFGA_AUTH_TOKEN`

## MCP / Yarn → planner

Yarn or MCP tools that call planner endpoints forward the **user's bearer
token** in the `Authorization` header. Planner validates it as any other
request — no delegation shortcut. If machine-to-machine credentials are
needed in the future, model a `service:yarn` type in the FGA schema with
`delegate` relation.
