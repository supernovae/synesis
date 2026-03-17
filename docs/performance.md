# Synesis Performance Roadmap

Living document for performance work: latency reduction, prefill optimization, and context trimming. See [WORKFLOW.md](WORKFLOW.md) for implementation details.

---

## Goals

1. **Reduce prefill latency** -- Trim context so prefill stays within target. FP8 KV cache on executor helps reduce memory pressure.
2. **Maximize prefix cache hits** -- Static content first in router/critic prompts; vLLM caches Tier 1/2 KV states.
3. **Protect high-value context** -- Never starve Org Standards (Tier 2) for low-signal RAG chunks.
4. **Rank-and-evict** -- Drop low-score RAG chunks before high-score; use telemetry for analysis.

---

## Done

| Item | Description |
|------|-------------|
| **Prefix caching** | Router-critic runtime with `--enable-prefix-caching` for Qwen2.5-14B. Executor uses FP8 KV cache instead (mutually exclusive with prefix caching). |
| **FP8 quantization (executor)** | DeepSeek R1-Distill-Qwen-32B FP8-dynamic with `--kv-cache-dtype=fp8_e5m2`. Native tensor core ops on L40S. |
| **Guided JSON decoding** | Router and Critic use `with_structured_output(RouterOut|CriticOut, method="json_schema")`; fallback to raw parse on failure. |
| **Persistent HTTP client** | `get_llm_http_client()` returns shared `httpx.Client`; reduces connection churn across graph run. |
| **State refs + cache** | `context_cache`, `rag_context_refs`; Router outputs refs; Executor/Planner resolve via `get_resolved_rag_context`. |
| **Debug node timers** | `with_debug_node_timing` logs `Node X took Yms` at DEBUG. |
| **Token budget config** | `curator_tier1_2_max_tokens`, `curator_tier3_max_tokens`, `curator_tier4_max_tokens`, `curator_rag_max_tokens`, `curator_max_total_tokens`, `curator_min_rerank_score`. |
| **Rank-and-evict** | Retrieved chunks sorted by reranker score; evict when over budget or score < threshold. |
| **Prefix-aware ordering** | Executor prompt order: [pinned (T1-4), RAG, Task/History]. Pinned injected from context_pack. |
| **Per-tier caps** | Tier 1+2, Tier 3, Tier 4 token limits enforced; truncate-from-end for T2/T3, LIFO drop for T4. |
| **Eviction telemetry** | `router_excluded` log with by_reason, scores, doc_ids when chunks excluded. |
| **Accurate token counting** | Optional tiktoken via `curator_tiktoken_enabled`. Fallback: ~2 tokens/word. |
| **History summarizer** | Micro model via `summarizer_model_url`. Pivot: summarize old era; fallback to stub. |
| **Summarizer on CPU** | Qwen2.5-0.5B-Instruct on vllm-cpu (no GPU); 8Gi RAM. |
| **Streaming (astream_events v2)** | Token streaming via `graph.astream_events(version="v2")`. Real-time SSE to Open WebUI. |
| **Reasoning content display** | R1-Distill `<think>` tags surface as "Thinking..." status in Open WebUI via `reasoning_content` chunks. |
| **LangChain 1.x** | `max_completion_tokens`, `use_responses_api=False` throughout. |
| **Direct streaming** | Explain-only and trivial tasks stream directly without planner overhead. Code tasks go through patch integrity gate. |

---

## Token Budget Partitioning Model

| Component | Max Tokens | Priority | Strategy |
|-----------|------------|----------|----------|
| Tier 1 & 2 (Global/Org) | 2,000 | CRITICAL | Never trim. |
| Tier 3 (Project Manifest) | 1,000 | HIGH | Summarize if > limit. |
| Tier 4 (Session/History) | 2,000 | MEDIUM | LIFO trim. |
| Retrieved RAG Chunks | 3,000 | DYNAMIC | Rank-and-evict by reranker score. |

**Config keys:** `curator_tier1_2_max_tokens`, `curator_tier3_max_tokens`, `curator_tier4_max_tokens`, `curator_rag_max_tokens`, `curator_max_total_tokens`, `curator_min_rerank_score`, `curator_tiktoken_enabled`.

**Summarizer:** Qwen2.5-0.5B-Instruct on CPU (`synesis-summarizer`, KServe InferenceService). Set `SYNESIS_SUMMARIZER_MODEL_URL`. 8Gi RAM.

**R1-Distill Thinking:** DeepSeek R1-Distill models always produce `<think>...</think>` reasoning before content. No `enable_thinking` parameter needed (that is Qwen3-specific). The reasoning is surfaced in Open WebUI as a "Thought for X seconds" indicator.

---

## Prefix-Aware Prompt Structure

To maximize vLLM prefix caching on the router model, static content comes first:

```
[STATIC] Tier 1 (Global Policy)
[STATIC] Tier 2 (Org Standards / Constitution)
[DYNAMIC] Tier 3 (Project Manifest)
[DYNAMIC] RAG Chunks (Ranked by score)
[DYNAMIC] History / Task
```

If Tier 1 and 2 are unchanged across requests, vLLM caches their KV states. Subsequent requests skip processing those tokens.

---

## Model Serving: Supported Features & Hardware

### Deployed Stack

| Model | Quantization | GPU | Instance | VRAM |
|-------|-------------|-----|----------|------|
| DeepSeek R1-Distill-Qwen-32B FP8-dynamic | FP8 | 1x L40S | g6e.4xlarge | ~33 GB |
| Qwen2.5-14B-Instruct | — | 1x L40S | g6e.4xlarge (shared) | ~14 GB |
| Qwen2.5-0.5B-Instruct | none | CPU | Any node | 0 |

### Key Features

| Feature | Where | Notes |
|---------|-------|------|
| **Prefix caching** | Router-Critic | `--enable-prefix-caching`. Incompatible with FP8 KV cache. |
| **FP8 KV cache** | Executor | `--kv-cache-dtype=fp8_e5m2`. Incompatible with prefix caching. |
| **Chunked prefill** | Executor | `--enable-chunked-prefill` for better TTFT. |
| **Reasoning parser** | Executor | `--reasoning-parser=deepseek_r1` parses `<think>` tags. |
| **Guided JSON decoding** | Router, Critic | `with_structured_output` via vLLM JSON schema. |

---

## References

- [WORKFLOW.md](WORKFLOW.md)
- [GPU_TOPOLOGY.md](GPU_TOPOLOGY.md)
- [VLLM_RECIPES.md](VLLM_RECIPES.md)
- [models.yaml](../models.yaml) -- single source of truth for deployed models
- `base/planner/app/config.py` -- `curator_*` settings
- `base/model-serving/README.md` -- deployment manifests
