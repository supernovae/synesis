# Streaming and Buffering for Synesis

Status updates from the LLM (e.g. "Analyzing request…", "Gathering evidence…") depend on streaming tokens reaching the client without being buffered. Buffering in proxies (HAProxy, nginx) can delay or drop small updates, degrading UX.

---

## Problem

When Open WebUI or another client connects to the Planner via HAProxy/LiteLLM:

1. The Planner streams SSE or chunked HTTP to the client.
2. Intermediate proxies may buffer responses until a threshold (e.g. 4KB) or until the request completes.
3. Small updates (single tokens or short status lines) get delayed or batched, so the UI feels unresponsive.

---

## Critic Modes and Streaming Behavior

### Background Critic (`SYNESIS_CRITIC_BACKGROUND=true`)

The SSE stream closes immediately after the writer/executor finishes streaming content. The critic runs asynchronously after the stream closes. This shortens the SSE connection lifetime significantly (eliminates the ~23 second critic wait), which reduces buffering sensitivity and the risk of proxy timeouts.

Writer/executor tokens stream directly to the client in real-time.

### Inline Critic (`SYNESIS_CRITIC_BACKGROUND=false`, the deployment default)

When the inline critic rejects a draft and triggers a revision cycle, the writer generates a new draft. To prevent multiple drafts from being concatenated in the SSE stream (since SSE deltas cannot be retracted once sent), **writer/executor content tokens are not streamed directly** in this mode. Instead:

1. Reasoning tokens (`reasoning_content`) still stream in real-time so the thinking UI stays responsive.
2. Phase indicators (Searching, Planning, Writing, Reviewing, Revising) stream in real-time.
3. After the graph completes, the final approved content is emitted progressively (paragraph-by-paragraph for large responses).

This trades token-by-token streaming for **single-document coherence** — the user always sees exactly one approved response, not concatenated drafts from multiple revision cycles.

---

## Mitigations

### 1. OpenShift Route annotations (Planner)

The Planner route (`base/planner/route.yaml`) includes:

- `haproxy.router.openshift.io/timeout: 300s` — long timeout for complex plans
- `haproxy.router.openshift.io/disable_buffer: "true"` — disables response buffering for SSE (if supported by your OpenShift router version)

If phases still don't appear, the router may ignore `disable_buffer`. Verify in your cluster docs.

### 2. Planner response headers

The Planner sends `X-Accel-Buffering: no` on streaming responses. This instructs nginx (if in front) to disable buffering.

### 3. Direct HAProxy config (if you manage it)

```
backend synesis_planner
    option http-server-close
    http-response set-header X-Accel-Buffering no
```

### 4. LiteLLM proxy

If using LiteLLM in front of the Planner, ensure it does not buffer:

- Check `litellm_settings` for streaming-related options.
- Prefer passing the Planner URL through and letting LiteLLM proxy streams without buffering.

### 5. Direct Planner connection (bypass proxies)

For lowest latency and most reliable streaming:

- Point Open WebUI directly at the Planner service (e.g. `http://synesis-planner.synesis-planner.svc.cluster.local:8000/v1`).
- Use a route/ingress that does not buffer (or configure buffering off).
- Avoid HAProxy in the path when possible.

### 6. UDS path

When Planner and vLLM are co-located with UDS:

- Planner → vLLM traffic uses Unix sockets, avoiding network buffering.
- Client → Planner still goes over HTTP; ensure that segment does not buffer (see above).

---

## Event Iterator Safety

The SSE generator polls the LangGraph event iterator with a 1-second timeout to interleave heartbeat keepalives. The polling uses `asyncio.wait` on a persistent task — **not** `asyncio.wait_for`.

**Why this matters:** `asyncio.wait_for` cancels the `__anext__()` coroutine when the timeout fires. For async generators (like `astream_events`), this throws `CancelledError` into the generator, permanently closing it and cascading cancellation into the running graph node. When this happens during a long-running internal LLM call (e.g. frame extraction repair), the entire pipeline is destroyed and the graph produces no output.

`asyncio.wait` does not cancel the task on timeout — it simply returns an empty `done` set, allowing the heartbeat loop to continue while the event task stays alive. This is the correct pattern for non-blocking polling of async iterators.

Additionally, all internal LLM calls within the entry pipeline now use `streaming=True` (even when using `ainvoke()` which buffers the full response). This ensures that LangChain emits `on_chat_model_stream` events during the call, keeping the event iterator active and preventing silent windows.

---

## Response Echo Guard

As defense-in-depth, the planner verifies that the last message in the accumulated state is an `AIMessage` before returning it as the response. If the graph was interrupted before producing an assistant response (e.g. by cancellation or timeout), `accumulated_state["messages"]` may still contain only user `HumanMessage`s. Without this check, the user's own prompt could be echoed back as the "response."

Two guards prevent this:
1. **`_extract_content_and_metrics`**: Checks `message.type == "ai"` before using content; returns an error message for non-AI messages.
2. **SSE no-result check**: Verifies at least one `AIMessage` exists in `accumulated_state["messages"]` before proceeding to emit content. If none exist, an error event is sent instead.

---

## Verification

1. Enable streaming in the client (`stream: true`).
2. Send a request that triggers status updates (e.g. code generation).
3. Observe whether updates appear incrementally or only at the end.
4. If updates arrive only at the end, investigate proxy/ingress buffering.

---

## References

- Open WebUI streaming: ensure `stream: true` and compatible API
- SSE status format: see `OPENWEBUI_PHASES.md`
