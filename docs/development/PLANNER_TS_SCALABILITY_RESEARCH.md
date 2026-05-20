# planner-ts Scalability Notes

planner-ts is the active chat runtime. It uses Fastify, a lightweight TypeScript
graph, and the Vercel AI SDK for OpenAI-compatible model calls.

## Current Scaling Controls

- Replica scaling: use the planner-ts Deployment/HPA for concurrent users.
- Stream admission: `base/planner-ts/src/middleware/stream-admission.ts`.
- User rate limits: `base/planner-ts/src/middleware/user-rate-limit.ts`.
- Per-node timeouts: `base/planner-ts/src/graph.ts`.
- LLM retry/circuit breaker: `base/planner-ts/src/llm/client.ts` and
  `base/planner-ts/src/llm/circuit-breaker.ts`.
- Redis-backed session persistence: `base/planner-ts/src/context/session-store.ts`.

## Streaming

Production streaming is OpenAI-compatible SSE by default. Custom OpenWebUI
status events are opt-in with
`SYNESIS_PLANNER_TS_STREAM_STATUS_EVENTS=openwebui-data`.

See [`docs/chat/planner-scaling.md`](../chat/planner-scaling.md) and
[`docs/chat/OPENWEBUI_PHASES.md`](../chat/OPENWEBUI_PHASES.md) for operational
guidance.
