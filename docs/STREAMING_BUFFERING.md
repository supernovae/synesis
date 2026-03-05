# Streaming and Buffering for Synesis

Status updates from the LLM (e.g. "Analyzing…", "Running tests…") depend on streaming tokens reaching the client without being buffered. Buffering in proxies (HAProxy, nginx) can delay or drop small updates, degrading UX.

---

## Problem

When Open WebUI or another client connects to the Planner via HAProxy/LiteLLM:

1. The Planner streams SSE or chunked HTTP to the client.
2. Intermediate proxies may buffer responses until a threshold (e.g. 4KB) or until the request completes.
3. Small updates (single tokens or short status lines) get delayed or batched, so the UI feels unresponsive.

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

## Verification

1. Enable streaming in the client (`stream: true`).
2. Send a request that triggers status updates (e.g. code generation).
3. Observe whether updates appear incrementally or only at the end.
4. If updates arrive only at the end, investigate proxy/ingress buffering.

---

## References

- [BLACKWELL_ARCHITECTURE.md](BLACKWELL_ARCHITECTURE.md) — UDS and Planner co-location
- Open WebUI streaming: ensure `stream: true` and compatible API
