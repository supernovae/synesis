# Streaming and Buffering for Synesis

planner-ts streams chat responses as OpenAI-compatible SSE frames by default:
`data: {"object":"chat.completion.chunk",...}` followed by `data: [DONE]`.
The old custom status-event stream is opt-in with
`SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS=openwebui-data`.

## Buffering Risks

When Open WebUI or another client connects through HAProxy, nginx, an Ingress,
or an OpenShift Route, small SSE frames can be delayed if the proxy buffers
responses. planner-ts sets `X-Accel-Buffering: no`, but edge proxies may still
need explicit buffering/timeout configuration.

## Mitigations

- Keep Open WebUI pointed directly at planner-ts:
  `http://synesis-planner-ts.synesis-planner.svc.cluster.local:8080/v1`.
- For OpenShift Routes, use long request timeouts and disable buffering where
  the router supports it.
- Curl planner-ts directly before debugging browser behavior:

```bash
curl -N -X POST "http://localhost:8080/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"Synesis Auto","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

Expected output is a sequence of OpenAI `chat.completion.chunk` data lines and
a final `[DONE]`.

## References

- Open WebUI streaming: ensure `stream: true` and an OpenAI-compatible API base
- SSE behavior: [`docs/chat/OPENWEBUI_PHASES.md`](chat/OPENWEBUI_PHASES.md)
- planner-ts SSE tests: [`base/planner-ts/tests/sse-conformance.test.ts`](../base/planner-ts/tests/sse-conformance.test.ts)
