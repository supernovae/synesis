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

The dashboard is deployed to the `perses-dev` namespace as a `PersesDashboard` CR.
A legacy Grafana ConfigMap (`synesis-grafana-dashboard`) also exists for clusters still
running the Grafana Operator.

## What's Monitored

### Request and Health

| Panel | PromQL | Description |
|-------|--------|-------------|
| Planner Latency (p95/p50) | `histogram_quantile(0.95, rate(synesis_chat_duration_seconds_bucket[5m]))` | End-to-end request latency |
| Service Health | `synesis_service_health` | Per-service health gauge (1=up, 0=down) |
| Circuit Breaker State | `synesis_circuit_breaker_state` | 0=closed, 1=half-open, 2=open |

### Critic and Tokens

| Panel | PromQL | Description |
|-------|--------|-------------|
| Critic Rejection Rate | `rate(synesis_critic_rejections_total[5m])` | How often the critic rejects worker output |
| Token Throughput | `rate(synesis_tokens_total[5m])` | Tokens/sec by model |

### RAG Retrieval

| Panel | PromQL | Description |
|-------|--------|-------------|
| Retrieval Source Distribution | `sum(synesis_retrieval_source_total) by (source)` | Milvus vs BM25 vs hybrid hits |
| Re-ranker Latency | `histogram_quantile(0.95, rate(synesis_reranker_duration_seconds_bucket[5m]))` | FlashRank/BGE re-ranking time |
| BM25 Fallback Rate | `rate(synesis_bm25_fallback_total[5m])` | Fallback when vector search fails |

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

### Graph Internals

| Panel | PromQL | Description |
|-------|--------|-------------|
| Iteration Distribution | `synesis_graph_iterations_bucket` | How many graph iterations per request |
| Average Confidence by Node | `synesis_node_confidence` | Per-node confidence scores |

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

- Planner (`base/planner/app/main.py`) -- central config via Pydantic Settings
- Health Monitor (`base/planner/app/health_monitor.py`)
- MCP Server (`base/mcp/app/server.py`)
- LSP Gateway (`base/lsp/gateway/app/main.py`)
- Admin Service (`base/admin/app/main.py`)

The base deployment YAMLs default to `"info"`. Overlays override per environment using
strategic merge patches (immune to env list reordering).

### Overriding at runtime

```bash
oc set env deployment/synesis-planner -n synesis-planner SYNESIS_LOG_LEVEL=debug
```

This triggers a rolling restart. To revert, redeploy the overlay.

## ServiceMonitors

| ServiceMonitor | Namespace | Targets | Interval |
|---------------|-----------|---------|----------|
| synesis-planner | synesis-planner | Planner API `/metrics` | 15s |
| synesis-health-monitor | synesis-planner | Health monitor `/metrics` | 15s |
| synesis-gateway | synesis-gateway | LiteLLM proxy `/metrics` | 15s |
| synesis-lsp-gateway | synesis-lsp | LSP gateway `/metrics` | 15s |
| synesis-models | synesis-models | All vLLM model pods `/metrics` | 30s |

## Profile Behavior (small / medium / large)

The `models.yaml` profiles control how many model pods are deployed. The dashboard
adapts automatically because all vLLM queries group by `model_name` label:

- **small** (2x L40S): Router + Critic panels visible
- **medium** (4x L40S): + General + Coder panels appear
- **large** (8+ GPU): Same models, potentially multiple replicas per role

No dashboard changes are needed when switching profiles.

## Adding New Metrics

1. Define the metric in your Python module using `prometheus_client`:

```python
from prometheus_client import Counter
MY_METRIC = Counter("synesis_my_metric_total", "Description", ["label"])
```

2. Ensure the service exposes `/metrics` (FastAPI apps use `generate_latest()`)
3. Verify a ServiceMonitor exists for the namespace (see table above)
4. Add a panel to `base/observability/perses-dashboard-synesis.yaml`
5. Test with: `curl http://localhost:<port>/metrics | grep synesis_my_metric`

## Future Enhancements

- **PrometheusRule alerting**: Latency p95 > 60s, circuit breaker open, high critic
  rejection rate, BM25 fallback spikes, model pod restarts
- **Perses datasource TLS**: Enable if Thanos Querier enforces mTLS on your cluster
  (uncomment TLS section in `base/observability/perses-datasource.yaml`)
- **Distributed tracing**: OpenTelemetry spans across planner graph nodes
