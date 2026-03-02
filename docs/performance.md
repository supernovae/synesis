# Synesis Performance Roadmap

Living document for performance work: latency reduction, prefill optimization, and context trimming. **[Model Serving: Supported Features & Hardware](#model-serving-supported-features--hardware)** tracks vLLM support, RHOAI constraints, and AWS GPU economy. See [WORKFLOW.md § Performance and State Payload Optimization](WORKFLOW.md#performance-and-state-payload-optimization) for implementation details.

---

## Goals

1. **Reduce prefill latency** — GPU memory bandwidth saturation during prompt ingestion causes ~17s gaps on A10G. Trim context so prefill stays within target.
2. **Maximize prefix cache hits** — Static content first → vLLM caches Tier 1/2; subsequent requests skip those tokens.
3. **Protect high-value context** — Never starve Org Standards (Tier 2) for low-signal RAG chunks.
4. **Rank-and-evict** — Drop low-score RAG chunks before high-score; use telemetry for Safety-II analysis.

---

## Done

| Item | Description |
|------|-------------|
| **Prefix caching** | synesis-supervisor-critic runtime with `--enable-prefix-caching` for Qwen3-8B (Supervisor, Critic). Executor stays on synesis-executor (MoE, no cache). |
| **Guided JSON decoding** | Supervisor and Critic use `with_structured_output(SupervisorOut\|CriticOut, method="json_schema")`; fallback to raw parse on failure. |
| **Persistent HTTP client** | `get_llm_http_client()` returns shared `httpx.Client`; reduces connection churn across graph run. |
| **State refs + cache** | `context_cache`, `rag_context_refs`; Context Curator outputs refs; Worker/Planner resolve via `get_resolved_rag_context`. |
| **Debug node timers** | `with_debug_node_timing` logs `Node X took Yms` at DEBUG. |
| **Token budget config** | `curator_tier1_2_max_tokens`, `curator_tier3_max_tokens`, `curator_tier4_max_tokens`, `curator_rag_max_tokens`, `curator_max_total_tokens`, `curator_min_rerank_score`. |
| **Rank-and-evict** | Retrieved chunks sorted by reranker score; evict when over budget or score < threshold; excluded chunks recorded for telemetry. |
| **Prefix-aware ordering** | Worker prompt order: [pinned (T1–4), RAG, Task/History]. Pinned injected from context_pack. |
| **Per-tier caps** | Tier 1+2, Tier 3, Tier 4 token limits enforced; truncate-from-end for T2/T3, LIFO drop for T4. |
| **Eviction telemetry** | `context_curator_excluded` log with by_reason, scores, doc_ids when chunks excluded. |
| **Accurate token counting** | Optional tiktoken via `curator_tiktoken_enabled`. Fallback: ~2 tokens/word. |
| **History summarizer** | Micro model via `summarizer_model_url`. Pivot: summarize old era; fallback to stub. |
| **Tier 3 summarization** | When project manifest over limit + summarizer deployed, compress via LLM; else truncate. |
| **Summarizer on CPU** | Qwen2.5-0.5B-Instruct on vllm-cpu (no GPU); 8Gi RAM. Frees GPU for 8B/30B. |
| **Speculative decoding** | Ngram only: `prompt_lookup_max=4`, `num_speculative_tokens=5`. Draft-model not supported in RHOAI vLLM. |
| **Thinking Mode gate** | Worker enables `enable_thinking` when task_size=complex; config `worker_thinking_mode_enabled`. |

---


---

## TODO

| Item | Notes |
|------|-------|

---

## Token Budget Partitioning Model

| Component | Max Tokens | Priority | Strategy |
|-----------|------------|----------|----------|
| Tier 1 & 2 (Global/Org) | 2,000 | CRITICAL | Never trim. |
| Tier 3 (Project Manifest) | 1,000 | HIGH | Summarize if > limit. |
| Tier 4 (Session/History) | 2,000 | MEDIUM | LIFO trim. |
| Retrieved RAG Chunks | 3,000 | DYNAMIC | Rank-and-evict by reranker score. |

**Config keys:** `curator_tier1_2_max_tokens`, `curator_tier3_max_tokens`, `curator_tier4_max_tokens`, `curator_rag_max_tokens`, `curator_max_total_tokens`, `curator_min_rerank_score`, `curator_tiktoken_enabled`.

For accurate token counts: set `curator_tiktoken_enabled=true` and install `tiktoken` (optional: `pip install tiktoken`).

**Summarizer:** Qwen2.5-0.5B-Instruct on CPU (`synesis-summarizer`, vllm-cpu runtime). Used for: (1) pivot history on language switch, (2) Tier 3 project manifest when over token limit. Set `SYNESIS_SUMMARIZER_MODEL_URL`. 8Gi RAM.

**Speculative decoding:** Ngram only (`prompt_lookup_max=4`, `num_speculative_tokens=5`). Draft-model speculative not supported in RHOAI vLLM image—see [Model Serving: Supported Features & Hardware](#model-serving-supported-features--hardware).

**Thinking Mode:** When `task_size=complex`, Worker enables Qwen3 `enable_thinking` (<think> deliberation). Config: `worker_thinking_mode_enabled`. Use fast path for trivial/small.

---

## Prefix-Aware Prompt Structure

To maximize vLLM prefix caching, static content must come first:

```
[STATIC] Tier 1 (Global Policy)
[STATIC] Tier 2 (Org Standards / Constitution)
[DYNAMIC] Tier 3 (Project Manifest)
[DYNAMIC] RAG Chunks (Ranked by score)
[DYNAMIC] History / Task
```

If Tier 1 and 2 are unchanged across requests, vLLM caches their KV states. Subsequent requests skip processing those tokens (~3–5s savings on prefill).

---

## Notes: Worker Prompt Order Audit

The Worker prompt is assembled in prefix-aware order: `[pinned_block (Tier1–4), context_block (RAG), milestone_banner, Task, plan_block, conflict_block, web_block, ...]`. Pinned content (output format, org standards, project manifest, session) is injected from `context_pack.pinned` via `_build_pinned_block`. Per-tier caps in the curator keep pinned within budget. Static content (Tier1/2) comes first to maximize vLLM prefix cache hits.

---

## Model Serving: Supported Features & Hardware

Track what the RHOAI/ODH vLLM stack supports, what does not, and hardware economy for AWS deployments. See `base/model-serving/README.md` for deployment details.

### Supported

| Feature | Where | Notes |
|---------|-------|------|
| **Prefix caching** | Supervisor, Critic | `--enable-prefix-caching`. Max gains when Tier 1/2 static content is unchanged across requests. |
| **Ngram speculative decoding** | Supervisor, Critic, Executor | `method: "ngram"`, `prompt_lookup_max: 4`, `num_speculative_tokens: 5`. No extra model; best on code/repetitive output. |
| **Guided JSON decoding** | Planner (client-side) | `with_structured_output(SupervisorOut\|CriticOut)` via litellm. |
| **Qwen3 reasoning parser** | Executor | `--reasoning-parser=qwen3`, `--enable-auto-tool-choice`, `--tool-call-parser=qwen3_coder`. |
| **Summarizer on CPU** | synesis-summarizer | vllm-cpu, 8Gi RAM; loads from HF repo ID to avoid local-path bug. |

### Not Yet Supported (RHOAI vLLM 0.11.2+rhai5)

| Feature | Status | What to watch |
|---------|--------|---------------|
| **Draft-model speculative decoding** | Not supported | Error: *"Speculative decoding with draft model is not supported yet"*. Use ngram instead. |
| **Custom vLLM from Docker Hub** | Fails on RHOAI | Python path issues. Use RHOAI or llm-on-openshift images only. |
| **Prefix caching on MoE** | Disabled for Executor | vLLM recommends `--no-enable-prefix-caching` for MoE. |

### Features to Watch

When upgrading RHOAI or the vLLM image:

1. **Draft-model speculative decoding** — If a new RHOAI vLLM image supports it, we could re-enable `--speculative_config` with Qwen2.5-0.5B-Instruct for ~1.5–2× decode speedup. Requires `HF_HUB_OFFLINE=false` (already set) so the draft model can download.
2. **vLLM local-path bug** — Summarizer uses HF repo ID instead of `/mnt/models` due to [vLLM #13485, #13707](https://github.com/vllm-project/vllm/issues/13485). If fixed in a newer image, we could switch back to KServe-mounted model.
3. **Medusa / EAGLE / MTP** — Alternative speculative methods; check vLLM release notes for RHOAI image compatibility.
4. **Chunked prefill** — RHOAI vLLM may already enable it; verify `max_num_batched_tokens` for prefill tuning.

### Hardware Recommendations (AWS)

| Model | Current SKU | VRAM | AWS Instance | Notes |
|-------|-------------|------|--------------|-------|
| **Supervisor, Critic** | RedHatAI/Qwen3-8B-FP8-dynamic | ~8 GiB | g5.xlarge (A10G 24GB) | 1 GPU each; prefix cache + ngram. |
| **Executor** | Qwen3-Coder-30B-A3B-FP8 | ~30 GiB | g6e.4xlarge (L40S 48GB) | MoE; needs 48GB. |
| **Summarizer** | Qwen2.5-0.5B-Instruct | CPU | Any node | No GPU; 8Gi RAM. |

**AWS GPU Economy (us-east-1 on-demand, ~2024):**

| Instance | GPU | VRAM | $/hr | Best for |
|----------|-----|------|------|----------|
| g5.xlarge | A10G | 24 GB | ~$1.23 | Supervisor, Critic (8B) |
| g6.xlarge | L4 | 24 GB | ~$0.98 | Alternative for 8B; newer Ada, similar VRAM. |
| g6e.4xlarge | L40S | 48 GB | ~$3.40 | Executor (30B MoE). |
| g5.12xlarge | 4× A10G | 96 GB | ~$5.67 | Multi-model or very large models. |

**Economy notes:**

- **g6 vs g5** — L4 (g6) is often cheaper than A10G (g5) for 24GB; verify FP8 support for RedHatAI/Qwen3-8B.
- **Spot** — Up to ~70% discount; acceptable for dev/staging. Use `Recreate` deployment so restarts don't require N+1 GPU.
- **Reserved** — 1–3 year commits save 50–60% if usage is steady.
- **L40S (g6e)** — Highest $/hr; required for 30B MoE. No cheaper 48GB alternative in standard fleet.

**Node selectors:** Manifests use `nvidia.com/gpu.product: NVIDIA-A10G` (supervisor/critic) and `NVIDIA-L40S` (executor). Adjust if using g6 (L4) or different instance types.

---

## References

- [WORKFLOW.md § Performance and State Payload Optimization](WORKFLOW.md#performance-and-state-payload-optimization)
- [WORKFLOW.md § Context Curator](WORKFLOW.md#context-curator-first-class-core-to-long-context-stability)
- `base/planner/app/nodes/context_curator.py` — trim logic, tier caps, rank-and-evict
- `base/planner/app/config.py` — `curator_*` settings
- `base/model-serving/README.md` — InferenceService manifests, troubleshooting
