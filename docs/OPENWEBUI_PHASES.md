# Open WebUI Phase/Status Integration

How Synesis sends "Thinking," "Validating," "Testing" and other phases to Open WebUI during graph execution, and how to debug when they don't appear.

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

## Our Current Implementation

We emit status events during graph execution and a final `done: true` before streaming content.

**Location:** `base/planner/app/main.py`

**Streaming implementation (current):**
- Uses `graph.astream_events(version="v2")` for fine-grained token-level streaming
- `on_chat_model_stream` events intercepted and yielded immediately as OpenAI-compatible SSE chunks
- **Reasoning content:** R1-Distill `<think>` tags surface via `reasoning_content` field in chunks. Emits "Thinking..." status immediately, then extracts headline-like reasoning lines as status updates
- **Text mode:** Streams direct markdown tokens (no JSON extraction needed)
- **Code mode:** Uses `StreamingCodeExtractor` to parse JSON field content from the token stream
- `StatusQueueCallback` emits node-level status as nodes start/complete
- **Plan step visibility:** For knowledge deep-dives (non-code tasks with a planner), plan steps are emitted as visible markdown content (blockquote) before the main response — not hidden in a collapsed `<details>` block
- Diagnostic logging: `sse_first_worker_chunk_diag`, `sse_first_content_token`, `sse_first_content_delta`

```python
# Node -> user-friendly message
NODE_STATUS_MESSAGES = {
    "entry_classifier": "Analyzing request…",
    "supervisor": "Planning…",
    "planner": "Building execution plan…",
    "context_curator": "Gathering context…",
    "worker": "Generating code…",  # text mode → "Generating response…"
    "patch_integrity_gate": "Validating code…",
    "sandbox": "Testing code…",
    "lsp_analyzer": "Analyzing types…",
    "critic": "Reviewing…",
    "respond": "Finishing…",
}
```

**SSE format we send:**
```
event: status
data: {"type": "status", "data": {"description": "Validating code…", "done": false, "hidden": false}}

event: status
data: {"type": "status", "data": {"description": "", "done": true, "hidden": false}}
```

We use `event: status` so clients that listen for named events can route correctly. The payload matches Open WebUI's expected structure.

---

## Open WebUI Expectations (Research Summary)

### 1. `__event_emitter__` (Pipes/Functions)

For **custom Python Functions, Actions, or Pipes** inside Open WebUI Workspace:

```python
async def pipe(self, body: dict, __event_emitter__=None):
    await __event_emitter__({
        'type': 'status',
        'data': {'description': 'Thinking...', 'done': False}
    })
```

**Synesis does not use this.** We are an external API (planner). Our status comes via SSE streaming, not `__event_emitter__`.

### 2. SSE Streaming (Our Case)

Open WebUI expects status events in the stream with:
- `type: "status"`
- `data.description`: display text
- `data.done`: `true` at end to clear the indicator
- `data.hidden`: optional

### 3. Visible Plan Steps (Knowledge Deep-Dives)

For non-code tasks that go through the planner, plan steps are rendered as **visible markdown content** (a blockquote block) before the main response:

```markdown
> **Analyzing request… | Planning… | Architecting solution…**
>
> **Plan:** The plan breaks down the task into atomic steps…
> 1. Define the main design goals and constraints
> 2. Propose a concrete architecture
> 3. Explain model choices and retrieval mechanisms
```

This replaces the previous `<details type="thinking">` collapsed block. Plan steps are now directly visible to the user, similar to how other AI assistants surface their working process.

- **Code tasks:** No plan block emitted (plan steps are execution details, not user-facing)
- **Simple text tasks (no planner):** No plan block emitted
- **Status events (`event: status`)** still fire in parallel for real-time UI indicators

**Why statuses might not appear:**
- **LiteLLM/proxy**: Some proxies forward only `data:` lines and drop `event: status`. Try calling the Planner directly (no LiteLLM) to verify.
- **Open WebUI version**: SSE status routing to the built-in status area may require a recent release (see [open-webui#19250](https://github.com/open-webui/open-webui/issues/19250)).
- **Buffering**: `X-Accel-Buffering: no` is set; upstream proxies (HAProxy, nginx) may still buffer—add `haproxy.router.openshift.io/disable_buffer: "true"` on the route.

### 4. v0.8.0+ Changes (Jan/Feb 2026)

- Rich UI for Actions; iframes and HTML.
- Skills (experimental) handle status differently.
- `ENABLE_USER_STATUS` in Admin → Settings can affect secondary status animations.

---

## Recent Fixes (Phases Visibility)

| Change | Purpose |
|--------|---------|
| Route `haproxy.router.openshift.io/disable_buffer: "true"` | Reduce proxy buffering so SSE events reach client in real time |
| Entry classifier sets `current_node` | First status event ("Analyzing request…") now fires |
| Context-aware status for complex | When task_size=complex, emit "Complex task detected. Building execution plan…" instead of generic node message |
| Plan steps as visible content | Knowledge deep-dives render plan steps as a blockquote before the response, not in a collapsed `<details>` dropdown |
| Removed `<details type="thinking">` wrapper | Status events provide real-time feedback; plan steps are now directly visible markdown content |

---

## Potential Failure Points

| Issue | Cause | Fix |
|-------|-------|-----|
| **Phases never show** | LiteLLM may not pass through non-OpenAI chunks | Bypass LiteLLM (dev overlay: direct to planner) or verify LiteLLM streams planner output byte-for-byte |
| **Phases stick / don't clear** | Missing `done: true` at end | We send it; verify it reaches the client |
| **Event routing** | Client expects `event: status` for routing | We now send it |
| **Open WebUI version** | Status from external API streams may be newer/partial | Check Open WebUI release notes for "SSE status" or "agentic server status" |

---

## Debugging

1. **Browser console (F12 / Cmd+Opt+I)**  
   Look for `Incoming event: status` or parse errors. If events arrive but UI doesn't update, it's a frontend routing issue.

2. **Verify planner emits status**  
   ```bash
   curl -N -X POST "http://localhost:8000/v1/chat/completions" \
     -H "Content-Type: application/json" \
     -d '{"model":"synesis-agent","messages":[{"role":"user","content":"hello"}],"stream":true}' \
     2>/dev/null | head -50
   ```
   You should see `event: status` and `data: {"type":"status",...}` lines.

3. **Direct vs LiteLLM**  
   - **Direct (dev):** `OPENAI_API_BASE_URL` → planner. Fewer hops.  
   - **LiteLLM:** Request goes through gateway. Confirm LiteLLM doesn't drop or transform our SSE lines.

4. **Save & reload**  
   For Open WebUI Pipes, "Save" in Workspace and refresh the tab. For our API, a normal page refresh is enough.

5. **ENABLE_USER_STATUS**  
   Admin Panel → Settings → General. Ensure it's on if status UI is missing.

---

## References

- Planner streaming: `base/planner/app/main.py` — `sse_generator()`, `NODE_STATUS_MESSAGES`
- Open WebUI Events: https://docs.openwebui.com/features/plugin/events/
- LiteLLM config: `base/gateway/litellm-config.yaml`
- Dev direct-planner: `overlays/dev/openwebui-direct-planner.yaml`
