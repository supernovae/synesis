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
4. **RAG structural filter** (planner only) — NornicDB visibility/ACL predicates derived from the resolved principal, applied to vector seed nodes and graph-expanded neighbor nodes
5. **RAG row enforcement** (planner only, `SYNESIS_RAG_AUTHZ_MODE=enforce`) — OpenFGA `can_read` on indexed `rag_doc:*` objects before non-global/restricted/private rows are returned

## RAG enforcement details

The public knowledge-search route ignores request-body org, tenant, ACL, and
user scope hints. Scope is derived from the authenticated principal or from
trusted forwarded identity headers when the bearer token equals the internal
service token.

Indexer-written graph nodes carry:

- `visibility_scope`, `org_id`, `tenant_id`, `owner_user_id`, `conversation_id`
- `acl_mode`, `acl_group_ids`
- `authz_object_id`, normally `rag_doc:<doc_id>`

NornicDB predicates provide the fast fail-closed data-plane filter. OpenFGA is
the final object decision point for protected rows when enforcement mode is
enabled.

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
