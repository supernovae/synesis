# Synesis Yarn TS

Yarn is the TypeScript runtime that powers Synesis coder conversations. It exposes OpenAI-compatible, Claude-compatible, ACP, MCP, and operational APIs while coordinating provider selection, context shaping, tool safety, governance, session persistence, telemetry, and response streaming.

This package is the current Yarn implementation. Treat it as the source of truth for Yarn runtime behavior.

## What Yarn Does

- Serves chat APIs for OpenAI-compatible clients, Claude-compatible clients, and the Responses compatibility endpoint.
- Resolves Synesis model roles through the admin tier registry and provider configuration.
- Applies request normalization, schema hardening, rate limits, auth checks, and per-user runtime preferences.
- Builds context from session state, workspace hints, project manifests, working frames, evidence prefetch, and knowledge search tools.
- Manages tool execution safety with MCP tool validation, OpenClaw policy support, tool-result reduction, artifact handles, and tool-loop governance.
- Preserves streaming compatibility while recording usage, request diagnostics, session events, cache hints, and Prometheus metrics.
- Provides an ACP bridge through the `synesis-yarn-acp` binary for clients that speak Agent Client Protocol.

## Runtime Surfaces

| Surface | Route or entrypoint | Auth | Purpose |
| --- | --- | --- | --- |
| OpenAI chat | `POST /v1/chat/completions` | Coder token required | Main OpenAI-compatible chat and streaming endpoint. |
| Claude messages | `POST /v1/messages` | Coder token required | Claude-compatible messages endpoint with streaming and non-streaming support. |
| Responses compatibility | `POST /v1/responses` | Coder token required | Translates Responses-style requests to chat completion handling. |
| Model catalog | `GET /v1/models`, `GET /v1/models/:model` | Model-read token required | Lists model roles and available configured offerings. |
| Health | `GET /health`, `GET /health/readiness` | Public | Liveness and Redis-backed readiness checks. |
| Internal health and metrics | `GET /health/detailed`, `GET /metrics`, `GET /health/telemetry` | Internal service token required | Operational state and Prometheus metrics. |
| Diagnostics | `GET /v1/diagnostics/*` | Internal service token required | Request diagnostics, cache shapes, and model architecture details. |
| Preferences | `GET/PUT /v1/user-runtime-preferences/:userId` | Internal service token required | Runtime preference persistence for admin-managed users. |
| Artifacts | `GET /v1/artifacts/:id` | Internal service token required | Retrieves server-side artifact payloads. |
| MCP tools | `GET /v1/mcp/tools`, `POST /v1/mcp/tools/call` | Coder token required | HTTP MCP tool catalog and call surface. |
| Tool collapse | `POST /v1/coder/tool-collapse/plan` | Coder token required | Plans compact Synesis batch-tool calls. |
| Eval gym | `GET/POST /v1/eval/*` | Eval/internal auth | Scenario, observer, result, and export endpoints for validation workflows. |
| Claude helpers | `GET /v1/claude/*`, `POST /v1/claude/commands/execute` | Route-specific auth | Client bootstrap, model resolution, and command handling. |
| ACP bridge | `synesis-yarn-acp` | Client-side process config | ACP adapter that calls Yarn's OpenAI-compatible endpoint. |

## Request Pipeline

The detailed pipeline is documented in [REQUEST_PIPELINE_MAP.md](./REQUEST_PIPELINE_MAP.md). At a high level:

1. Fastify receives the request and validates the route-specific schema.
2. Auth resolves a PAT, OIDC token, or explicitly enabled opaque bearer token.
3. Protocol normalization converts OpenAI, Claude, or Responses input into Yarn's internal message and tool model.
4. Session identity, workspace metadata, client adapter packs, runtime preferences, and pause state are attached.
5. Context services add working frames, project manifests, structural hints, stable prefix layout, evidence prefetch, knowledge-search affordances, and task/governance blocks.
6. Tool schemas are normalized, reduced, sorted, filtered, or collapsed according to client capability and OpenClaw policy.
7. Provider routing resolves the selected model role to an admin-managed provider offering and adapter hints.
8. The Vercel AI SDK executes non-streaming or streaming provider calls.
9. Post-processing records telemetry, usage, diagnostics, session state, artifacts, and final response formatting.

## Authentication

Yarn supports three auth modes:

- Synesis personal access tokens beginning with `syn-`, validated against the admin database.
- OIDC bearer tokens verified through the configured issuer, client IDs, roles, and JWKS cache.
- Opaque bearer tokens only when `SYNESIS_YARN_ALLOW_OPAQUE_BEARER=true` is explicitly set for compatibility.

Coder routes require coder-capable scopes. Model catalog routes require model-read scopes. Internal operational routes require `SYNESIS_INTERNAL_SERVICE_TOKEN`.

For production, configure:

- `SYNESIS_YARN_ADMIN_DB_URL`
- `SYNESIS_PAT_PEPPER`
- `SYNESIS_REQUIRE_PAT_PEPPER=true`
- OIDC issuer/client/role settings when identity-provider auth is used
- `SYNESIS_INTERNAL_SERVICE_TOKEN`

## Local Development

From the repository root:

```bash
npm install
npm --workspace synesis-yarn-ts run dev
```

The service defaults to `PORT=8000` and `HOST=0.0.0.0`.

Build and test:

```bash
npm --workspace synesis-yarn-ts run typecheck
npm --workspace synesis-yarn-ts test
npm --workspace synesis-yarn-ts run test:openai-conformance
```

Useful validation scripts:

```bash
npm --workspace synesis-yarn-ts run verify:live
npm --workspace synesis-yarn-ts run verify:cache-canaries
npm --workspace synesis-yarn-ts run eval:list
npm --workspace synesis-yarn-ts run test:governor:unit
```

## Core Configuration

Most production deployments should use Helm values and Synesis admin provider configuration instead of local-only environment overrides. The most common runtime variables are:

| Area | Variables |
| --- | --- |
| Server | `PORT`, `HOST`, `LOG_LEVEL` |
| Admin integration | `SYNESIS_YARN_ADMIN_API_URL`, `SYNESIS_YARN_ADMIN_DB_URL`, `SYNESIS_INTERNAL_SERVICE_TOKEN` |
| Auth | `SYNESIS_PAT_PEPPER`, `SYNESIS_REQUIRE_PAT_PEPPER`, `SYNESIS_YARN_ALLOW_OPAQUE_BEARER`, `SYNESIS_OIDC_*` |
| Provider fallback | `SYNESIS_YARN_DEFAULT_TIER`, `SYNESIS_YARN_OPENAI_COMPAT_BASE_URL`, `SYNESIS_YARN_OPENAI_COMPAT_API_KEY` |
| Session state | `SYNESIS_YARN_SESSION_REDIS_URL`, `SYNESIS_YARN_SESSION_TTL_MS` |
| Context admission | `SYNESIS_YARN_CONTEXT_ADMISSION_MODE`, `SYNESIS_YARN_CONTEXT_ADMISSION_WARN_TOKENS`, `SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS` |
| Context budget | `SYNESIS_YARN_CONTEXT_BUDGET_ENABLED`, `SYNESIS_YARN_CONTEXT_BUDGET_COMPACTION_MODE`, `SYNESIS_YARN_CONTEXT_BUDGET_CEILING_TOKENS` |
| Governance | `SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED`, `SYNESIS_YARN_GOVERNANCE_PROFILE`, `SYNESIS_YARN_PHASE_EXECUTION_POLICY_ENABLED` |
| MCP and RAG | `SYNESIS_YARN_MCP_TOOLS_ENABLED`, `SYNESIS_YARN_PLANNER_URL`, MCP concurrency and timeout variables |
| Telemetry | `SYNESIS_YARN_PERSIST_USAGE_TO_DB`, OpenTelemetry exporter variables, Prometheus scrape config |

See [../../docs/HELM_INSTALL.md](../../docs/HELM_INSTALL.md) and the Helm chart values for deployment-specific defaults.

## Model and harness compatibility

Model adapters preserve protocol differences without prescribing a client's file
layout, editing workflow, or commit behavior. Client identity, model identity,
and endpoint capabilities are resolved separately. See the
[harness compatibility guide](../../docs/clients/HARNESS_COMPATIBILITY.md) for
execution-context metadata and native tool-schema handling.

The [model compatibility guide](../../docs/model-compatibility.md) records supported
family/variant handling and primary sources. Current behavior includes:

- Separate Qwen3 Coder/Next sampling and general Qwen reasoning handling.
- Reasoning-content replay for supported compatible providers, including
  DeepSeek tool continuations; clients must supply the required history.
- Preserved caller thinking intent, including required tool choice. Unsupported
  endpoint combinations can still return errors.
- Full-argument failure-loop detection; repeated successful reads alone do not
  trigger the model shim's pivot guidance. Other governor controls are configured separately.
- Configured context capacity without unmeasured model-name discounts;
  explicit registry overrides remain available.

The compatible SDK provider handles the documented reasoning extension. This is
not full feature parity with every vendor API. Endpoint tool parsers, chat
templates, structured output, and sampling options need deployment validation.
Automated wire-format tests do not certify live model quality or performance.

## Context And Memory

Yarn treats client transcript context and Synesis runtime memory separately:

- Client transcript context remains part of the incoming request and is shaped conservatively.
- Synesis session state is stored in Redis and the admin database where configured.
- Working frames, project manifests, durable work packets, task ledgers, and stable prefixes are injected as bounded system context.
- Context budget compaction defaults to `minimal` so clients with their own harness behavior remain in control unless operators choose stronger compaction.

Related docs:

- [REQUEST_PIPELINE_MAP.md](./REQUEST_PIPELINE_MAP.md)
- [docs/CACHING.md](./docs/CACHING.md)
- [docs/token-optimization-architecture.md](./docs/token-optimization-architecture.md)
- [../../docs/SESSION_FRAME_COMPACTION.md](../../docs/SESSION_FRAME_COMPACTION.md)
- [../../docs/clients/SESSION_EXECUTION_CONTEXT.md](../../docs/clients/SESSION_EXECUTION_CONTEXT.md)

## Operational Notes

- `/health/readiness` depends on Redis. If Redis is unavailable, readiness returns `503`.
- `/metrics`, detailed health, diagnostics, artifacts, telemetry, and preference routes are internal surfaces and must not be exposed without the internal service token boundary.
- Provider roles, prompts, public offerings, costs, and model capabilities are polled from Synesis admin when configured.
- Usage persistence is asynchronous and bounded by queue settings so chat requests do not block on normal telemetry writes.
- Status, diagnostics, and eval artifacts should never include provider API keys or internal service tokens.

## Related Documentation

- [REQUEST_PIPELINE_MAP.md](./REQUEST_PIPELINE_MAP.md) - request lifecycle and mutation boundaries.
- [../../docs/clients/CLIENTS.md](../../docs/clients/CLIENTS.md) - client setup index.
- [../../docs/clients/SESSION_EXECUTION_CONTEXT.md](../../docs/clients/SESSION_EXECUTION_CONTEXT.md) - client-provided execution context.
- [../../docs/CODER_AGENT_ITERATION_PLAYBOOK.md](../../docs/CODER_AGENT_ITERATION_PLAYBOOK.md) - governance, status, and tracing reference.
- [../../docs/SECURITY.md](../../docs/SECURITY.md) - current security controls and known limitations.
