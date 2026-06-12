# OpenFGA Authorization Design

This document describes the current planner authorization model. The active
implementation is TypeScript under `base/planner-ts/src/auth/`; the shared
authorization schema lives in `authz/openfga/schema.fga`.

## Goals

- Resolve a non-forgeable principal before planner work begins.
- Require explicit model access for chat completions.
- Derive RAG scope from the authenticated principal, not from user-controlled
  request-body hints.
- Make authorization decisions observable through trace IDs, headers, logs, and
  health endpoints.
- Fail closed when OpenFGA is required but unavailable or denies access.

## Identity Resolution

`src/auth/resolver.ts` resolves each request into `AuthContext`.

| Identity path | When accepted | Resulting auth method |
|---------------|---------------|-----------------------|
| Synesis PAT (`syn-*`) | Token hash resolves in admin Postgres and is not expired/revoked | `pat` |
| Internal service token + forwarded identity headers | `SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS=true`, bearer token matches `SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN`, and forwarded headers parse cleanly | `internal_service` with `trustedForwardedIdentity=true` |
| Internal service token only | Bearer token matches `SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN` | `internal_service` |
| Opaque bearer | `SYNESIS_PLANNER_TS_ALLOW_OPAQUE_BEARER=true` | `bearer` |
| Anonymous | Bearer auth is not required and no token is present | `anonymous` |

Strict forwarded identity mode rejects requests that include forwarded identity
headers unless the internal service token validates. This prevents an internet
client from forging Open WebUI-style user headers.

## Chat Completion Authorization

`src/auth/policy-engine.ts` authorizes `POST /v1/chat/completions`.

Current checks:

1. The resolved principal must have a token scope beginning with `model`.
2. OpenFGA must allow:

```text
user:<auth.userId> can_invoke planner_endpoint:chat_completions
```

OpenFGA client setup is in `src/auth/openfga-client.ts`.

Required environment for live OpenFGA checks:

- `SYNESIS_OPENFGA_API_URL`
- `SYNESIS_OPENFGA_STORE_ID`
- `SYNESIS_OPENFGA_MODEL_ID` (recommended/pinned in production)
- `SYNESIS_OPENFGA_AUTH_TOKEN` when the OpenFGA server requires it

If the OpenFGA client is not configured, or the check throws, `fgaCheck()`
returns a denied result with a resolution such as `openfga_not_configured` or
`openfga_error: ...`. The policy engine then rejects the request.

## Knowledge And RAG Authorization

Knowledge routes use `authorizeKnowledgeRoute()` in `src/app.ts` and retrieval
helpers in `src/retrieval/rag-client.ts`.

Routes:

- `POST /v1/knowledge/search`
- `POST /v1/knowledge/bundle`
- `POST /v1/knowledge/resolve-pack`

Scope derivation:

- PAT/JWT-like principals contribute `orgId`, `tenantIds`, user ID, and ACL
  groups from the trusted auth context.
- Trusted forwarded identity headers can carry user/org/tenant/ACL context only
  through the internal service-token path.
- Request-body scope hints such as `caller_org_id`, `caller_tenant_ids`,
  `caller_acl_groups`, and `caller_user_id` are ignored on public knowledge
  routes and logged as ignored when present.

NornicDB graph nodes written by the indexer can carry:

- `visibility_scope`
- `org_id`
- `tenant_id`
- `owner_user_id`
- `conversation_id`
- `acl_mode`
- `acl_group_ids`
- `authz_object_id` such as `rag_doc:<doc_id>`

Retrieval enforcement has two layers:

1. Cypher predicates apply principal-derived visibility, tenant, owner,
   conversation, ACL, pack, metadata, version, branch, commit, and temporal
   filters to seed nodes and graph-expanded neighbor nodes.
2. When `SYNESIS_RAG_AUTHZ_MODE=enforce`, protected/non-global rows are also
   checked through OpenFGA `can_read` on their `rag_doc:*` object before they
   can be returned.

`SYNESIS_RAG_AUTHZ_MODE=audit` keeps the structural predicates and diagnostics
but does not make row-level OpenFGA reads a blocking requirement. Use `enforce`
for production tenant isolation.

## Observability

Planner sets these response headers on protected flows:

- `x-synesis-authz-trace-id`
- `x-synesis-authz-engine`
- `x-synesis-authz-rules` where applicable

Operational endpoints:

- `GET /health/detailed` includes policy counters and OpenFGA config presence.
- `GET /health/authz-events` returns recent policy decisions.
- Knowledge search responses include `authz_trace_id` and `authz_mode`.

Structured logs include authz trace IDs for allow/deny decisions and ignored
body-scope hints.

## Service-To-Service Guidance

Services that call planner on behalf of a user should preserve the user's PAT or
use the internal service token plus trusted forwarded identity headers. Do not
invent service-only bypasses for user-scoped access.

If future machine-to-machine privileges are needed, model them explicitly in
OpenFGA, for example with a `service:yarn` type and delegation relation. Do not
special-case them in planner route code.
