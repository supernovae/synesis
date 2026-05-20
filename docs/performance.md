# Synesis Performance Notes

Latency, **writer evidence budgeting**, prefix ordering, and observability. Graph flow: [WORKFLOW_PLANNER.MD](chat/WORKFLOW_PLANNER.MD). Model roles are managed in admin Model Registry and resolved directly by runtime consumers. **vLLM flags, GPU sizing, OOM tuning:** [VLLM_RECIPES.md](VLLM_RECIPES.md) (do not duplicate here).

---

## Goals

1. **Rank-first evidence** — Retrieve and rank evidence in planner-ts through [`retrieval/unified.ts`](../base/planner-ts/src/retrieval/unified.ts) and [`rag-client.ts`](../base/planner-ts/src/retrieval/rag-client.ts) before writer composition.
2. **Predictable prefill** — Bound writer output by difficulty and model tier via [`budgets.ts`](../base/planner-ts/src/budgets.ts), [`config.ts`](../base/planner-ts/src/config.ts), and [`model-tiers.ts`](../base/planner-ts/src/model-tiers.ts).
3. **Observable** — Structured `context_curation` log, `request_feedback` fields, Prometheus metrics, and **Traces → trace detail** in admin for budget alerts vs low utilization.

---

## Writer evidence budgeting (implemented)

| Piece | Location |
|-------|-----------|
| Retrieval/ranking | [`retrieveUnified`](../base/planner-ts/src/retrieval/unified.ts) |
| RAG client | [`retrieveContext`](../base/planner-ts/src/retrieval/rag-client.ts) |
| Writer composition | [`writer-compose.ts`](../base/planner-ts/src/nodes/writer-compose.ts) |
| Budget metadata | [`budgetSpanMetadata`](../base/planner-ts/src/budgets.ts) |
| Traces / admin | Planner-ts span metadata and request trace fields exposed through admin traces |

Planner-ts estimates fallback usage in [`llm/client.ts`](../base/planner-ts/src/llm/client.ts) when an upstream provider omits usage.

---

## Per-request token budget (enforced)

The per-request budget policy is enforced through planner-ts node caps and model-tier ceilings, with actual utilization recorded in span metadata via [`budgetSpanMetadata`](../base/planner-ts/src/budgets.ts).

| Setting | Default | Description |
|---------|---------|-------------|
| `SYNESIS_TOKEN_BUDGET_TOTAL` | 0 (falls back to `max_tokens_per_request`) | Canonical per-request budget |
| `SYNESIS_TOKEN_BUDGET_WARN_PCT` | 0.20 | Fraction remaining → degraded mode |
| `SYNESIS_TOKEN_BUDGET_HARD_STOP_PCT` | 0.0 | Hard stop at 0% |
| `SYNESIS_TOKEN_BUDGET_OVERSPEND_TOLERANCE_PCT` | 0.10 | Single-call overshoot tolerance |
| `SYNESIS_TOKEN_BUDGET_ANOMALY_WINDOW` | 5 | Rolling window for anomaly detection |
| `SYNESIS_TOKEN_BUDGET_ANOMALY_TRIP_COUNT` | 3 | Overspends in window to trip signal |

**Hybrid enforcement:** Budget state transitions `healthy → degraded → exhausted`. At `degraded`, nodes may activate reduced-token prompts. At `exhausted`, nodes short-circuit. Overspend anomalies feed a rolling counter that trips breaker-style alerts.

**Tuning by model class:** Router and planner sub-calls are lightweight (query gen, summarization); writer/compiler are the heavy consumers. If budget exhausts early, increase `TOKEN_BUDGET_TOTAL` or reduce writer output budget (`writer_budget_max`). For models with verbose reasoning (o1-class), increase the tolerance or total budget proportionally.

**Prometheus:** `synesis_token_budget_remaining`, `synesis_token_budget_exhausted_total`, `synesis_token_budget_degraded_total`, `synesis_token_budget_overspend_total{node}`, `synesis_token_budget_anomaly_trips_total`.

**Trace context:** Every request trace includes `token_budget_total`, `token_budget_remaining`, `token_budget_consumed`, `token_budget_state`.

---

## Tier token fields (still future)

Legacy curator tier fields are retired for planner-ts. Writer and critic budget policy now flows through planner-ts config, budgets, and model-tier ceilings.

---

## Prefix-aware prompts

Put **static** system content first and **per-request** suffix + user messages last so vLLM prefix caching can hit where enabled ([`deployment-vllm-*.yaml`](../base/model-serving/) + [VLLM_RECIPES.md](VLLM_RECIPES.md)). Layering (L0/L1/L2): [PROMPT_EPISTEMOLOGY.md](PROMPT_EPISTEMOLOGY.md).

---

## Other implemented pieces (short)

- Graph: [`graph.ts`](../base/planner-ts/src/graph.ts) and [`pipeline.ts`](../base/planner-ts/src/pipeline.ts)
- Shared HTTP/model access: [`llm/client.ts`](../base/planner-ts/src/llm/client.ts)
- Streaming: [`app.ts`](../base/planner-ts/src/app.ts) and [`streaming/sse.ts`](../base/planner-ts/src/streaming/sse.ts)
- Retrieval: [`retrieval/rag-client.ts`](../base/planner-ts/src/retrieval/rag-client.ts) and [`retrieval/unified.ts`](../base/planner-ts/src/retrieval/unified.ts)

---

## References

- [VLLM_RECIPES.md](VLLM_RECIPES.md)
- [WORKFLOW_PLANNER.MD](chat/WORKFLOW_PLANNER.MD)
- [GPU_TOPOLOGY.md](GPU_TOPOLOGY.md)
- [base/planner-ts/src/config.ts](../base/planner-ts/src/config.ts)
