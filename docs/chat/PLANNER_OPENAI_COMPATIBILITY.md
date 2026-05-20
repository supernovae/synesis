# Planner OpenAI API Compatibility

This document describes the Synesis planner's OpenAI-compatible API surface, intentional Synesis extensions, auth expectations, streaming behavior, and troubleshooting guidance.

## Endpoint Reference

### `POST /v1/chat/completions`

Primary chat endpoint. Accepts OpenAI `ChatCompletion` request schema and returns an OpenAI-shaped response (non-streaming) or SSE stream (streaming).

**Supported request fields:**

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `model` | `string` | `"Synesis"` | Accepts `Synesis`, `Synesis Thinking`, `synesis-agent`, and `openai/` prefixed variants |
| `messages` | `array` | required | At least one `role: "user"` message must be present |
| `messages[].content` | `string \| null` | — | Non-string payloads are rejected by schema validation |
| `max_tokens` | `int \| null` | `null` | Fallback when `max_completion_tokens` is absent |
| `max_completion_tokens` | `int \| null` | `null` | Preferred (OpenAI spec); takes precedence over `max_tokens` |
| `stream` | `bool` | `false` | Enable SSE streaming |
| `stream_options` | `object \| null` | `null` | `{"include_usage": false}` suppresses final-chunk usage |
| `user` | `string \| null` | `null` | User ID for identity attribution |

**Ignored fields:** Unknown top-level request fields are stripped by schema parsing and do not affect planner behavior.

**Synesis extensions (non-standard fields):**

| Field | Type | Notes |
|-------|------|-------|
| `conversation_id` | `string \| null` | Conversation threading for memory/history |

### `GET /v1/models`

Returns an OpenAI Model list object. No auth required.

```json
{
  "object": "list",
  "data": [
    {"id": "Synesis", "object": "model", "created": 1704067200, "owned_by": "synesis"},
    {"id": "Synesis Thinking", "object": "model", "created": 1704067200, "owned_by": "synesis"}
  ]
}
```

### `POST /v1/feedback`

Synesis-specific endpoint for thumbs up/down feedback. Requires Bearer auth.

### `GET /health`, `GET /health/readiness`

Liveness and readiness probes. No auth required.

### `GET /metrics`

Prometheus metrics. No auth required.

## Error Envelope

All HTTP errors follow the OpenAI error object format:

```json
{
  "error": {
    "message": "Description of the error",
    "type": "invalid_request_error",
    "code": "400"
  }
}
```

**Type mapping:**

| HTTP Status | `type` |
|---|---|
| 400 | `invalid_request_error` |
| 401 | `authentication_error` |
| 403 | `permission_error` |
| 422 | `invalid_request_error` |
| 429 | `rate_limit_error` |
| 500+ | `server_error` |

Zod validation errors are surfaced as `400 invalid_request_error` with a sanitized validation message.

## Authentication

### No-auth mode (development/testing)

When `SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH=false` (default in tests), chat completions accept requests without a Bearer token. User identity falls back to request body `user` field or `"anonymous"`.

### Bearer-required mode (production)

When `SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH=true`:

1. All `/v1/chat/completions` requests must include `Authorization: Bearer <token>`
2. Missing Bearer returns `401` with OpenAI error envelope
3. Token is resolved in this priority order:
   - **PAT** (`syn-…` prefix): Validated against admin database; resolves `user_id`, `org_id`, `tenant_ids`, `scopes`
   - **Internal service token**: Trusted for forwarded identity headers (Open WebUI proxy)
   - **Model API key**: Pass-through for direct model calls (does not assert identity)
   - **Unknown token**: Accepted (user resolved from headers or defaults to anonymous)

### Forwarded identity (Open WebUI proxy mode)

When `SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS=true` and the bearer matches an internal service token, the planner reads user identity from:
- `X-OpenWebUI-User-Id`
- `X-OpenWebUI-User-Email`
- `X-Synesis-Org-Id` / `X-Synesis-Org-Name`
- `X-Synesis-Tenant-Ids`
- `X-OpenWebUI-Chat-Id`

When `SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE=true`, untrusted bearers carrying these headers are rejected with `403`.

## Streaming Behavior

### OpenAI-compatible core

Every SSE stream follows this structure:

1. **Content delta chunks** — `data: {"object": "chat.completion.chunk", "model": "...", "created": ..., "choices": [{"delta": {"content": "..."}, "finish_reason": null}]}`
2. **Final chunk** — `data: {"object": "chat.completion.chunk", "choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {...}}`
3. **Done sentinel** — `data: [DONE]`

Every chunk includes `id`, `object`, `created`, and `model` fields to satisfy strict SDK parsers.

### Synesis extensions (non-standard SSE lines)

The planner emits additional SSE lines for Open WebUI status indicators:

- **Status/phase events:** `data: {"event": {"type": "status", "data": {"description": "...", "done": false, "hidden": false}}}`

**Strict OpenAI SDK parsers** should skip any `data:` line whose JSON does not have `"object": "chat.completion.chunk"`. The planner emits status updates as JSON envelopes in `data:` lines (no SSE named events required).

### Usage on final chunk

Usage is included on the final chunk unless `stream_options.include_usage` is explicitly set to `false`. Fields:
- `prompt_tokens` — sum across all pipeline LLM calls
- `completion_tokens` — sum across all pipeline LLM calls
- `total_tokens` — `prompt_tokens + completion_tokens`
- `cached_prompt_tokens` — KV-cache subset of prompt tokens

### Finish reasons

| Value | Meaning |
|-------|---------|
| `stop` | Normal completion |
| `length` | Output truncated by token limit |

## Non-Streaming Response Shape

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1711324800,
  "model": "Synesis",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "..."},
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150,
    "cached_prompt_tokens": 20
  },
  "run_id": "uuid-for-feedback",
}
```

**Synesis extensions** in the response: `run_id` (for feedback correlation) and `authz_trace_id` (auth lineage). Standard clients ignore these.

## Test Matrix

Run the compatibility test suite:

```bash
npm run test --prefix base/planner-ts tests/api-contract.test.ts tests/sse-conformance.test.ts
```

### Test coverage by area

| Area | Test Class | Count |
|------|-----------|-------|
| Error envelope (400/422/500) | `TestOpenAIErrorEnvelope` | 3 |
| Streaming chunks (model, created, finish, usage, [DONE]) | `TestStreamingCompat` | 5 |
| Auth contract (bearer required, public models) | `TestAuthContract` | 4 |
| Request schema (extras, multipart, null, max_tokens) | `TestRequestSchemaCompat` | 6 |
| Usage/finish invariants (stream + non-stream) | `TestUsageInvariants` | 5 |
| Usage extraction (OpenAI, Anthropic, empty) | `TestLLMUsageExtract` | 5 |
| Response shape | `TestNonStreamingResponseShape` | 1 |
| Auth (forwarded identity, PAT, scope) | `test_forwarded_identity_auth.py`, `test_pat_auth.py`, `test_knowledge_scope_auth.py` | 29 |

## Troubleshooting

### Client gets `detail` instead of `error` object

Verify you are running the latest planner image with the OpenAI error envelope handler. Pre-handler builds return FastAPI's native `{"detail": "..."}`.

### Streaming parser fails on status events

Configure your client to skip `data:` lines that don't parse as `chat.completion.chunk`. Most OpenAI SDKs do this by default.

### 401 on chat completions

Check `SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH`. In production, provide `Authorization: Bearer <token>`. PAT tokens start with `syn-`; internal service tokens are configured via `SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN`.

### 403 with "Untrusted forwarded identity headers"

This happens when `SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE=true` and the bearer is not a recognized internal service token but the request carries `X-OpenWebUI-*` or `X-Synesis-*` headers. Either use a dedicated service token or remove the forwarded identity headers.

### Missing usage data

Usage is aggregated from the tracer. If the tracer is disabled or upstream models don't return usage, the planner falls back to content-length estimates. Check `SYNESIS_TRACE_ENABLED` and model endpoint health.

## Known Synesis-Specific Deviations

1. **Planner-owned tool orchestration**: Chat requests are accepted through the OpenAI-compatible surface, but product-level routing/retrieval/writer/critic orchestration happens internally in the planner-ts graph.
2. **Single choice**: Only `n=1` is supported; additional values are ignored.
3. **Status SSE lines are opt-in**: Non-standard `data: {"event": {...}}` lines only appear when `SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS=openwebui-data`.
4. **Observability fields**: Non-stream responses may include `run_id` and `pipeline_trace`; strict streaming keeps these in headers or server-side traces.
5. **`cached_prompt_tokens`**: Additional usage field beyond OpenAI standard.
