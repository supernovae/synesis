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

## Streaming Implementation

Default production streaming is intentionally plain OpenAI-compatible SSE:

- every streamed payload is `object: "chat.completion.chunk"`
- content appears in `choices[0].delta.content`
- the final chunk carries `finish_reason`, `usage`, and `system_fingerprint`
- the stream ends with `data: [DONE]`
- no custom `event` envelope, `reasoning_content`, `run_id`, or authz fields are embedded in the SSE payload

Correlation IDs are exposed through HTTP response headers (`x-synesis-run-id`, `x-synesis-authz-trace-id`) so clients can debug without parsing custom SSE shapes.

### Optional OpenWebUI Status Mode

`SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS=openwebui-data` enables the old Open WebUI data-event mode for local debugging or deployments that still want visible phase/status events. In that mode planner-ts may emit:

```text
data: {"event":{"type":"status","data":{"description":"Gathering evidence...","done":false,"hidden":false}}}
```

Leave `SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS` unset or set to `off` for strict OpenAI-compatible behavior.

---

## planner-ts Streaming (TypeScript runtime)

planner-ts uses `streamGraph()` from `base/planner-ts/src/graph.ts` for node transitions and the Vercel AI SDK `streamText()` path for upstream model streaming. Phase labels are internal observability metadata by default; they are only serialized into SSE in `openwebui-data` compatibility mode.

### Phase labels (planner-ts)

```typescript
const PHASE_DESCRIPTION = {
  entry_pipeline: "Classifying and framing request",
  planner:        "Building execution plan",
  plan_gate:      "Validating plan deterministically",
  router:         "Gathering and structuring evidence",
  writer:         "Composing grounded response",
  critic:         "Evaluating quality and grounding",
  final_scrubber: "Applying final response cleanup",
  respond:        "Preparing final response",
};
```

Phases are emitted as `reasoning_content` in `chat.completion.chunk` objects
(not as `event:` SSE lines), matching what Open WebUI expects.

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

**Config:** `SYNESIS_CRITIC_BACKGROUND` (default: `false`)

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

Legacy status events are only expected when `SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS=openwebui-data` is enabled:
- `type: "status"`
- `data.description`: display text
- `data.done`: `true` at end to clear the indicator
- `data.hidden`: optional
- `data.detail`: optional short subtext

### Visible Plan Steps (Knowledge Deep-Dives)

For non-code tasks that go through the planner, plan steps are rendered as **visible markdown content** (a blockquote block) before the main response.

- **Code tasks:** No plan block emitted
- **Simple text tasks (no planner):** No plan block emitted
- **Status events** only fire in legacy `openwebui-data` mode

**Unified pipeline phases:** Phases are **node-driven**: each node in `_NODE_TO_PHASE` emits its label when that node runs. The typical sequence is "Analyzing request" → "Building plan" → "Validating plan" → "Gathering evidence" → "Composing response" → "Evaluating quality". If the critic requests more evidence, a second pass runs the router and "Gathering evidence" is emitted again. No separate phase support is needed — retrieval always goes through the router node, which is already in the phase map.

**Production behavior:** Use Open WebUI's OpenAI-compatible backend path only; do not install or enable any custom Synesis Progress pipe or client-side function for status. Do **not** set `SYNESIS_STREAM_DEBUG_CHATTER` in production (it is for local/dev debugging only and gates the `/debug/sse-test` endpoint).

**Why streaming might appear delayed:**
- **Proxy buffering**: Edge proxies may buffer small `data:` lines. Try calling planner directly in-cluster to verify.
- **Open WebUI version/config**: Confirm it is using the planner-ts `/v1` endpoint and not an older custom pipe.
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
- **Legacy Python planner path:** retired; planner-ts is the maintained runtime.
- Open WebUI Events: https://docs.openwebui.com/features/plugin/events/
- Open WebUI deployment base: `base/webui/deployment.yaml`
