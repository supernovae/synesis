# Synesis Performance Notes

Latency, **writer evidence budgeting**, prefix ordering, and observability. Graph flow: [WORKFLOW.md](WORKFLOW.md). Model roles: [models.yaml](../models.yaml). **vLLM flags, GPU sizing, OOM tuning:** [VLLM_RECIPES.md](VLLM_RECIPES.md) (do not duplicate here).

---

## Goals

1. **Rank-first evidence** — Pack retrieved content by **descending router confidence** into token + character budgets so strong evidence is never dropped for weaker packets ([`context_curation.py`](../base/planner/app/context_curation.py)).
2. **Predictable prefill** — Bound writer input; scale retrieval fan-out with difficulty ([`config.py`](../base/planner/app/config.py)).
3. **Observable** — Structured `context_curation` log, `request_feedback` fields, Prometheus metrics, and **Traces → trace detail** in admin for budget alerts vs low utilization.

---

## Writer evidence budgeting (implemented)

| Piece | Location |
|-------|-----------|
| Greedy pack + truncation | [`curate_evidence_for_writer`](../base/planner/app/context_curation.py) |
| Config | `curator_rag_max_tokens`, `curator_min_rerank_score`, `curator_budget_alert_threshold`, `scaled_evidence_budget` |
| Logs | `context_curation` (counts, utilization, alerts); `request_feedback` adds `context_curation_*` keys |
| Prometheus | `synesis_context_curation_excluded_total{reason}`, `synesis_context_curation_budget_alert_total`, `synesis_context_curation_token_utilization_ratio`, `synesis_context_curation_low_utilization_total` |
| Traces / admin | [`synesis_tracer.set_context_curation`](../base/planner/app/synesis_tracer.py) → `TraceRecord.context_curation` → **Traces → Writer context budgeting** panel |

Token estimates use [`token_utils.estimate_tokens`](../base/planner/app/token_utils.py) (tiktoken when the package is installed, else `len // 4`). There is **no** separate `curator_tiktoken` flag.

---

## Tier token fields (still future)

`curator_tier1_2_max_tokens`, `curator_tier3_max_tokens`, `curator_tier4_max_tokens`, and `curator_max_total_tokens` remain in Settings for a **pinned-tier + RAG** assembly path. Today only **RAG/evidence** packing uses `curator_rag_max_tokens` (plus char budget). [`ContextPack`](../base/planner/app/schemas.py) is the schema for future trust-tier wiring.

---

## Prefix-aware prompts

Put **static** system content first and **per-request** suffix + user messages last so vLLM prefix caching can hit where enabled ([`deployment-vllm-*.yaml`](../base/model-serving/) + [VLLM_RECIPES.md](VLLM_RECIPES.md)). Layering (L0/L1/L2): [PROMPT_EPISTEMOLOGY.md](PROMPT_EPISTEMOLOGY.md).

---

## Other implemented pieces (short)

- Graph: `with_telemetry_node` → `node_complete` ([`graph.py`](../base/planner/app/graph.py))
- Shared HTTP: `get_llm_http_client()` ([`llm_telemetry.py`](../base/planner/app/llm_telemetry.py))
- Streaming / direct stream: [`main.py`](../base/planner/app/main.py), `streaming_events_enabled`
- Context refs: `rag_context_refs` + `context_cache` ([`context_resolver.py`](../base/planner/app/context_resolver.py))
- RAG metrics: [`rag_client.py`](../base/planner/app/rag_client.py); chat metrics: [`api_metrics.py`](../base/planner/app/api_metrics.py)

---

## References

- [VLLM_RECIPES.md](VLLM_RECIPES.md)
- [WORKFLOW.md](WORKFLOW.md)
- [GPU_TOPOLOGY.md](GPU_TOPOLOGY.md)
- [models.yaml](../models.yaml)
- [base/planner/app/config.py](../base/planner/app/config.py)
