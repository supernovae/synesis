# Yarn Request Pipeline Map

This document maps the production TypeScript Yarn request path. Use it when changing request normalization, context injection, tool handling, provider execution, streaming, telemetry, or operational routes.

## Entrypoints

| Entrypoint | Primary files | Notes |
| --- | --- | --- |
| OpenAI chat | `src/routes/openai-chat-completions-route.ts`, `src/pipeline/openai-chat-pipeline.ts` | Handles `/v1/chat/completions` streaming and non-streaming requests. |
| Claude messages | `src/routes/claude-messages-route.ts`, `src/pipeline/claude-messages-route-preparation.ts`, `src/streaming/claude-*` | Handles `/v1/messages` and Claude-style event streams. |
| Responses compatibility | `src/routes/responses-routes.ts`, `src/responses-compat.ts` | Converts `/v1/responses` input into the OpenAI chat path. |
| Model and platform routes | `src/routes/platform-routes.ts`, `src/routes/model-routes.ts`, `src/routes/health-routes.ts`, `src/routes/diagnostics-routes.ts` | Health, metrics, diagnostics, model catalog, artifacts, preferences, and Claude helpers. |
| MCP HTTP tools | `src/mcp/index.ts`, `src/server/non-chat-routes.ts` | Catalog and tool-call surface under `/v1/mcp/*`. |
| Tool collapse | `src/tool-collapse/routes.ts`, `src/tool-collapse/index.ts` | Plans compact batch-tool calls under `/v1/coder/tool-collapse/plan`. |
| Eval gym | `src/eval/routes.ts` | Scenario execution, observer, result, and export endpoints. |
| ACP bridge | `src/acp/synesis-yarn-acp-agent.ts` | Local ACP adapter that calls Yarn's OpenAI-compatible endpoint. |

Routes are registered from `src/yarn-server.ts` through `src/server/route-registration.ts` and `src/server/non-chat-routes.ts`.

## Shared Chat Pipeline

### 1. Ingress And Auth

Requests enter through Fastify route handlers. Route-level schemas reject malformed payloads before provider calls. Auth is resolved by `src/auth.ts`:

- `syn-` personal access tokens are checked against the admin database.
- OIDC bearer tokens are verified through the configured issuer and client settings.
- Opaque bearer tokens are accepted only when explicitly enabled.

Coder chat and MCP routes require coder-capable scopes. Model routes require model-read scopes. Internal routes require `SYNESIS_INTERNAL_SERVICE_TOKEN`.

### 2. Protocol Normalization

Protocol-specific preparation converts client payloads into Yarn's internal request shape:

- OpenAI: `src/pipeline/openai-route-normalization.ts` and `src/pipeline/openai-context-preparation.ts`
- Claude: `src/pipeline/claude-messages-route-preparation.ts`
- Responses: `src/responses-compat.ts`

Normalization handles tool descriptions, reasoning options, message structure, metadata, selected headers, and client capability hints. This is the right layer for protocol compatibility fixes.

### 3. Session And Workspace Attribution

Yarn derives a session identity from request metadata, auth attribution, and client-provided execution context. The main helpers are:

- `src/session/session-key.ts`
- `src/session/protocol-session.ts`
- `src/adapters/session-execution-context.ts`
- `src/state/workspace-session-boundary.ts`
- `src/state/route-session-helpers.ts`

This stage attaches user, org, workspace, project-root, conversation, and durable work-packet context when available. It also protects implicit sessions from accidental cross-workspace carryover.

### 4. Request Hardening

Before context expansion, Yarn applies deterministic cleanup and bounds:

- Tool-output trimming and reduction: `src/reduction/tool-result-reducer.ts`
- Transcript pruning: `src/reduction/transcript-pruning.ts`
- Ingress caps: `src/reduction/ingress-cap.ts`
- Validation normalization: `src/validation/service.ts`
- Tool argument hardening and envelope normalization in the route pipeline
- Per-user and global rate limits through `src/middleware/user-rate-limit.ts`

These passes should stay fail-closed for invalid tool payloads and fail-soft for non-critical telemetry.

### 5. Context Assembly

Context is built from bounded services instead of raw unbounded history:

- Working frame: `src/frame/working-frame-service.ts`
- Project manifest: `src/project/project-manifest-service.ts`
- Stable prefix and cache hints: `src/context/stable-prefix.ts`, `src/providers/prefix-optimizer/*`
- Attention positioning: `src/context/attention-positioning.ts`
- Evidence prefetch: `src/evidence/fast-path.ts`
- Knowledge search affordances: `src/state/knowledge-search.ts`
- Web search affordances: `src/state/web-search.ts`
- Session continuity and pause state: `src/context/session-continuity.ts`, `src/session/protocol-pause-state.ts`

Only emit or document a retrieval phase when the relevant path actually runs. Evidence prefetch is latency bounded and may be dropped if it misses the budget.

### 6. Governance

Governance is applied as route context and deterministic provider prechecks:

- Task intake and plan graph: `src/upper-harness/bridge.ts`, `src/planning/*`
- Execution governor: `src/governance/execution-governor.ts`, `src/governance/governor-service.ts`
- Sensemaking governor: `src/governance/sensemaking-governor.ts`
- Deterministic policy engine: `src/policy/deterministic-policy-engine.ts`
- Tool-progress detection: `src/policy/tool-progress-detector.ts`
- Recovery prompts and read gates: `src/tools/tool-execution-recovery.ts`

The governor can allow, nudge, pause, soft-fail, or hard-reject depending on configured policy and observed tool progress. Route code must keep the original user request and provider transcript distinguishable from governance blocks.

### 7. Tool Schema Preparation

Tool schemas are adapted to the selected client and model:

- Client capability detection: `src/adapters/client-tool-capabilities.ts`
- Client adapter packs: `src/adapters/client-adapter-packs.ts`
- Tool schema pruning and OpenClaw handling in route preparation
- Tool collapse planning: `src/tool-collapse/*`
- MCP registry and validation: `src/mcp/index.ts`, `src/mcp/tool-registry.ts`

Do not expose tools solely because they exist in the registry. The final tool set must respect auth, OpenClaw policy, client capability, model limitations, and request bounds.

### 8. Provider Resolution

The selected `model` or role is resolved through:

- `src/providers/admin-tier-registry.ts`
- `src/providers/synesis-provider.ts`
- `src/providers/provider-request-support.ts`
- `src/providers/model-architecture-profile.ts`
- `src/prompt/infer-model-family.ts`
- `src/pipeline/provider-options.ts`

Admin-managed model roles are preferred. Local provider fallback variables are compatibility controls, not the main production configuration path.

### 9. Provider Execution

Provider calls use the Vercel AI SDK:

- OpenAI-compatible non-stream and stream execution: `src/pipeline/openai-chat-provider-execution.ts`, `src/streaming/openai-*`
- Claude-compatible non-stream and stream execution: `src/streaming/claude-*`
- Circuit breaker support: `src/providers/circuit-breaker.ts`
- Output-token safety clamp: `src/providers/output-token-safety.ts`
- Stream admission: `src/middleware/stream-admission.ts`

Streaming routes must preserve protocol-specific event shapes. Operational status, diagnostics, and telemetry should use side channels where available and must not be injected into the final assistant response unless a documented fallback path requires it.

### 10. Post-Processing And Persistence

After provider execution, Yarn records and persists:

- Usage telemetry: `src/state/usage-writer.ts`
- Request diagnostics: `src/telemetry/request-diagnostics.ts`
- Session events: `src/state/session-event-recorder.ts`
- Session persistence: `src/state/session-persistence-runner.ts`
- Artifact handles: `src/state/artifact-store.ts`, `src/state/artifact-retrieval.ts`
- Cache shape and prefix telemetry: `src/telemetry/cache-policy-controller.ts`
- OpenTelemetry spans and Prometheus metrics: `src/telemetry/*`

Failures in non-critical telemetry paths should be logged without failing the chat response.

## Protocol-Specific Notes

### OpenAI Chat

The OpenAI path is centered on `OpenAIChatPipeline` in `src/pipeline/openai-chat-pipeline.ts`. It supports streaming and non-streaming calls, OpenAI-compatible tool calls, provider reasoning options, route governance, and post-enrichment finalization.

Mutation-sensitive areas:

- Request body normalization and schema validation
- Tool-call and tool-result ordering
- Stream chunk formatting
- Usage accounting and final response shape
- Stable prefix layout before provider execution

Run targeted tests after changes:

```bash
npm --workspace synesis-yarn-ts run test:openai-conformance
```

### Claude Messages

The Claude path keeps Claude message semantics while sharing the same provider, context, governance, and telemetry systems where possible.

Mutation-sensitive areas:

- Claude content-block conversion
- Stream event names and ordering
- Tool-use/tool-result pairing
- Claude command execution helpers
- Client adapter hints and task-list tool preferences

Use the Claude stream and protocol parity tests when touching this path.

### Responses Compatibility

`/v1/responses` is a compatibility surface that forwards into the OpenAI chat path. Avoid adding independent behavior here unless a Responses-specific input shape cannot be represented by chat completions.

### MCP HTTP Tools

The MCP HTTP surface validates tool names, arguments, auth, concurrency limits, OpenClaw policy, and tool execution bounds before dispatch. It shares Synesis platform tool handlers with other MCP surfaces through `@synesis/mcp-tools`.

### ACP Bridge

The ACP adapter is a local client bridge. It maintains its own client-facing protocol state but calls Yarn through `/v1/chat/completions`, so provider routing and runtime governance remain centralized.

## State Boundaries

| State | Storage | Owner |
| --- | --- | --- |
| Request-local normalized messages | Memory | Route pipeline |
| Active session memory | Redis and in-process helpers | Yarn |
| Usage and session events | Admin database when configured | Yarn and admin |
| Runtime preferences | Redis/admin-backed store | Admin and Yarn |
| Provider roles and model settings | Admin API/database | Admin |
| Artifacts | In-memory store plus optional Redis replica | Yarn |
| Metrics | Prometheus registry | Yarn |

Keep these boundaries explicit. Do not move secrets, raw provider tokens, or private tool outputs into diagnostics or session events.

## Safe Change Checklist

Before merging a request-pipeline change:

1. Identify whether the change affects OpenAI, Claude, Responses, MCP, ACP, or internal routes.
2. Confirm auth and scope behavior still matches the route type.
3. Verify tool-call and tool-result ordering for streaming and non-streaming paths.
4. Confirm context blocks are bounded and do not duplicate large transcripts.
5. Check that provider options are only sent when supported by the model family or adapter.
6. Run focused protocol tests plus `npm --workspace synesis-yarn-ts run typecheck`.
7. For production-facing changes, inspect diagnostics and logs for token or secret exposure.

## Validation Commands

```bash
npm --workspace synesis-yarn-ts run typecheck
npm --workspace synesis-yarn-ts test
npm --workspace synesis-yarn-ts run test:openai-conformance
npm --workspace synesis-yarn-ts run test:governor:unit
```

Use live verification only against an environment with configured providers:

```bash
npm --workspace synesis-yarn-ts run verify:live
npm --workspace synesis-yarn-ts run verify:cache-canaries
```
