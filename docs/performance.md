# Synesis Performance Notes

Living document for **latency**, **prefill/context size**, and **observability**. Canonical graph flow is in [WORKFLOW.md](WORKFLOW.md). Model roles and vLLM flags are in [models.yaml](../models.yaml) and [VLLM_RECIPES.md](VLLM_RECIPES.md).

---

## Goals

1. **Keep prefill predictable** — Bound writer input (evidence + task block), avoid oversized critic inputs, scale retrieval fan-out with difficulty.
2. **Improve cache reuse** — Static system prompt segments first, per-request content last (vLLM prefix caching where enabled).
3. **Observe the path** — Structured logs and Prometheus metrics on retrieval, graph nodes, and chat latency.

---

## Implemented (verified in code)

| Area | What exists |
|------|-------------|
| **Graph telemetry** | `with_telemetry_node` in [`graph.py`](../base/planner/app/graph.py) logs `node_complete` with `node`, `latency_ms`, `outcome`, `next_node`. |
| **HTTP connection reuse** | `get_llm_http_client()` in [`llm_telemetry.py`](../base/planner/app/llm_telemetry.py) — shared `httpx` client; router/planner/critic can use UDS via `*_model_uds` settings. |
| **Streaming** | `streaming_events_enabled` → `astream_events(version="v2")` for status; writer can emit `direct_stream_request` for lightweight paths (handled in [`main.py`](../base/planner/app/main.py)). |
| **Context refs** | When `context_refs_enabled`, state carries `rag_context_refs` + `context_cache`; [`context_resolver.py`](../base/planner/app/context_resolver.py) resolves text for the writer. |
| **Token estimates** | [`token_utils.estimate_tokens`](../base/planner/app/token_utils.py) uses tiktoken when installed, else `len // 4`. Writer logs `writer_start` / `writer_budget_clamped` ([`writer.py`](../base/planner/app/nodes/writer.py)). |
| **Difficulty-scaled work** | Retrieval overfetch, web query budget, writer/critic/evidence budgets scale with `difficulty` ([`config.py`](../base/planner/app/config.py) — e.g. `rag_disable_below`, `scaled_web_budget`, `scaled_writer_budget`). |
| **RAG + rerank** | [`rag_client.py`](../base/planner/app/rag_client.py): merge/rerank (FlashRank / BGE), `rag_retrieval` / `rag_provenance_detail` logs, Prometheus counters/histograms for retrieval source and reranker latency. |
| **Unified retrieval** | [`unified_retrieval.py`](../base/planner/app/unified_retrieval.py): RAG-first, optional web with short post-RAG grace window (`_WEB_GRACE_MS`). |
| **Router retrieval cache** | `RouterNode` uses `HybridRetrievalCache` to avoid repeat retrieval work where applicable. |
| **History summarization** | [`history_summarizer.py`](../base/planner/app/history_summarizer.py) calls `summarizer_model_url` when set; else stub. |
| **Structured router sub-outputs** | Evidence packet summarizer uses vLLM `guided_json` when `guided_json_enabled` ([`router.py`](../base/planner/app/nodes/router.py)). Main router/critic outputs use free generation + validation/repair (see [`test_performance_changes.py`](../base/planner/tests/test_performance_changes.py)). |
| **Critic input shaping** | Difficulty-scaled character budget for draft text; optional skeleton extraction for lenient passes; truncation logs `critic_response_truncated` ([`critic.py`](../base/planner/app/nodes/critic.py)). |
| **API / graph metrics** | [`api_metrics.py`](../base/planner/app/api_metrics.py): chat duration, graph iterations, tokens, critic rejections. [`web_search.py`](../base/planner/app/web_search.py): search latency histogram. [`model_client.py`](../base/planner/app/model_client.py): circuit breaker / fallback counters. |

---

## Config: curator tier fields (not yet wired)

[`Settings`](../base/planner/app/config.py) defines `curator_tier1_2_max_tokens`, `curator_tier3_max_tokens`, `curator_tier4_max_tokens`, `curator_rag_max_tokens`, `curator_max_total_tokens`, `curator_min_rerank_score`, `curator_tiktoken_enabled`, plus `curator_knowledge_gap_threshold` and `curator_budget_alert_threshold`. **No planner module reads the tier/RAG token caps today** — they are placeholders for a future context assembly pass. [`ContextPack` / `ExcludedChunk`](../base/planner/app/schemas.py) schema exists for excluded-chunk metadata but is not populated on the live path.

**Action when implementing:** enforce caps in one place (e.g. evidence → writer assembly), log exclusions with reason + score, and either honor `curator_tiktoken_enabled` in `token_utils` or remove the unused flag.

---

## Token budget picture (target model)

Intended split once curator wiring lands (values match current defaults in `config.py`):

| Component | Max tokens (default) | Notes |
|-----------|---------------------|--------|
| Tier 1 & 2 (global/org) | 2,000 | Policy / standards — highest priority. |
| Tier 3 (project manifest) | 1,000 | Summarize if over limit. |
| Tier 4 (session/history) | 2,000 | LIFO-style trim. |
| Retrieved RAG | 3,000 | Rank by rerank score; evict low score / over budget. |
| **Total writer context cap** | 8,192 | `curator_max_total_tokens` — prefill sizing target. |

Until wired, actual bounds are **writer `model_context`**, **scaled writer budget**, and **critic input char budget**, not this table.

---

## Prefix-aware prompt structure

vLLM **prefix caching** reuses KV when requests share the same token prefix. Put **request-invariant** system text first and **per-request** system suffix + user messages after the boundary. Layering (L0/L1/L2) is described in [PROMPT_EPISTEMOLOGY.md](PROMPT_EPISTEMOLOGY.md).

### Node-level layout (canonical graph)

| Node | Static-friendly prefix | Dynamic tail |
|------|-------------------------|--------------|
| **Entry / planner** | Rules, JSON shape, trust policy | Taxonomy, depth, task frame in user message |
| **Plan gate** | Validation rules | Plan content under test |
| **Router** | Role-specific mini-prompts for query tools | Query, HyDE, refinement inputs |
| **Writer** | Formatting, citations, trust | Persona, domain, evidence, task block, revisions |
| **Critic** | Quality rubric, trust | Controls, draft excerpt, taxonomy hints |
| **Final scrubber** | Mostly deterministic | Light LLM polish when used |

The **general** model (`synesis-general`, writer) and **router** deployment enable `--enable-prefix-caching` and chunked prefill; see manifests under `base/model-serving/`. **Critic** (R1 distill) uses FP8 KV and `--reasoning-parser=deepseek_r1` — see `deployment-vllm-critic.yaml`. Exact args drift with profile; trust [VLLM_RECIPES.md](VLLM_RECIPES.md).

---

## Model roles (summary)

| Role | Registry default | Served name | Notes |
|------|------------------|-------------|--------|
| Router | Qwen2.5-14B-Instruct | `synesis-router` | Fast routing + auxiliary LLM calls on same endpoint in many setups. |
| General / writer | Qwen3-32B FP8-dynamic | `synesis-general` | Main answer synthesis; separate `writer_model_url` can override. |
| Critic | DeepSeek R1-Distill-Qwen-32B FP8 | `synesis-critic` | Thinking-style evaluation when dedicated pod is up. |
| Coder | Qwen3-Coder-30B-A3B-Instruct-FP8 | `synesis-coder` | IDE/agent path; separate endpoint. |
| Summarizer | Qwen2.5-0.5B-Instruct | `synesis-summarizer` | CPU / small footprint for history compression. |

Authoritative list: [models.yaml](../models.yaml).

---

## What to watch in production

- **Logs:** `node_complete`, `writer_start`, `writer_budget_clamped`, `rag_retrieval`, `critic_response_truncated`, `plan_gate_retry_planner`, direct-stream errors in `main.py`.
- **Metrics:** planner `/metrics` — chat duration histogram, graph iterations, reranker latency (`rag_client`), web search latency, model client circuit breaker trips.
- **vLLM:** OOM / queue depth on `synesis-general` and `synesis-critic`; align `max-model-len`, `max-num-seqs`, and KV settings with [VLLM_RECIPES.md](VLLM_RECIPES.md).

---

## References

- [WORKFLOW.md](WORKFLOW.md)
- [VLLM_RECIPES.md](VLLM_RECIPES.md)
- [GPU_TOPOLOGY.md](GPU_TOPOLOGY.md)
- [models.yaml](../models.yaml)
- [base/planner/app/config.py](../base/planner/app/config.py) — difficulty thresholds, budgets, `context_refs_enabled`, streaming flags
- [base/model-serving/README.md](../base/model-serving/README.md)
