# planner-ts

`base/planner-ts` is the active Synesis chat runtime. It is a TypeScript
Fastify service that exposes OpenAI-compatible chat endpoints, runs the planner
graph, performs retrieval, emits Open WebUI status events, and records authz,
usage, and trace metadata. Treat this directory, the Helm chart, and the docs
under `docs/chat/` as the current source of truth.

## Runtime Shape

| Concern | Current implementation |
|---------|------------------------|
| API server | `src/app.ts` builds the Fastify app; `src/index.ts` only loads config and starts it |
| Request schema | `src/api-schemas.ts` and `src/contracts/schemas.ts` use Zod contracts |
| Graph execution | `src/graph.ts` runs node transitions over `GraphState` |
| Node behavior | `src/pipeline.ts` plus `src/nodes/*` |
| Retrieval | `src/retrieval/*`, owned by the router path |
| Streaming | `src/streaming/sse.ts`, `phases.ts`, and `status-events.ts` |
| Auth/authz | `src/auth/*`; policy decisions are correlated by `x-synesis-authz-trace-id` |
| Session continuity | `src/context/session-manager.ts` and `session-store.ts` |
| Prompt/model metadata | Admin-backed prompt registry, public model catalog, and capability matrix polling |

## Public And Operator Routes

Public OpenAI-compatible routes:

- `GET /v1/models`
- `POST /v1/chat/completions`

Planner-owned knowledge/search routes:

- `POST /v1/knowledge/search`
- `POST /v1/knowledge/bundle`
- `POST /v1/knowledge/resolve-pack`
- `POST /v1/web/search`

Operational routes:

- `GET /health`
- `GET /health/readiness`
- `GET /health/detailed` (internal service token required)
- `GET /health/deps` (internal service token required)
- `GET /health/authz-events` (internal service token required)
- `GET /health/failures` (internal service token required)
- `GET /metrics` (internal service token required)
- `GET /debug/retrieval-config` (internal service token required)
- `GET /debug/session-stats` (internal service token required)
- `DELETE /v1/memory/:conversationId`

## Planner Graph

The graph currently flows:

```text
entry_pipeline -> planner -> plan_gate -> router -> writer -> critic -> final_scrubber -> respond
```

Important loops and exits:

- `critic -> router` when evidence is insufficient.
- `critic -> writer` when a bounded rewrite is needed.
- `critic -> final_scrubber` for terminal cleanup, anti-oscillation, or max-iteration pressure.
- `plan_gate -> respond` when the request is clarification-oriented or should not proceed.

Node responsibilities:

- `entry_pipeline`: deterministic classification, optional frame extraction, difficulty/RAG/plan policy.
- `planner`: LLM-backed plan generation when enabled, deterministic fallback otherwise.
- `plan_gate`: validates plan structure and gates unsafe or incomplete plans.
- `router`: the only graph node that invokes retrieval clients and emits evidence packets.
- `writer`: composes streamed or non-streamed markdown answers.
- `critic`: checks evidence sufficiency, contract adherence, and revision need.
- `final_scrubber`: removes internal scaffolding and applies final output guards.

## Retrieval Paradigm

Retrieval is router-governed. Writer and critic consume evidence packets; they do
not call retrieval clients directly.

Current retrieval behavior:

1. Router calls the unified retrieval client when task policy allows RAG/web retrieval.
2. NornicDB RAG uses configured BGE/TEI embedding, vector search, Cypher metadata filters, graph expansion, freshness/authority signals, and optional reranking.
3. Web search only runs when `SYNESIS_WEB_SEARCH_ENABLED=true` and `SYNESIS_WEB_SEARCH_URL` is set.
4. RAG and web results are merged with reciprocal-rank fusion.
5. Context budgeting selects the evidence passed to writer/critic.

Security invariant: public knowledge routes ignore caller-supplied org, tenant,
ACL, and user scope hints. Scope is derived from the resolved authenticated
principal or from trusted forwarded identity headers.

## Auth And Authorization

Identity resolution lives in `src/auth/resolver.ts`.

Supported request identities:

- Synesis PATs (`syn-*`) resolved from the admin database.
- Trusted forwarded identity from Open WebUI or another internal gateway when
  the bearer token equals `SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN`.
- Opaque bearer compatibility when `SYNESIS_PLANNER_TS_ALLOW_OPAQUE_BEARER=true`.
- Anonymous compatibility only when bearer auth is not required.

Authorization lives in `src/auth/policy-engine.ts` and
`src/auth/openfga-client.ts`.

For `POST /v1/chat/completions`, the policy engine requires:

- a token scope with the `model` prefix, and
- OpenFGA `can_invoke` on `planner_endpoint:chat_completions`.

If OpenFGA is not configured or the check fails, authorization fails closed.
Local/dev deployments that need compatibility must explicitly choose relaxed
auth settings and understand that they are not production posture.

RAG isolation combines:

- principal-derived Cypher predicates for fast structural filtering, and
- optional OpenFGA row checks for protected `rag_doc:*` objects when
  `SYNESIS_RAG_AUTHZ_MODE=enforce`.

See [`OPENFGA_AUTHZ_DESIGN.md`](OPENFGA_AUTHZ_DESIGN.md).

## Streaming And Open WebUI

Default streaming returns strict OpenAI-compatible
`chat.completion.chunk` SSE frames.

Visible Open WebUI status uses the side-channel event endpoint when all of these
are available:

- `SYNESIS_PLANNER_TS_OPENWEBUI_BASE_URL`
- `SYNESIS_PLANNER_TS_OPENWEBUI_EVENT_TOKEN`
- Open WebUI chat/message metadata

`SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS=openwebui-data` keeps the legacy
in-band Open WebUI status envelope available for local debugging or deployments
that cannot use side-channel events. Do not use it to mix internal status text
into final assistant answers.

## Configuration Groups

All planner-specific runtime toggles are in `src/config.ts`.

Primary groups:

- API/server: `PORT`, `HOST`, `LOG_LEVEL`
- LLM: `SYNESIS_PLANNER_TS_LLM_*`
- Model roles: `SYNESIS_PLANNER_TS_PLANNER_MODEL`, `WRITER_MODEL`, `CRITIC_MODEL`
- Auth: `SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH`,
  `SYNESIS_PLANNER_TS_ALLOW_OPAQUE_BEARER`,
  `SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS`,
  `SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE`
- OpenFGA: `SYNESIS_OPENFGA_*`
- Sessions/Redis: `SYNESIS_PLANNER_TS_REDIS_*`,
  `SYNESIS_PLANNER_TS_SESSION_*`
- Retrieval/RAG: `SYNESIS_NORNIC_*`, `SYNESIS_EMBEDDER_*`,
  `SYNESIS_BGE_RERANKER_URL`, `SYNESIS_RAG_*`
- Web search: `SYNESIS_WEB_SEARCH_*`
- Open WebUI events: `SYNESIS_PLANNER_TS_OPENWEBUI_*`,
  `SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS`
- Rate/stream limits: `SYNESIS_PLANNER_TS_RATE_LIMIT_*`,
  `SYNESIS_PLANNER_TS_STREAM_*`

## Development Commands

From the repository root:

```bash
npm test -w synesis-planner-ts
npm run typecheck -w synesis-planner-ts
npm run verify:gates -w synesis-planner-ts
```

Useful focused tests:

```bash
npm run test -w synesis-planner-ts -- tests/api-contract.test.ts tests/sse-conformance.test.ts
npm run test -w synesis-planner-ts -- tests/auth-resolver.test.ts tests/search-route-auth.test.ts tests/rag-scope-isolation.test.ts
npm run test -w synesis-planner-ts -- tests/golden-replay.test.ts
```

Optional local compose smoke:

```bash
cp .env.example .env
podman compose -f podman-compose.yaml up -d planner redis postgres
curl http://localhost:8082/health
```

## Related Docs

- [`docs/chat/WORKFLOW_PLANNER.MD`](../../docs/chat/WORKFLOW_PLANNER.MD)
- [`docs/chat/PLANNER_OPENAI_COMPATIBILITY.md`](../../docs/chat/PLANNER_OPENAI_COMPATIBILITY.md)
- [`docs/chat/OPENWEBUI_PHASES.md`](../../docs/chat/OPENWEBUI_PHASES.md)
- [`docs/chat/PLANNER_MEMORY_LIFECYCLE.md`](../../docs/chat/PLANNER_MEMORY_LIFECYCLE.md)
- [`docs/chat/planner-scaling.md`](../../docs/chat/planner-scaling.md)
