# Synesis Architecture Audit

Full end-to-end review covering LLM orchestration, RAG/retrieval, infrastructure/caching, and evaluation/governance. Findings are severity-ranked with evidence and concrete remediation.

---

## Phase 1: Risk Register

### Severity Legend

| Level | Meaning |
|-------|---------|
| **P0-Critical** | Runtime crash, data loss, or complete feature failure |
| **P0-High** | Incorrect behavior, silent data quality degradation, or cost blowout |
| **P1-Medium** | Suboptimal performance, maintainability risk, or missing observability |
| **P2-Low** | Dead code, minor inconsistency, or future tech debt |

---

### P0: Critical and High

| # | Severity | Domain | Finding | Evidence | Impact | Remediation |
|---|----------|--------|---------|----------|--------|-------------|
| 1 | **Critical** | RAG | `_get_milvus_client()` not defined in rag_client.py | Called at lines ~327, ~382 in `_hybrid_search()` and `_sparse_search()` but never defined. `_vector_search` creates a client inline but hybrid/sparse do not. | **NameError on every hybrid/BM25 retrieval call.** Currently masked if hybrid search never executes (e.g. planner restart cleared state). | Define `_get_milvus_client()` as a module-level singleton returning `MilvusClient(uri=...)`, matching the inline pattern in `_vector_search`. |
| 2 | **Critical** | RAG | `import time` missing in rag_client.py | `time.monotonic()` used in `_rerank_flashrank` (line ~433) and `_rerank_bge` (lines ~453, ~457). No `import time` in imports (lines 16-27). | **NameError on every rerank call** for both FlashRank and BGE paths. | Add `import time` to the imports block. |
| 3 | **High** | RAG | `_sparse_search()` drops domain filter | Signature (lines 376-381) has no `filter_expr` parameter. `_retrieve_single_collection` calls it without a domain filter, unlike `_hybrid_search` which accepts one. | BM25 fallback returns **unfiltered cross-domain results**, degrading relevance and violating taxonomy routing. | Add `filter_expr: str = ""` parameter and pass it through to `client.search(filter=...)`. |
| 4 | **High** | RAG | `_taxonomy_boost()` checks wrong field | `unified_retrieval.py` lines 197-202: `doc_domain` is populated from `authority`, not `domain`. `UnifiedResult` has no `domain` field at all (lines 57-73). | Taxonomy boost **never matches on domain** — only coincidentally matches if authority strings overlap with domain hints. Boost is effectively broken for domain targeting. | Add `domain: str = ""` to `UnifiedResult`, populate it in `_rag_to_unified`, and check `domain` in `_taxonomy_boost`. |
| 5 | **High** | Orchestration | No circuit breaker on LLM calls | `health_monitor.py` defines `CircuitBreaker` (lines 54-91) but no graph node imports it. All LLM calls go directly to endpoints. | Repeated calls to unhealthy endpoints (OpenRouter outage, rate limit) **degrade all requests** without backoff. | Create a shared `model_client.py` wrapper that checks circuit breaker state before each LLM call and opens the breaker on consecutive failures. |
| 6 | **High** | Orchestration | No model fallback for LLM failures | `executor.py` (lines ~944-960), `writer.py` (~600-606), `planner_node.py` (~626-674): all catch `Exception` and return degraded output. None retry with an alternate model or endpoint. | Single OpenRouter model outage = fully degraded output for that role; no resilience to per-model availability. | Add fallback model config (e.g. `SYNESIS_GENERAL_MODEL_FALLBACK_NAME`). On timeout/5xx, retry once against the fallback model via LiteLLM. |
| 7 | **High** | Orchestration | Token budget not enforced by router/planner/writer | `token_budget_remaining` is set at request start (`main.py` line 974), but only executor and critic read and decrement it. Router (multi-query expansion, HyDE, summarization), planner, and writer consume tokens without accounting. | **No budget enforcement** on 4 of 6 LLM-calling nodes. Long multi-step requests can far exceed `max_tokens_per_request` (100K). | Each node that calls an LLM should decrement `token_budget_remaining` by `response.usage_metadata.total_tokens`. Add a global pre-check: if budget <= 0, route to `respond`. |
| 8 | **High** | Infra | Redis semantic index keys never expire | `semantic_index.py` `insert()` (lines 240-251): only calls `HSET`, never `EXPIRE`. Eviction runs only on `put()` via `_evict()`. | If cache is read-heavy with few writes, **expired keys persist indefinitely** in Redis, consuming memory without being cleaned. Redis `allkeys-lru` is a last resort, not a correctness guarantee. | Add `self._r.expire(key, int(ttl_seconds))` after `HSET` in `insert()`. |
| 9 | **High** | Infra | RedisSaver checkpointer fails silently | `graph.py` lines 665-678: `RedisSaver.from_conn_string()` returns a context manager, but code calls `.setup()` on it directly, causing `AttributeError: '_GeneratorContextManager' object has no attribute 'setup'`. Falls back to `MemorySaver`. | **All session persistence is in-memory** despite Redis being configured. Sessions are lost on pod restart; multi-replica planner instances have **no shared state** for conversation continuity. | Use `RedisSaver.from_conn_string()` as a context manager, or check the `langgraph-checkpoint-redis` version for the non-context-manager API. |
| 10 | **High** | Eval | Retrieval benchmark not in CI | `bench_hybrid.py` exits 1 on regression, but no CI workflow calls it. `baseline.json` not committed. | Retrieval quality regressions from code changes are **never caught before merge**. | Add retrieval regression job to `lint.yml` or a dedicated workflow. Commit a known-good `baseline.json`. |
| 11 | **High** | Eval | No adversarial prompt test suite | `test_injection_scanner.py` tests the scanner module. No E2E adversarial prompts in `test_prompts.yaml`. `safety` category covers content safety (phishing, lock-picking), not prompt injection. | Instruction-override, jailbreak, and prompt-leak attacks are **untested end-to-end**. | Add an `adversarial` category to `test_prompts.yaml` with ~15 payloads (instruction override, DAN, Base64, prompt leak, role hijack). Assert `injection_detected=true` or sanitized behavior. |

### P1: Medium

| # | Severity | Domain | Finding | Evidence | Impact | Remediation |
|---|----------|--------|---------|----------|--------|-------------|
| 12 | Medium | RAG | Planner bootstrap schema is v2 (outdated) | `rag_client.py` `_ensure_synesis_catalog()` (lines 164-222) creates a v2 schema without `sparse_text` or BM25 function. Indexer creates v5 schema. | If planner runs before indexer, it creates an **incompatible collection** that indexer must then drop and recreate. Wastes a full re-index cycle. | Either remove planner-side bootstrap (let indexer own schema creation) or align it with indexer's v5 schema. |
| 13 | Medium | Orchestration | Token estimation uses `len() // 4` | `final_answer_compiler.py` line 329, `writer.py` line 501: `estimated_input_tokens = len(full_input) // 4`. | ~25% error vs actual token counts. Budget clipping and context truncation decisions are **systematically inaccurate**. | Add `estimate_tokens(text, model)` using tiktoken when available, fallback to `len // 4`. |
| 14 | Medium | Orchestration | Critic stop sequence not configured | `config.py` line 313: `critic_stop_sequence: str = ""`. When empty, critic generates full JSON including `nonblocking`, `what_if_analyses`. | Every critic call generates **30-40% more tokens than needed** for the blocking-issues decision. Direct cost and latency impact. | Set `critic_stop_sequence = '],"nonblocking":'` by default. Update critic parsing to handle truncated JSON. |
| 15 | Medium | Orchestration | Background critic lacks metrics | `graph.py` lines 557-578: `_fire_background_critic()` logs results but does not emit Prometheus metrics or persist to feedback store. | No visibility into whether responses **would have been rejected** by inline critic. Cannot tune `critic_skip_below_difficulty` empirically. | Add `synesis_background_critic_approved_total` and `synesis_background_critic_rejected_total` counters. |
| 16 | Medium | Infra | Redis is a single point of failure | `redis/deployment.yaml`: `replicas: 1`, no Sentinel/Cluster. AOF with everysec fsync. | Redis pod crash = **retrieval cache, sessions, and L2 archive all lost**. Recovery requires pod restart and cache warm-up. | Document recovery playbook. For production: deploy Redis Sentinel (3-node) or accept the SPOF with faster PVC restore. |
| 17 | Medium | Infra | Failfast cache on ephemeral /tmp | `failfast_cache.py` line 24: `_DEFAULT_CACHE_DIR = Path("/tmp/synesis-cache")`. Pod with `readOnlyRootFilesystem: true` means `/tmp` is `emptyDir`. | Failfast cache **resets on every pod restart**, defeating cached validation results. | Mount a PVC at `/data/cache` and set `SYNESIS_CACHE_DIR=/data/cache`, or accept ephemeral behavior and document it. |
| 18 | Medium | Infra | Inconsistent HTTP timeouts | `rag_client.py` 30s, `embed_client.py` 60s, `llm_telemetry.py` read 120s, `web_search.py` 5s, `entry_pipeline.py` keyword 5s. | Timeout mismatches cause **unpredictable failure cascades** — slow embedder can block RAG while web search times out fast. | Standardize: connect 5s, read 30s for services, read 120s for LLM, read 5s for web. Document in a central config. |
| 19 | Medium | Infra | Cache metrics not in Prometheus | `retrieval_cache.py` `CacheStats` exists but no `/metrics` export. | Cannot monitor cache hit ratio, key growth, or eviction rate. **Blind to cache effectiveness.** | Add `synesis_cache_exact_hits_total`, `synesis_cache_semantic_hits_total`, `synesis_cache_misses_total` counters. |
| 20 | Medium | Eval | Quality pipeline decoupled from PR merges | `quality-pipeline.yml` only runs on schedule/manual dispatch. No corpus/retrieval checks gate merges. | Retrieval or prompt changes can degrade quality **without any CI signal**. | Add lightweight quality check to PR workflow (e.g. subset of retrieval regression against committed baseline). |

### P2: Low

| # | Severity | Domain | Finding | Evidence | Impact | Remediation |
|---|----------|--------|---------|----------|--------|-------------|
| 21 | Low | Orchestration | `next_node: "worker"` in planner fallback is dead code | `planner_node.py` lines 302-331, 453-470, 471-481: all fallbacks set `next_node: "worker"`. No node named `"worker"` exists; `route_after_planner` ignores this field. | Confusing for debugging; no functional impact. | Remove `"next_node": "worker"` from fallback returns. |
| 22 | Low | Orchestration | Summarizer not deployed | `config.py` lines 56-57: `summarizer_model_url: str = ""`. `history_summarizer.py` checks for URL before calling. | Pivot summarization is disabled; conversation history **not compressed** for long sessions. | Deploy summarizer via LiteLLM (already configured as `synesis-summarizer` → OpenRouter). Set `SYNESIS_SUMMARIZER_MODEL_URL`. |
| 23 | Low | Infra | Semantic index uses SCAN (O(n)) for search | `semantic_index.py` line 206: `scan_iter(match=...)` loads all entries. | Acceptable at current scale (~512 entries). **Will not scale** to thousands of cache entries. | Consider RediSearch vector index if cache grows beyond 1K entries. |
| 24 | Low | RAG | `_rrf_merge` weight not in config | `unified_retrieval.py` line 144: `original_weight=0.3` as default parameter. Caller never overrides. | Cannot tune RAG-vs-web blending without code change. | Add `rag_rrf_original_weight` to config. |
| 25 | Low | Eval | Frame eval snapshots can drift without review | `test_frame_accuracy.py` supports `--frame-update`. Snapshots can be regenerated without explicit approval. | Snapshot changes can **mask regressions** if updated carelessly. | Track snapshot diffs in PRs; require explicit approval for snapshot updates. |

---

## Phase 1: Architecture Findings Report

### A. LLM Orchestration

**Architecture**: LangGraph-based pipeline with 7 node types:
- Entry (classifier + advisor) → Router (query expansion, retrieval, HyDE) → Planner (decomposition) → Executor/Writer (generation) → Critic (quality gate) → Final Answer Compiler → Response

**Strengths:**
- Well-structured role separation with dedicated prompt templates per node
- Anti-oscillation detector prevents infinite critic-refinement loops
- Background critic mode reduces user-facing latency
- Taxonomy-driven prompt injection adds domain expertise without model fine-tuning
- Trust policy and injection scanner provide defense-in-depth
- Citation preservation validation between drafts

**Bottlenecks:**
1. **Router is the heaviest node** — multi-query expansion (3+ LLM calls), HyDE, conceptual expansion, summarization. All share the same model endpoint with planner and advisor. For low-difficulty queries this is overkill.
2. **Critic generates full JSON** when only `blocking_issues` is needed for the routing decision. The `nonblocking` and `what_if_analyses` sections add 30-40% token overhead.
3. **No budget enforcement** on router/planner/writer — only executor and critic decrement `token_budget_remaining`. A complex multi-step request can consume 5-10x more tokens than a simple one with no control.
4. **No fallback models** — a single OpenRouter model outage kills the entire role. LiteLLM supports model lists with fallbacks, but the planner bypasses this by always specifying the exact model name.

**Cost Optimization Opportunities:**
- Skip HyDE and multi-query for `difficulty < 0.3` (trivial path already skips planner)
- Configure `critic_stop_sequence` to truncate after blocking_issues
- Use a cheaper/faster model for router classification vs general reasoning
- Cache planner outputs for similar task structures

### B. Retrieval/RAG

**Architecture**: Milvus hybrid search (HNSW dense + native BM25 sparse) → FlashRank/BGE cross-encoder reranking → authority-weighted scoring → adaptive top-K (CAR-style cliff detection) → cohesion lock → coherence gate → context assembly.

**Strengths:**
- Native Milvus BM25 eliminates custom microservice complexity
- Authority-tiered trust system (canonical > vetted > community > external > web)
- Cohesion lock prevents topic drift across retrieval rounds
- Coherence gate filters off-topic chunks using difficulty-adjusted threshold
- Context prefix enrichment improves dense retrieval recall

**Bugs (must-fix):**
1. **`_get_milvus_client()` undefined** — hybrid and sparse search paths will crash with NameError
2. **`import time` missing** — reranking paths will crash with NameError
3. **BM25 fallback drops domain filter** — cross-domain contamination on fallback

**Design Issues:**
4. **Taxonomy boost broken** — checks `authority` field instead of `domain`; `UnifiedResult` lacks `domain` field entirely
5. **Planner bootstrap creates outdated v2 schema** — races with indexer's v5 schema
6. **Indexer runs sources sequentially** — CPU-bound sources could be parallelized

**Tuning Opportunities:**
- Run `bench_chunking.py` sweep to validate 600-word default (research suggests 200-500 tokens)
- Use FlashRank for `difficulty < 0.3`, BGE only for complex queries
- Expose coherence gate threshold per-domain via taxonomy config

### C. Infrastructure and Caching

**Architecture**: Redis (single instance, 3 DBs) serves retrieval cache (DB 0), session persistence (DB 1), and L2 conversation archive (DB 2). In-process caches for conversation memory, failfast results, and Gliner frames.

**Cache Layer Map:**

| Cache | Backend | Scope | TTL | Max Size | Eviction |
|-------|---------|-------|-----|----------|----------|
| Retrieval (exact+semantic) | Redis DB 0 | Cross-replica | 24h | 512 entries | On `put()`: TTL then LRU |
| Sessions (LangGraph) | **MemorySaver** (Redis broken) | Per-replica | None | Unbounded | None |
| L2 Archive | Redis DB 2 | Cross-replica | 7 days | Unbounded | Redis TTL on write |
| Conversation L1 | In-process | Per-replica | 4h | 5000 users, 20 turns | LRU + TTL on access |
| Failfast | Disk (/tmp) | Per-pod | 24h | 1000 entries | LRU + TTL |
| Gliner | In-process | Per-replica | None | 64 entries | LRU (size only) |
| Semantic Index | Redis hashes | Cross-replica | **None (bug)** | ~512 | On `put()` only |

**Key Risks:**
1. **Redis SPOF** — single replica, no Sentinel. Pod crash loses all caches.
2. **Session persistence broken** — RedisSaver context manager bug means all sessions are in-memory MemorySaver. Pod restart = session loss.
3. **Semantic index key leak** — no Redis EXPIRE; stale keys accumulate between `put()` calls.
4. **Failfast on ephemeral storage** — /tmp resets on pod restart.

**Performance:**
- Semantic cache search uses Redis SCAN + in-process cosine — O(n) but acceptable at 512 entries
- Cache warm-up runs 8 queries at startup with 0.1s sleeps — could be backgrounded
- No Prometheus metrics for cache hit/miss rates — cannot measure effectiveness

### D. Evaluation and Governance

**Architecture**: Offline eval (pytest unit tests + frame eval snapshots), retrieval benchmarks (standalone scripts), corpus audit pipeline (CronJob + admin UI), prompt test suite (manual against live planner), security scanning (CodeQL + Trivy + Bandit + Semgrep + pip-audit).

**Strengths:**
- Comprehensive CI linting (Ruff, ShellCheck, yamllint, Hadolint, Kustomize validation)
- Multi-language security scanning (6 tools)
- Corpus quality feedback loop (audit → curate → ingest → verify)
- Injection scanner with Tier 1 (core) + Tier 2 (web) patterns + output guardrail
- Router governance test enforces retrieval ownership

**Gaps:**
1. **No retrieval regression in CI** — `bench_hybrid.py` is manual, `baseline.json` not committed
2. **No adversarial prompt testing** — injection scanner has unit tests but no E2E adversarial prompts
3. **No citation grounding checks** — trust policy exists but no automated verification that output claims are supported by evidence
4. **Prompt test suite not in CI** — `tests/prompts/` has 30 categories but runs only manually
5. **Quality pipeline decoupled from merges** — corpus audit runs weekly, not on PRs

**Maturity Assessment:**

| Capability | Status | Target |
|------------|--------|--------|
| Unit tests | Strong | Maintain |
| Linting/formatting | Strong | Maintain |
| Security scanning | Strong | Add red-team prompts |
| Retrieval regression | Manual only | CI gate |
| E2E prompt testing | Manual only | CI gate (subset) |
| Adversarial testing | Not present | Add + CI gate |
| Citation grounding | Not present | Add heuristic checks |
| Corpus quality | Automated (weekly) | Add PR-level check |

---

## Phase 2: Prioritized Remediation Roadmap

### P0: Stability and Correctness (Week 1-2)

| Task | File(s) | Acceptance Criteria |
|------|---------|---------------------|
| **P0-1**: Define `_get_milvus_client()` singleton | `base/planner/app/rag_client.py` | Hybrid and sparse search execute without NameError; integration test passes |
| **P0-2**: Add `import time` | `base/planner/app/rag_client.py` | FlashRank and BGE reranking execute without NameError |
| **P0-3**: Add `filter_expr` to `_sparse_search()` | `base/planner/app/rag_client.py` | BM25 fallback respects domain filter; test with domain-scoped query |
| **P0-4**: Add `domain` to `UnifiedResult` and fix `_taxonomy_boost()` | `base/planner/app/unified_retrieval.py` | Taxonomy boost matches on actual domain field; unit test verifies boost |
| **P0-5**: Fix RedisSaver checkpointer | `base/planner/app/graph.py` | Startup logs `redis_checkpointer_ready` (not fallback); sessions persist across pod restarts |
| **P0-6**: Add `expire()` to semantic index `insert()` | `base/planner/app/semantic_index.py` | Redis keys have TTL matching cache TTL; `redis-cli TTL` confirms expiry set |
| **P0-7**: Create model-call wrapper with retry/circuit-breaker | `base/planner/app/model_client.py` (new) | LLM calls retry once on 5xx/timeout; circuit breaker opens after 5 consecutive failures; metrics emitted |

### P1: Cost and Latency (Week 2-4)

| Task | File(s) | Acceptance Criteria |
|------|---------|---------------------|
| **P1-1**: Propagate token budget to all nodes | `nodes/router.py`, `nodes/planner_node.py`, `nodes/writer.py`, `nodes/final_answer_compiler.py` | All LLM-calling nodes decrement `token_budget_remaining`; budget-exhausted requests terminate gracefully |
| **P1-2**: Add tokenizer-aware estimation | `base/planner/app/token_utils.py` (new) | `estimate_tokens(text, model)` uses tiktoken; fallback to `len//4`; writer/compiler use it |
| **P1-3**: Configure critic stop sequence | `base/planner/app/config.py`, `base/planner/deployment.yaml` | Default `critic_stop_sequence` set; critic JSON parsing handles truncation; ~30% token reduction measured |
| **P1-4**: Difficulty-aware router policy | `base/planner/app/nodes/router.py` | `difficulty < 0.3`: skip HyDE and multi-query expansion; `difficulty < 0.5`: limit to 2 expansion queries |
| **P1-5**: Summarizer deployment via LiteLLM | `base/planner/deployment.yaml`, LiteLLM config | `SYNESIS_SUMMARIZER_MODEL_URL` set; pivot summarization active; long sessions compressed |
| **P1-6**: Remove/align planner bootstrap schema | `base/planner/app/rag_client.py` | Remove `_ensure_synesis_catalog()` from planner; indexer owns schema exclusively |

### P2: Cache and Throughput (Week 3-5)

| Task | File(s) | Acceptance Criteria |
|------|---------|---------------------|
| **P2-1**: Add cache Prometheus metrics | `base/planner/app/retrieval_cache.py` | `synesis_cache_exact_hits_total`, `synesis_cache_semantic_hits_total`, `synesis_cache_misses_total` exported at `/metrics` |
| **P2-2**: Add background critic metrics | `base/planner/app/graph.py` | `synesis_background_critic_approved_total`, `synesis_background_critic_rejected_total` counters |
| **P2-3**: Standardize HTTP timeouts | All HTTP clients | Documented timeout policy: connect 5s, read 30s (services), read 120s (LLM), read 5s (web) |
| **P2-4**: Move failfast cache to PVC | `base/planner/app/failfast_cache.py`, `base/planner/deployment.yaml` | `SYNESIS_CACHE_DIR` points to mounted PVC; cache survives pod restarts |
| **P2-5**: Document Redis HA options | `docs/` | Decision document: Sentinel vs accept-SPOF; recovery playbook for Redis pod failure |
| **P2-6**: Parallelize indexer source processing | `base/rag/indexer/app/pipeline.py` | Sources processed with `ThreadPoolExecutor(max_workers=4)`; total indexing time reduced |

### P3: Evaluation and Governance (Week 4-8)

| Task | File(s) | Acceptance Criteria |
|------|---------|---------------------|
| **P3-1**: Commit retrieval baseline | `benchmarks/retrieval/baseline.json` | Known-good baseline committed; `bench_hybrid.py` confirms no regression |
| **P3-2**: Add retrieval regression to CI | `.github/workflows/lint.yml` or new workflow | PR changes to `base/planner/app/rag_client.py` or `unified_retrieval.py` trigger regression check |
| **P3-3**: Add adversarial prompt category | `tests/prompts/test_prompts.yaml` | 15+ payloads: instruction override, DAN, Base64, prompt leak, role hijack. Expected: `injection_detected=true` or sanitized output |
| **P3-4**: Add E2E injection tests | `base/planner/tests/test_injection_e2e.py` (new) | POST adversarial payloads to `/v1/chat/completions`; assert `injection_detected` in response or sanitized content |
| **P3-5**: Add citation grounding heuristic | `tests/prompts/test_prompts.yaml`, `tests/prompts/run_test_suite.py` | "Must-cite" test cases assert citations present; "must-not-hallucinate" cases check for absent fabricated claims |
| **P3-6**: Add subset of prompt suite to CI | `.github/workflows/lint.yml` | `routing` + `reject_terms` + `adversarial` categories run in CI on planner changes |

---

## Measurement Framework

### KPIs to Track

| KPI | Source | Target |
|-----|--------|--------|
| p50 / p95 request latency | `synesis_chat_duration_seconds` | p50 < 30s, p95 < 120s |
| Tokens per request by role | LLM response `usage_metadata` | Decreasing trend after P1 |
| Cost per request | Tokens x OpenRouter pricing | < $0.05 avg for knowledge queries |
| Retrieval hit rate | `bench_hybrid.py` recall@10 | >= 70% |
| Retrieval MRR@10 | `bench_hybrid.py` | >= 0.5 |
| Cache hit ratio | `synesis_cache_*_total` | > 20% after warm-up |
| Semantic index key count | Redis `DBSIZE` / `SCAN count` | Stable within 2x of `max_entries` |
| Circuit breaker opens | `synesis_circuit_breaker_state` | < 1/day |
| Background critic rejection rate | `synesis_background_critic_*_total` | Informational — track trend |
| Injection detection rate | `injection_scanner` logs | Informational — 0 false negatives on adversarial suite |
| Citation grounding pass rate | Prompt test suite | >= 95% on must-cite cases |

### SLOs (Proposed)

| SLO | Target | Alert Condition |
|-----|--------|-----------------|
| Request success rate | >= 99% | Error rate > 1% over 5 min |
| p95 latency | < 120s | p95 > 120s over 5 min |
| RAG availability | Milvus healthy | Health check fails for > 2 min |
| Redis availability | Redis healthy | Health check fails for > 1 min |
| Retrieval quality | recall@10 >= baseline - 5% | CI regression detected |

---

## References and Best Practices

### Architecture Patterns Applied

| Pattern | Implementation | Status |
|---------|---------------|--------|
| **Retrieval-Augmented Generation (RAG)** — Lewis et al., 2020 | Hybrid dense+sparse retrieval with cross-encoder reranking | Implemented |
| **Corrective RAG (CRAG)** — Yan et al., 2024 | Critic node with web-search fallback on low confidence | Implemented (critic + web gating) |
| **Self-RAG** — Asai et al., 2023 | Retrieval critic that decides retrieve/generate/critique | Partially (critic reviews but doesn't control retrieval) |
| **Query2Doc / HyDE** — Gao et al., 2022 | Hypothetical document embedding for query expansion | Implemented (router HyDE path) |
| **Reciprocal Rank Fusion** — Cormack et al., 2009 | Server-side RRF in Milvus for dense+sparse fusion | Implemented |
| **Contextual Retrieval** — Anthropic, 2024 | `context_prefix` prepended to chunks before embedding | Implemented (enrichment pipeline) |
| **Agentic RAG** — LangGraph orchestration | Multi-step planning with evidence gathering loops | Implemented |
| **Faithfulness checking** — Manakul et al., 2023 | Verifying output claims against retrieved evidence | Not implemented (recommended) |
| **LLM-as-Judge** — Zheng et al., 2023 | Using LLMs to evaluate retrieval relevance | Implemented (bench tool, not in CI) |

### Recommendations from Industry

| Practice | Source | Synesis Status |
|----------|--------|---------------|
| Commit retrieval baselines and gate on regression | Anthropic RAG cookbook, LlamaIndex eval docs | Not done — manual only |
| Red-team prompt testing | OWASP LLM Top 10, Anthropic HHH eval | Scanner exists, no E2E suite |
| Token budget enforcement | OpenAI best practices, LangChain docs | Partial — 2/6 nodes only |
| Circuit breaker on external calls | Resilience4j, Polly patterns | Defined but unused |
| Cache hit metrics as SLI | Google SRE handbook | Not exported to Prometheus |
