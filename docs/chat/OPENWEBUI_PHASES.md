# Open WebUI Streaming Integration

How Synesis streams planner-ts responses to Open WebUI, and how to debug the OpenAI-compatible SSE path.

---

## Architecture

| Component | Role |
|-----------|------|
| **Open WebUI** | Chat frontend; calls API with `stream: true`, expects SSE |
| **Planner-ts** | OpenAI-compatible `/v1` for WebUI; runs the TypeScript graph; streams OpenAI `chat.completion.chunk` frames |

**Request path (Synesis manifests):**
- **Open WebUI → planner-ts** (`OPENAI_API_BASE_URL` → `synesis-planner-ts:8080/v1`).
- **Planner-ts → upstream models** uses the active admin Model Registry route for hosted providers or self-hosted vLLM endpoints.

---

## Streaming and Status Implementation

Default production answer streaming is intentionally plain OpenAI-compatible SSE:

- every streamed payload is `object: "chat.completion.chunk"`
- content appears in `choices[0].delta.content`
- the final chunk carries `finish_reason`, `usage`, and `system_fingerprint`
- the stream ends with `data: [DONE]`
- no custom `event` envelope, `reasoning_content`, `run_id`, or authz fields are embedded in the default SSE payload

Correlation IDs are exposed through HTTP response headers (`x-synesis-run-id`, `x-synesis-authz-trace-id`) so clients can debug without parsing custom SSE shapes.

Visible Open WebUI progress is delivered out-of-band when the planner has enough Open WebUI context:

```http
POST /api/v1/chats/{chat_id}/messages/{message_id}/event
```

The planner posts native Open WebUI status events:

```json
{
  "type": "status",
  "data": {
    "description": "Querying graph context...",
    "done": false,
    "hidden": false
  }
}
```

Status delivery is best-effort. A failed event post must not fail chat completion.

### Configuration

| Setting | Default | Purpose |
|---------|---------|---------|
| `SYNESIS_PLANNER_TS_OPENWEBUI_EVENTS_ENABLED` | `true` | Enables side-channel Open WebUI event posting when all required fields are present |
| `SYNESIS_PLANNER_TS_OPENWEBUI_BASE_URL` | empty | Open WebUI base URL, usually `http://open-webui.synesis-webui.svc.cluster.local:8080` |
| `SYNESIS_PLANNER_TS_OPENWEBUI_EVENT_TOKEN` | empty in code; Helm-generated in Synesis installs | Synesis Open WebUI service token accepted only for message status events and feedback export |
| `SYNESIS_PLANNER_TS_OPENWEBUI_EVENT_TIMEOUT_MS` | `1500` | Per-event post timeout |
| `SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS` | `off` in code; `openwebui-data` in Synesis manifests | Open WebUI in-stream status fallback for deployments that do not configure the side-channel event token |

Open WebUI metadata can arrive through request metadata or forwarded headers. Synesis uses:

- `metadata.chat_id` or `conversation_id` / `X-OpenWebUI-Chat-Id`
- `metadata.message_id` / `X-OpenWebUI-Message-Id`

If either ID or the event token is missing, Synesis skips side-channel status events and still streams the assistant answer normally. The planner logs `openwebui status side-channel unavailable` with redacted booleans for `hasBaseUrl`, `hasEventToken`, `hasChatId`, and `hasMessageId` so operators can tell why native event posting is not active.

In Helm installs, `synesis-openwebui-admin-token` is generated on first install unless `secrets.openwebuiAdminToken` is supplied. Helm creates the same secret in the WebUI, admin, and planner namespaces. Open WebUI reads it as `SYNESIS_OPENWEBUI_SERVICE_TOKEN`, planner-ts reads it as `SYNESIS_PLANNER_TS_OPENWEBUI_EVENT_TOKEN`, and synesis-admin reads it as `SYNESIS_OPENWEBUI_ADMIN_TOKEN`.

### Legacy In-Band Status Mode

`SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS=openwebui-data` enables the compatibility Open WebUI data-event mode for local debugging or deployments that cannot use the side-channel event endpoint. Synesis Helm/base manifests enable this fallback so phase display still works if side-channel metadata is missing. In that mode planner-ts may emit:

```text
data: {"event":{"type":"status","data":{"description":"Gathering evidence...","done":false,"hidden":false}}}
```

The Synesis Open WebUI middleware consumes these frames and forwards them to Open WebUI's event emitter; they should not appear in the final assistant text. Leave `SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS` unset or set to `off` only for direct, strict OpenAI-compatible planner clients that are not going through Synesis Open WebUI.

---

## planner-ts Streaming (TypeScript runtime)

planner-ts uses `streamGraph()` from `base/planner-ts/src/graph.ts` for node transitions and the Vercel AI SDK `streamText()` path for upstream model streaming. Status emission is centralized in `base/planner-ts/src/streaming/status-events.ts`.

### Phase labels (planner-ts)

```typescript
const PHASE_DESCRIPTION = {
  intake:       "Preparing request...",
  classifying: "Classifying task and routing workflow...",
  planning:    "Building execution plan...",
  validating:  "Validating plan...",
  retrieving:  "Retrieving relevant context...",
  graph_query: "Querying graph context...",
  web_search:  "Searching the web...",
  reranking:   "Ranking retrieved evidence...",
  synthesizing:"Synthesizing response...",
  critic:      "Reviewing answer quality...",
  streaming:   "Streaming response...",
  complete:    "Done",
  error:       "Workflow failed",
};
```

Statuses are truthful to the code path. For example, `web_search` is emitted only when web retrieval is configured and invoked, and graph/vector retrieval statuses are emitted around the NornicDB retrieval call.

### Non-writer content streaming

When the graph bypasses the writer node (e.g. clarification → plan_gate →
respond), content is set in `generated_code` but never streamed by the writer
delta handler. A post-loop guard detects this and emits the content as a
standard content delta before the final chunk. This ensures clarification
questions and direct responses always reach the client.

### Domain-aware closing follow-up

After substantive (non-clarification, non-trivial) responses, the final
scrubber appends a contextual follow-up prompt separated by `---`. This
replaces Open WebUI's indiscriminate auto-follow-ups which fire on every turn,
including during clarification exchanges.

**When it appends:**
- Response is 200+ chars
- Not a clarification turn or answer
- Not trivial/error

**When it skips:**
- Clarification questions
- Clarification answer processing
- Trivial/pulse-tier tasks
- Error states
- Short responses

**Domain matching:** Uses taxonomy key and domain profile to select a relevant
prompt (software, code, data, security, devops, ml_ai, cloud) with a generic
fallback.

**Config:** `SYNESIS_PLANNER_TS_CLOSING_FOLLOWUP_ENABLED` (default `true`).
Disable Open WebUI's `ENABLE_AUTOCOMPLETE_GENERATION` to avoid double
follow-ups.

---

## Critic Modes

**Config:** `SYNESIS_PLANNER_TS_CRITIC_BACKGROUND` (default: `true`)

### Background mode (`true`)

The SSE stream closes immediately after the writer/executor finishes streaming content. The graph continues running (critic, scrubber, respond) silently:

- Client receives `finish_reason: stop` and `[DONE]` as soon as content generation ends
- No ~23 second dead air while the critic runs
- Critic results are still logged and stored for analytics/feedback
- Writer/executor content tokens stream in real-time

This is useful when critic latency is high and you want instant UX.

### Inline mode (`false`, the deployment default)

The critic runs inline after the writer. If it rejects, the writer revises. To prevent multiple draft concatenation in the SSE stream:

- **Content tokens are not streamed directly** — they are emitted post-graph after the critic approves
- Reasoning tokens still stream so the thinking UI stays responsive
- Phase indicators stream in real-time (Writing, Reviewing, Revising)
- The writer receives REVISION CONTEXT with settled decisions from the previous draft, preventing architectural oscillation across revision cycles

---

## Critic Prompt Optimization

The document-path critic has three optimizations that reduce latency regardless of background mode:

1. **Deterministic pre-check**: For lenient-difficulty tasks, checks if each deliverable has a heading in the response. If all are covered and word count is proportional, skips the LLM critic entirely (0ms instead of ~23s).

2. **Skeleton mode**: For lenient tasks that don't pass the deterministic check, sends only headings + first 200 chars per section to the critic instead of the full response text. Reduces input tokens significantly.

3. **Lenient strip**: For low-difficulty tasks, omits the CRAG assessment, failure mode vocabulary, and detailed scoring rubric from the system prompt (~500 fewer tokens).

4. **Unified rubric**: The frame rubric and decision ledger are merged into a single block, eliminating duplicate deliverable/decision listings.

---

## Open WebUI Expectations

### SSE Streaming (Our Case)

Open WebUI 0.9 accepts an OpenAI-compatible streaming endpoint as its normal chat backend. For production, use the native OpenAI-compatible stream and debug with raw `data:` frames rather than client-specific custom events.

Native status events are posted to Open WebUI's message event endpoint when planner-ts has a base URL, event token, chat ID, and message ID:
- `type: "status"`
- `data.description`: display text
- `data.done`: `true` at end to clear the indicator
- `data.hidden`: `false` for visible Synesis phases
- `data.detail`: optional short subtext

In Synesis Helm/base deployments, in-band status events are expected because `SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS=openwebui-data` is enabled as a fallback. Direct planner deployments can disable it for strict OpenAI-compatible SSE.

### Visible Plan Steps (Knowledge Deep-Dives)

For non-code tasks that go through the planner, plan steps are rendered as **visible markdown content** (a blockquote block) before the main response.

- **Code tasks:** No plan block emitted
- **Simple text tasks (no planner):** No plan block emitted
- **Status events** use the Open WebUI event endpoint when configured; legacy SSE status frames require `openwebui-data`

**Unified pipeline phases:** Graph phases are node-driven, and retrieval subphases are emitted only around real retrieval work. The typical sequence is "Preparing request" -> "Classifying task and routing workflow" -> "Building execution plan" -> "Validating plan" -> "Retrieving relevant context" -> "Synthesizing response" -> "Done". If RAG/web retrieval runs, users may also see graph, web, and ranking status updates.

**Production behavior:** Use Open WebUI's OpenAI-compatible backend path for answer streaming. Helm generates `synesis-openwebui-admin-token` and mounts it into planner-ts so planner-ts can post native Open WebUI message events out-of-band. Synesis manifests also keep the in-stream OpenWebUI status fallback enabled for deployments where Open WebUI message metadata is unavailable. Do not install or enable any custom Synesis Progress pipe or client-side function for status. Do **not** set `SYNESIS_STREAM_DEBUG_CHATTER` in production (it is for local/dev debugging only and gates the `/debug/sse-test` endpoint).

**Why streaming might appear delayed:**
- **Proxy buffering**: Edge proxies may buffer small `data:` lines. Try calling planner directly in-cluster to verify.
- **Open WebUI version/config**: Confirm it is using the planner-ts `/v1` endpoint and not an older custom pipe.
- **Missing event token**: If planner logs `openwebui status side-channel unavailable` with `hasEventToken=false`, confirm Helm created `synesis-openwebui-admin-token` in the planner namespace and mounted it as `SYNESIS_PLANNER_TS_OPENWEBUI_EVENT_TOKEN`.
- **Buffering**: `X-Accel-Buffering: no` is set; upstream proxies (HAProxy, nginx) may still buffer—add `haproxy.router.openshift.io/disable_buffer: "true"` on the route.
- **Planner restarts**: If the planner pod OOMs or crashes, the stream stops. Check `kubectl describe pod -n synesis-planner` for `Last State: Terminated, Reason: OOMKilled`. For memory debugging and instrumentation, see [OBSERVABILITY.md](../OBSERVABILITY.md).

---

## Token Usage on Streaming Responses

The planner's final SSE chunk includes an OpenAI-compatible `usage` object with
`prompt_tokens`, `completion_tokens`, `total_tokens`, and `cached_prompt_tokens`.
These values are sourced from the SynesisTracer's span-level LLM call records
(the same aggregation written to the admin Postgres trace) and should match the
admin trace record.

If Open WebUI reports zero tokens after a streamed response, verify the final `data:` line before `[DONE]` by curling **planner-ts** directly (see debugging section below).

**`stream_options`:** The planner accepts `stream_options.include_usage` on the
request for OpenAI-spec compliance, but always includes `usage` on the final
chunk regardless.

---

## Debugging

1. **Browser console (F12 / Cmd+Opt+I)**
   Look for `Incoming event: status` or parse errors.

2. **Verify planner emits OpenAI chunks**
   ```bash
   curl -N -X POST "http://localhost:8000/v1/chat/completions" \
     -H "Content-Type: application/json" \
     -d '{"model":"Synesis Auto","messages":[{"role":"user","content":"hello"}],"stream":true}' \
     2>/dev/null | head -50
   ```

   Expected frames look like `data: {"id":"...","object":"chat.completion.chunk",...}` and end with `data: [DONE]`.

3. **Direct planner path**
   - `OPENAI_API_BASE_URL` should point to planner. Confirm no edge proxy is buffering or transforming SSE lines.

4. **SSE test endpoint**
   `GET /debug/sse-test` (requires `stream_debug_chatter=true`) emits sample events for local verification only.

---

## References

- **planner-ts streaming:** `base/planner-ts/src/app.ts` — SSE init, OpenAI chunk framing, post-loop content guard
- **planner-ts phases:** `base/planner-ts/src/streaming/phases.ts` — `describePhase()`
- **planner-ts SSE helpers:** `base/planner-ts/src/streaming/sse.ts` — OpenAI chunk helpers plus legacy status helpers
- **planner-ts graph:** `base/planner-ts/src/graph.ts` — `streamGraph()` yields `NodeTransitionEvent`
- **planner-ts closing follow-up:** `base/planner-ts/src/pipeline.ts` — `buildClosingFollowup()`, `finalScrubberNode()`
- **Planner runtime:** `base/planner-ts` is the maintained TypeScript runtime.
- Open WebUI Events: https://docs.openwebui.com/features/plugin/events/
- Open WebUI deployment base: `base/webui/deployment.yaml`
