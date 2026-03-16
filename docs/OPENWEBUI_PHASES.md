# Open WebUI Phase/Status Integration

How Synesis sends "Classifying request," "Gathering evidence," "Composing response" and other phases to Open WebUI during graph execution, and how to debug when they don't appear.

---

## Architecture

| Component | Role |
|-----------|------|
| **Open WebUI** | Chat frontend; calls API with `stream: true`, expects SSE |
| **LiteLLM** (prod) or **Planner** (dev direct) | Proxies to planner; streams response |
| **Planner** | Runs LangGraph; emits status events + final content |

**Request path:**
- **Prod:** Open WebUI → LiteLLM → Planner
- **Dev (direct):** Open WebUI → Planner

---

## Streaming Implementation

Uses `graph.astream_events(version="v2")` for fine-grained token-level streaming:

- `on_chain_start` events emit phase-based status messages via `_flow_phase()`
- `on_chain_end` events accumulate state and emit rich status messages (router search results, planner summary)
- `on_chat_model_stream` events from the writer/executor stream content tokens to the client
- **Reasoning content:** R1-Distill `<think>` tags surface via `reasoning_content` field in chunks, with "Thinking..." status
- **Plan step visibility:** For knowledge deep-dives (non-code tasks with a planner), plan steps are emitted as visible markdown content (blockquote) before the main response
- `StatusQueueCallback` provides fallback node-level status when `streaming_events_enabled=false`

### Phase Labels

```python
_NODE_TO_PHASE = {
    "entry_classifier": "Classifying request…",
    "strategic_advisor": "Assessing strategy…",
    "frame_extractor": "Extracting intent…",
    "router": "Gathering evidence…",
    "planner": "Building plan…",
    "executor": "Generating code…",
    "writer": "Composing response…",
    "patch_integrity_gate": "Validating code…",
    "critic": "Evaluating quality…",
    "final_scrubber": "Polishing…",
    "respond": "Finalizing…",
}
```

### Rich Status Messages

After certain nodes complete, additional descriptive status messages are emitted:

- **Router** (`on_chain_end`): For each evidence packet (up to 3), emits a message like "Searched: Kubernetes deployment strategies (2 web + 3 docs)"
- **Planner** (`on_chain_end`): Emits "Plan ready: N sections"

These use the same `_flow_phase()` mechanism — no new SSE event types.

### Flow Indicator

After the initial "Starting…" event, subsequent phase messages are prefixed with `›` to create a visual flow progression.

**SSE format we send:**
```
data: {"event": {"type": "status", "data": {"description": "› Gathering evidence…", "done": false, "hidden": false}}}
```

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

Open WebUI expects status events in the stream with:
- `type: "status"`
- `data.description`: display text
- `data.done`: `true` at end to clear the indicator
- `data.hidden`: optional
- `data.detail`: optional — short subtext for the phase (e.g. "Searching sources and ranking relevance") shown within the same phase block without stacking extra events

### Visible Plan Steps (Knowledge Deep-Dives)

For non-code tasks that go through the planner, plan steps are rendered as **visible markdown content** (a blockquote block) before the main response.

- **Code tasks:** No plan block emitted
- **Simple text tasks (no planner):** No plan block emitted
- **Status events** still fire in parallel for real-time UI indicators

**Phase resolution:** The planner resolves the current node from `astream_events` using `_resolve_node_from_event()` (exact match on `metadata.langgraph_node` or `name`, then substring match for wrapped runnables). This ensures phase status events are emitted even when LangGraph event shape varies.

**Full vs selective (classic vs streamlined) retrieval:** Phases are **node-driven**: each node in `_NODE_TO_PHASE` emits its label when that node runs. The same streaming logic runs for both `inference_mode=full` (evidence up front) and `inference_mode=selective` (RAG only when critic says so). In full mode you typically see "Gathering evidence" → "Building plan" → "Composing response" → "Evaluating quality". In selective mode, the first pass may skip the router and planner, so you see "Analyzing request" → "Composing response"; if the critic later requests more evidence, a second pass runs the router and "Gathering evidence" is emitted then. No separate phase support is needed for the two retrieval approaches — retrieval always goes through the router node, which is already in the phase map.

**Production behavior:** Use Open WebUI's **native** status display only; do not install or enable any custom Synesis Progress pipe or client-side function for status. Do **not** set `SYNESIS_STREAM_DEBUG_CHATTER` in production (it is for local/dev debugging only and gates the `/debug/sse-test` endpoint).

**Why statuses might not appear:**
- **LiteLLM/proxy**: Some proxies forward only `data:` lines and drop `event: status`. Try calling the Planner directly (no LiteLLM) to verify.
- **Open WebUI version**: SSE status routing may require a recent release.
- **Buffering**: `X-Accel-Buffering: no` is set; upstream proxies (HAProxy, nginx) may still buffer—add `haproxy.router.openshift.io/disable_buffer: "true"` on the route.
- **Planner restarts**: If the planner pod OOMs or crashes, the stream stops and the UI can sit on "Gathering evidence" or similar. Check `kubectl describe pod -n synesis-planner` for `Last State: Terminated, Reason: OOMKilled`. Ensure `search_sources.yaml` is mounted (apply planner via kustomize so the `synesis-search-sources` ConfigMap exists); otherwise logs show `search_sources_file_not_found` and the router uses in-memory defaults, but the file mount avoids path confusion and matches production config. For memory debugging and instrumentation, see [PLANNER_MEMORY.md](PLANNER_MEMORY.md).

---

## Debugging

1. **Browser console (F12 / Cmd+Opt+I)**
   Look for `Incoming event: status` or parse errors.

2. **Verify planner emits status**
   ```bash
   curl -N -X POST "http://localhost:8000/v1/chat/completions" \
     -H "Content-Type: application/json" \
     -d '{"model":"synesis-agent","messages":[{"role":"user","content":"hello"}],"stream":true}' \
     2>/dev/null | head -50
   ```

3. **Direct vs LiteLLM**
   - **Direct (dev):** `OPENAI_API_BASE_URL` → planner. Fewer hops.
   - **LiteLLM:** Request goes through gateway. Confirm LiteLLM doesn't drop or transform SSE lines.

4. **SSE test endpoint**
   `GET /debug/sse-test` (requires `stream_debug_chatter=true`) emits sample status events for verification.

---

## References

- Planner streaming: `base/planner/app/main.py` — `sse_generator()`, `_NODE_TO_PHASE`
- Fallback streaming: `base/planner/app/streaming_events.py` — `StatusQueueCallback`
- Open WebUI Events: https://docs.openwebui.com/features/plugin/events/
- LiteLLM config: `base/gateway/litellm-config.yaml`
- Dev direct-planner: `overlays/dev/openwebui-direct-planner.yaml`
