# Synesis Observability Guide

## Architecture

Synesis uses the **Cluster Observability Operator (COO)** stack on OpenShift:

```
ServiceMonitors    -->  Prometheus (user workload monitoring)
                          |
                    Thanos Querier
                          |
                    Perses Dashboards  (COO)
```

- **Prometheus** scrapes metrics via ServiceMonitors in each namespace
- **Thanos Querier** aggregates across namespaces (`thanos-querier.openshift-monitoring.svc.cluster.local:9091`)
- **Perses** renders dashboards (replaces deprecated Grafana)

## Accessing Dashboards

1. Log in to the OpenShift Console
2. Navigate to **Observe > Dashboards**
3. Select **Synesis - LLM Assistant Overview**

The dashboard is deployed to the `synesis-admin` namespace as a `PersesDashboard` CR.
A legacy Grafana ConfigMap (`synesis-grafana-dashboard`) also exists for clusters still
running the Grafana Operator.

## Metrics Source

Planner-ts and yarn-ts both use the shared `@synesis/telemetry` package (`packages/synesis-telemetry/src/metrics.ts`) which registers a standardized metric set. All planner metrics use the `synesis_planner_*` prefix; all Yarn metrics use `synesis_yarn_*`. The same `createServiceMetrics()` factory ensures consistent naming, labels, and types across both runtimes.

## What's Monitored

### Planner (synesis_planner_*)

| Panel | PromQL | Description |
|-------|--------|-------------|
| Request Latency (p95/p50) | `histogram_quantile(0.95, rate(synesis_planner_request_duration_seconds_bucket[5m]))` | End-to-end planner request latency |
| Request Rate | `sum(rate(synesis_planner_request_total[5m])) by (status)` | Request rate by status (ok/error) |
| Token Throughput | `sum(rate(synesis_planner_token_total[5m])) by (direction)` | Tokens/sec by direction (in/out) |
| Estimated Cost | `sum(rate(synesis_planner_cost_estimated_usd_total[5m])) by (model)` | Estimated USD/sec by model |
| Prefix Cache Hit Ratio | `synesis_planner_cache_hit_ratio` | Rolling cache hit ratio per model |
| Compaction Events | `sum(rate(synesis_planner_compaction_total[5m])) by (type)` | Session compaction events |

### Yarn (synesis_yarn_*)

| Panel | PromQL | Description |
|-------|--------|-------------|
| Request Latency (p95/p50) | `histogram_quantile(0.95, rate(synesis_yarn_request_duration_seconds_bucket[5m]))` | End-to-end Yarn request latency |
| Request Rate | `sum(rate(synesis_yarn_request_total[5m])) by (status)` | Request rate by status (ok/error) |
| Token Throughput | `sum(rate(synesis_yarn_token_total[5m])) by (direction)` | Tokens/sec by direction (in/out) |
| Estimated Cost | `sum(rate(synesis_yarn_cost_estimated_usd_total[5m])) by (model)` | Estimated USD/sec by model |
| Prefix Cache Hit Ratio | `synesis_yarn_cache_hit_ratio` | Rolling cache hit ratio per model |

### Health & Infrastructure

| Panel | PromQL | Description |
|-------|--------|-------------|
| Service Health | `synesis_service_health` | Per-service health gauge (1=up, 0=down) |
| Circuit Breaker State | `synesis_circuit_breaker_state` | 0=closed, 1=half-open, 2=open |

Admin API note:

- `/api/v1/observability/circuit-breakers` combines:
  - health-monitor infrastructure/web breaker metrics (`synesis_circuit_breaker_*`)
  - LiteLLM model endpoint health (`/health`) + `litellm_deployment_failure_total` for the LLM category

### Sandbox

| Panel | PromQL | Description |
|-------|--------|-------------|
| Execution Success/Failure | `rate(synesis_sandbox_executions_total[5m])` | By outcome label |
| Sandbox Latency | `histogram_quantile(0.95, rate(synesis_sandbox_duration_seconds_bucket[5m]))` | By language |
| Failure Types | `sum(synesis_sandbox_failures_by_type_total) by (error_type)` | timeout, syntax, runtime, etc. |

### LSP

| Panel | PromQL | Description |
|-------|--------|-------------|
| Analysis Latency | `histogram_quantile(0.95, rate(synesis_lsp_analysis_duration_seconds_bucket[5m]))` | By language |
| Diagnostics by Severity | `rate(synesis_lsp_diagnostics_count[5m])` | error, warning, info counts |
| Language Usage | `sum(synesis_lsp_analysis_requests_total) by (language)` | Which languages get analyzed |
| Circuit Breaker State | `synesis_lsp_circuit_breaker_state` | Per-language circuit state |

**Traces (Postgres):** `conversation_id`, `parent_trace_id`, and `root_trace_id` link runs in a chat session. Admin: `GET /api/v1/traces?conversation_id=...` or `DELETE /api/v1/traces/session/{conversation_id}` to purge a session. Do not put raw conversation IDs on Prometheus metric labels.

**Perses:** `PersesDashboard` / `PersesDatasource` for Synesis live in **`synesis-admin`**. COO must reconcile Perses CRs in that namespace (Observe → Dashboards).

**Trace redaction:** optional `SYNESIS_TRACE_REDACT_PATTERNS` (pipe-separated regexes) augments default redaction for persisted trace JSON.

## OTEL Tracing Guide (planner/yarn/mcp)

This section defines the target operating pattern for end-to-end OpenTelemetry
across planner, yarn, and MCP request paths.

### Current state

- `yarn-ts` has optional OTEL bootstrap in `base/yarn-ts/src/telemetry/otel.ts`.
- `planner-ts` currently emits structured traces via `@synesis/telemetry` + `emitTrace` and does not yet bootstrap OTEL spans.
- MCP activity in TypeScript is routed through `yarn-ts` (`base/yarn-ts/src/mcp/`) and should be correlated with yarn request IDs.

### End-to-end trace contract

- Ingress correlation:
  - preserve/accept `traceparent` when present,
  - always attach/propagate `x-request-id`,
  - preserve `x-synesis-authz-trace-id` for policy lineage.
- Egress propagation:
  - planner -> LiteLLM / downstream HTTP calls include W3C trace headers,
  - yarn -> model provider and MCP proxy calls include W3C trace headers,
  - yarn MCP routes include request correlation fields in logs/events.
- Service identity:
  - set `service.name` and deployment environment resource attrs consistently.

### Collector/exporter baseline

- Enable OTLP HTTP exporter in each TS service with env-driven endpoint.
- Export to cluster collector (Jaeger/Tempo/OTel Collector) using:
  - `OTEL_EXPORTER_OTLP_ENDPOINT`
  - `OTEL_SERVICE_NAME`

### Verification checklist

- A single user request can be followed across:
  - yarn ingress span,
  - optional planner escalation span,
  - model/provider call span,
  - MCP tool call span (when tools are used),
  - admin ingest/log correlation (`request_id`, `trace_id`, authz trace).
- Correlation IDs are queryable in logs and trace backend.
- No sensitive prompt/token payload is emitted in span attributes by default.

### Model Serving (vLLM)

These panels auto-discover models by `model_name` label. Small profile shows 2 models,
medium shows 4, large shows more -- no dashboard changes needed when scaling.

| Panel | PromQL | Description |
|-------|--------|-------------|
| Time to First Token (p95) | `histogram_quantile(0.95, rate(vllm:time_to_first_token_seconds_bucket[5m]))` | TTFT by model role |
| Request Throughput | `rate(vllm:request_success_total[5m])` | Requests/sec by model |
| GPU KV Cache Utilization | `vllm:gpu_cache_usage_perc` | How full the KV cache is per model |

## Logging Levels

All Synesis components read `SYNESIS_LOG_LEVEL` from the environment:

| Overlay | Level | Effect |
|---------|-------|--------|
| dev | `debug` | Full request/response tracing, node latency, LLM headers |
| staging | `info` | Standard operational logging |
| prod | `warning` | Errors and warnings only |

**Components that respect `SYNESIS_LOG_LEVEL`:**

- Planner-ts (`base/planner-ts/src/config.ts`)
- Yarn-ts (`base/yarn-ts/src/index.ts`)
- Health Monitor (`base/planner/app/health_monitor.py`)
- MCP Server (`base/mcp/app/server.py`)
- LSP Gateway (`base/lsp/gateway/app/main.py`)
- Admin Service (`base/admin/app/main.py`)

The base deployment YAMLs default to `"info"`. Overlays override per environment using
strategic merge patches (immune to env list reordering).

### Overriding at runtime

```bash
oc set env deployment/synesis-planner-ts -n synesis-planner SYNESIS_LOG_LEVEL=debug
```

This triggers a rolling restart. To revert, redeploy the overlay.

## ServiceMonitors

| ServiceMonitor | Namespace | Targets | Interval |
|---------------|-----------|---------|----------|
| synesis-planner-ts | synesis-planner | Planner-ts API `/metrics` | 15s |
| synesis-yarn | synesis-yarn | Yarn-ts API `/metrics` | 15s |
| synesis-health-monitor | synesis-planner | Health monitor `/metrics` | 15s |
| synesis-gateway | synesis-gateway | LiteLLM proxy `/metrics` | 15s |
| synesis-lsp-gateway | synesis-lsp | LSP gateway `/metrics` | 15s |
| synesis-models | synesis-models | All vLLM model pods `/metrics` | 30s |

## Profile Behavior (small / medium / large)

The `models.yaml` profiles control how many model pods are deployed. The dashboard
adapts automatically because all vLLM queries group by `model_name` label:

- **small** (3x L40S): Router/Critic + General + Coder panels visible
- **medium** (4x L40S): All roles dedicated; + separate Critic panel
- **large** (8+ GPU): Same models, potentially multiple replicas per role

No dashboard changes are needed when switching profiles.

## Adding New Metrics

For planner-ts or yarn-ts, add metrics to the shared `@synesis/telemetry` package (`packages/synesis-telemetry/src/metrics.ts`) using the `createServiceMetrics()` factory:

```typescript
// In packages/synesis-telemetry/src/metrics.ts — ServiceMetrics interface
myNewCounter: new Counter({
  name: `synesis_${service}_my_new_total`,
  help: `Description of the metric`,
  registers: [registry],
  labelNames: ["label1", "label2"],
}),
```

For other Python services, use `prometheus_client`:

```python
from prometheus_client import Counter
MY_METRIC = Counter("synesis_my_metric_total", "Description", ["label"])
```

Steps:

1. Define the metric in `@synesis/telemetry` (TypeScript) or the service module (Python)
2. Ensure the service exposes `GET /metrics` (Fastify apps via `prom-client`; FastAPI via `generate_latest()`)
3. Verify a ServiceMonitor exists for the namespace (see table above)
4. Add a panel to `base/observability/perses-dashboard-synesis.yaml`
5. Test with: `curl http://localhost:<port>/metrics | grep synesis_my_metric`

## LLM Tracing: SpanCollector

Planner-ts includes a lightweight built-in tracing system (`SpanCollector` in
`base/planner-ts/src/telemetry/`) that captures per-request pipeline spans and
persists them to Redis. No external infrastructure required — the tracer reuses
the existing Redis instance already deployed for feedback storage and session
persistence.

### What SpanCollector Provides

- **Per-node span tracing**: entry_pipeline, router, planner, retrieval, writer, critic — auto-traced via `SpanCollector`
- **Per-LLM-call detail**: model name, prompt/completion token counts, latency
- **Request-level metadata**: `difficulty`, `task_type`, `domain_tags`, `response_length`
- **Admin UI integration**: Trace list with filtering, trace detail with waterfall timeline

### Configuration

| Setting | Env Var | Default | Purpose |
|---------|---------|---------|---------|
| `trace_store_ttl_hours` | `SYNESIS_TRACE_TTL_HOURS` | `168` (7 days) | How long traces are retained in Redis |
| `trace_snippet_max_chars` | `SYNESIS_TRACE_SNIPPET_MAX_CHARS` | `500` | Max chars for prompt/completion snippets |

The tracer activates automatically when `SYNESIS_REDIS_URL` is set (which it
already is for feedback and session persistence). No separate toggle needed.

### Storage Schema

Traces are stored in the same Redis instance:

- `synesis:traces:{trace_id}` — JSON blob per trace (typically 5–20KB)
- `synesis:traces:index` — sorted set (score=timestamp) for time-range queries

Old entries are pruned automatically based on the TTL setting.

### Viewing Traces

Browse traces in the Admin UI under **Tracing > Activity Log**:

- Filter by status (error/success), task type, difficulty, domain
- Click any trace to see waterfall timeline, span details, LLM call snippets, and critic scores
- Dashboard metrics (error rate, avg latency) are automatically derived from trace data

## Knowledge Gap Lifecycle

Knowledge gaps (low-confidence retrieval events) are recorded in the `synesis_knowledge_backlog` Milvus collection. Admins can manage their lifecycle through the Admin UI or API:

| Status | Description |
|--------|-------------|
| `open` | New gap — retrieval confidence was low |
| `resolved` | Admin marked as addressed |
| `reopened` | Previously resolved gap that resurfaced |

Status metadata is stored in a companion `synesis_knowledge_gap_status` collection. Admin endpoints:

| Action | Endpoint | Method |
|--------|----------|--------|
| List gaps | `/admin/observability/knowledge-gaps` | GET (with `?status=open\|resolved\|reopened`) |
| Stats | `/admin/observability/knowledge-gaps/stats` | GET |
| Resolve | `/admin/observability/knowledge-gaps/{chunk_id}/resolve` | POST |
| Reopen | `/admin/observability/knowledge-gaps/{chunk_id}/reopen` | POST |
| Purge | `/admin/observability/knowledge-gaps/{chunk_id}` | DELETE |
| **Validate** | `/admin/observability/knowledge-gaps/validate` | POST |

### Post-RAG-Load Gap Validation

After indexing new content, trigger validation to auto-resolve satisfied gaps:

```
POST /admin/observability/knowledge-gaps/validate
{
  "score_threshold": 0.6,
  "max_gaps": 200
}
```

The endpoint:
1. Queries all open/reopened gaps from `synesis_knowledge_backlog`
2. For each gap, runs a vector similarity search against `synesis_catalog` using the gap's stored embedding
3. If the top retrieval score exceeds the threshold, auto-resolves the gap with `resolution_note: "auto-validated: RAG score {score}"`
4. Returns a summary:

```json
{
  "validated": 12,
  "still_open": 8,
  "errors": 0,
  "details": [
    {"chunk_id": "abc123", "status": "validated", "score": 0.82, "query": "..."},
    {"chunk_id": "def456", "status": "still_open", "score": 0.41, "query": "..."}
  ]
}
```

Run this after every indexer pipeline completion to close the feedback loop between retrieval gaps and corpus improvements.

## Future Enhancements

- **PrometheusRule alerting**: Planner/Yarn latency p95 > 60s, circuit breaker open,
  cost anomaly detection, model pod restarts
- **Perses datasource TLS**: Enable if Thanos Querier enforces mTLS on your cluster
  (uncomment TLS section in `base/observability/perses-datasource.yaml`)
- **Prompt optimization**: Use collected trace data for offline prompt tuning
  (critic, query generation, summarizer)
