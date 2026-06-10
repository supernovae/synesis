# Planner Scaling And Runtime Controls

This is the operator reference for scaling `planner-ts`, the Synesis chat
frontend in `base/planner-ts/`.

Use Kubernetes resources, replicas, HPA, and upstream model capacity as the
primary scaling controls. Use planner runtime knobs for request admission,
timeouts, retries, and graceful failure behavior. Do not treat app knobs as a
replacement for CPU/memory limits, pod count, Redis session storage, or provider
throughput.

## What Scales Where

| Layer | Controls | What It Solves |
|-------|----------|----------------|
| Kubernetes capacity | `workloads.plannerTs.replicas`, CPU/memory requests and limits, optional HPA | More pods and enough memory/CPU for concurrent requests. |
| Session continuity | `SYNESIS_PLANNER_TS_REDIS_URL`, Redis TTL/CAS settings | Multi-replica sessions, clarification state, and conversation checkpoints survive pod changes. |
| Request throttling | Fastify global rate limit, per-user rate limit, edge/WAF rate limits | Abuse control and burst shaping before model calls start. |
| Stream admission | `SYNESIS_PLANNER_TS_STREAM_*` | Per-pod live SSE stream limits and bounded queueing. |
| LLM resilience | LLM timeout, retry, circuit breaker | Slow or failing upstream model routes fail predictably instead of tying up pods indefinitely. |
| Graph safety | Node timeouts | Individual planner graph nodes return controlled errors instead of hanging the request. |

## Helm Deployment Controls

Planner chart settings live under `workloads.plannerTs` in
[`charts/synesis/values.yaml`](../../charts/synesis/values.yaml).

Important deployment-level controls:

| Helm Path | Default | Notes |
|-----------|---------|-------|
| `workloads.plannerTs.replicas` | `2` | Safe for more than one pod when Redis is configured. |
| `workloads.plannerTs.resources.requests.cpu` | `500m` | Scheduler reservation. Increase if pods are CPU-throttled during classification/writer work. |
| `workloads.plannerTs.resources.requests.memory` | `1Gi` | Scheduler reservation. Increase for large streamed responses or heavy retrieval context. |
| `workloads.plannerTs.resources.limits.cpu` | `2` | CPU cap. Too low can increase p95 latency. |
| `workloads.plannerTs.resources.limits.memory` | `4Gi` | Memory cap. Keep above observed high-water mark plus safety margin. |
| `workloads.plannerTs.autoscaling.enabled` | `false` | Enable only after metrics-server is present and load behavior has been tested. |
| `workloads.plannerTs.autoscaling.minReplicas` | `2` | Lower bound when HPA is enabled. |
| `workloads.plannerTs.autoscaling.maxReplicas` | `4` | Upper bound when HPA is enabled. |
| `workloads.plannerTs.podDisruptionBudget.enabled` | `false` | Enable for production maintenance safety. |

Recommended production posture:

- Keep `replicas >= 2`.
- Keep Redis configured for planner sessions.
- Enable the PDB once the cluster has enough nodes to honor it.
- Enable HPA only after load testing confirms CPU tracks saturation well enough for your workload.
- Scale upstream model serving capacity with planner replicas; extra planner pods do not help if every pod bottlenecks on the same model endpoint.

## Runtime Knobs

These variables are exposed in the Helm `workloads.plannerTs.env` list and can
be overridden in a values file.

### LLM Call Resilience

| Variable | Default | Meaning | Tuning Guidance |
|----------|---------|---------|-----------------|
| `SYNESIS_PLANNER_TS_LLM_TIMEOUT_MS` | `300000` | Hard timeout for upstream LLM calls. | Keep longer than expected writer generations, but shorter than ingress/load-balancer idle timeouts. |
| `SYNESIS_PLANNER_TS_LLM_RETRY_MAX_ATTEMPTS` | `3` | Maximum attempts for retryable model failures. | Lower if providers bill failed attempts or if failures are usually deterministic. |
| `SYNESIS_PLANNER_TS_LLM_RETRY_BASE_DELAY_MS` | `1000` | Base delay before retry. | Increase for providers that need more recovery time after 429/5xx. |
| `SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `5` | Failures before opening a breaker for a route. | Lower to fail fast on fragile providers; raise only if transient failure rates are normal. |
| `SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS` | `60000` | Time before trying half-open probes. | Match provider recovery characteristics. |
| `SYNESIS_PLANNER_TS_LLM_CIRCUIT_BREAKER_HALF_OPEN_MAX` | `1` | Concurrent probe calls while half-open. | Keep small to avoid stampeding a recovering provider. |

The circuit breaker is in-memory per pod. It protects each pod from repeatedly
calling a failing upstream, but it is not a cluster-wide breaker.

### Graph Node Timeouts

| Variable | Default | Meaning | Tuning Guidance |
|----------|---------|---------|-----------------|
| `SYNESIS_PLANNER_TS_NODE_TIMEOUT_MS` | `60000` | Timeout for planner graph nodes such as entry, planner, router, critic, and final scrubber. | Raise only when real router/model calls need it; otherwise short timeouts keep failures contained. |
| `SYNESIS_PLANNER_TS_WRITER_NODE_TIMEOUT_MS` | `180000` | Writer-specific timeout for long answer generation. | Keep below outer LLM timeout and ingress idle timeout. |

When a node times out, the graph records an error and routes to `respond`
instead of leaving the request hanging.

### Rate Limits

| Variable | Default | Meaning | Scope |
|----------|---------|---------|-------|
| `SYNESIS_PLANNER_TS_GLOBAL_RATE_LIMIT_MAX` | `1200` | Fastify global request limit. | Per pod |
| `SYNESIS_PLANNER_TS_GLOBAL_RATE_LIMIT_WINDOW` | `1 minute` | Global limiter window. | Per pod |
| `SYNESIS_PLANNER_TS_RATE_LIMIT_MAX_REQUESTS` | `30` | User-scoped sliding-window request limit. | Per pod |
| `SYNESIS_PLANNER_TS_RATE_LIMIT_WINDOW_MS` | `60000` | User limiter window. | Per pod |

These are origin-side controls. For hard public-internet quotas, also configure
edge or gateway rate limits because pod-local counters multiply with replica
count.

### Stream Admission

| Variable | Default | Meaning | Tuning Guidance |
|----------|---------|---------|-----------------|
| `SYNESIS_PLANNER_TS_STREAM_MAX_CONCURRENT` | `50` | Max active streaming responses per pod. | Set from memory, provider concurrency, and p95 stream duration. Total capacity is roughly replicas times this value. |
| `SYNESIS_PLANNER_TS_STREAM_QUEUE_MAX` | `100` | Max queued streaming requests per pod once active slots are full. | Keep bounded; a large queue hides overload and increases user-visible latency. |
| `SYNESIS_PLANNER_TS_STREAM_QUEUE_WAIT_MS` | `30000` | Max time a streaming request waits for admission. | Keep below client/proxy timeout expectations. |

When the queue is full or times out, planner returns a rate/capacity error with
`Retry-After` instead of accepting unbounded work.

## Redis And Multi-Replica Safety

Redis is required for reliable multi-pod sessions. Planner stores conversation
history, checkpoints, pending clarification, and session metadata in Redis with
CAS (`WATCH`/`MULTI`) retry behavior.

| Variable | Default | Meaning |
|----------|---------|---------|
| `SYNESIS_PLANNER_TS_REDIS_URL` | from Helm secret | Redis URL. Required for meaningful `replicas > 1`. |
| `SYNESIS_PLANNER_TS_REDIS_KEY_PREFIX` | `synesis:planner:session:` | Key prefix for planner sessions. |
| `SYNESIS_PLANNER_TS_REDIS_SESSION_TTL_S` | `14400` | Redis session TTL, 4 hours. |
| `SYNESIS_PLANNER_TS_SESSION_MAX_SESSIONS` | `5000` | In-memory fallback cap when Redis is not configured. |
| `SYNESIS_PLANNER_TS_REDIS_CAS_MAX_RETRIES` | `5` | Conflict retry count for concurrent session updates. |

Without Redis, keep planner to one replica or accept that conversation memory
and clarification continuity are pod-local.

## Health And Observability

| Endpoint | Auth | Use |
|----------|------|-----|
| `/health` | none | Liveness. |
| `/health/readiness` | none | Readiness; checks dependencies such as Redis. |
| `/metrics` | none by default deployment | Prometheus scrape target. |
| `/health/detailed` | internal service token | Operational diagnostics: Redis, LLM resilience, prompt library, capability matrix, rate/admission stats, dependency health. |

Watch these signals during load tests:

- p95/p99 latency for stream and non-stream requests.
- 429/admission rejections and `Retry-After` frequency.
- Stream queue depth and queue timeouts.
- LLM circuit breaker open/half-open counts.
- Redis readiness failures or CAS retries.
- Provider-side rate limits and model-server saturation.
- Pod CPU throttling, memory high-water marks, restarts, and OOM kills.

## Load Verification

Run against a local port-forward or a non-production deployment:

```bash
cd base/planner-ts

PLANNER_URL=http://localhost:8080 \
PLANNER_MODEL="Synesis Auto" \
PLANNER_BEARER_TOKEN="<token>" \
npm run load:verify -- --concurrency 25 --requests 250 --stream false

PLANNER_URL=http://localhost:8080 \
PLANNER_MODEL="Synesis Auto" \
PLANNER_BEARER_TOKEN="<token>" \
npm run load:verify -- --concurrency 50 --requests 500 --stream true
```

Treat sustained non-zero error rate, repeated admission timeouts, OOM kills, or
unstable p95/p99 latency as a tuning signal. Increase Kubernetes capacity first
when pods are saturated. Lower app admission limits when pods stay healthy but
providers or clients time out. Tune retries and circuit breakers when upstream
model failures dominate.

## What Not To Tune First

- Do not raise stream queues to mask insufficient pods or provider capacity.
- Do not raise node/LLM timeouts above ingress or client idle timeouts.
- Do not rely on pod-local rate limits as your only internet-facing abuse
  control.
- Do not run multiple planner replicas without Redis unless conversation memory
  loss is acceptable.

## Related Docs

- [SCALING.md](../SCALING.md) — cross-service session and Kubernetes lifecycle model.
- [PLANNER_MEMORY_LIFECYCLE.md](PLANNER_MEMORY_LIFECYCLE.md) — planner Redis session lifecycle and cache policy.
- [PLANNER_OPENAI_COMPATIBILITY.md](PLANNER_OPENAI_COMPATIBILITY.md) — planner API behavior and streaming semantics.
- [OBSERVABILITY.md](../OBSERVABILITY.md) — metrics and tracing.
