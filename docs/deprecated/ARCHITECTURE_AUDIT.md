# Architecture audit — status (living document)

The long-form audit below was written against an **older** tree (line-numbered evidence, P0/P1 tables). **That narrative is removed** to avoid confusion after refactors. This page is the **current** reconciliation: what was fixed, what is intentionally different, and what remains optional or deferred.

The "Verified addressed" section below was written against the **Python planner** (`base/planner/`), which is the legacy/deprecated orchestration runtime. **planner-ts** (`base/planner-ts/`) is now the primary runtime. Where a theme applies only to infrastructure shared by both runtimes (Milvus, indexer, admin, gateway) the distinction does not matter. Where behavior is planner-specific (LLM calls, token budgets, session state, metrics) a separate [planner-ts mapping](#planner-ts-mapping-primary-runtime) section below records the TS equivalent.

**See also:** [SECURITY.md](SECURITY.md), [WORKFLOW_PLANNER.MD](../WORKFLOW_PLANNER.MD), [PROMPT_EPISTEMOLOGY.md](PROMPT_EPISTEMOLOGY.md), [performance.md](performance.md), [ADMIN_QUALITY_UI.md](ADMIN_QUALITY_UI.md), [BUDGET_AND_LIMITS.md](BUDGET_AND_LIMITS.md).

---

## Verified addressed (original audit themes)

| Theme | Notes |
|--------|--------|
| **Milvus hybrid / sparse / pool** | `rag_client.py` defines `_get_milvus_client()`, `_get_milvus_pool()`, `_sparse_search(..., filter_expr=...)`, and hybrid passes `filter_expr`. |
| **Taxonomy / domain boost** | `UnifiedResult` includes `domain`; `_rag_to_unified` populates it; `_taxonomy_boost` matches on `domain`. |
| **`import time` / rerank** | `rag_client.py` imports and uses `time` for rerank paths. |
| **Catalog schema drift** | `_ensure_synesis_catalog` / `_recreate_catalog` target **v10** unified schema with `sparse_text` + BM25 function + semantic metadata fields + **multi-tenant scope** (`visibility_scope`, `org_id`, `tenant_id`). Aligned across indexer `SCHEMA_VERSION`, planner `_EXPECTED_FIELDS`, and admin `EXPECTED_SCHEMA_VERSION`. |
| **Semantic index TTL** | Redis-backed path uses `expire` on insert (`semantic_index.py`). |
| **Session checkpointer** | `graph.py` uses `MemorySaver` at compile time; `upgrade_checkpointer_to_redis()` installs `AsyncRedisSaver` when `session_checkpointer_backend=redis` and URL are set (replaces the old `RedisSaver` context-manager bug class). |
| **Conversation memory** | `RedisConversationMemory` provides Redis-primary storage when `SYNESIS_MEMORY_REDIS_URL` is set; falls back to in-process `ConversationMemory` otherwise. Both implement the same public API (enforced by governance tests). Multi-replica planners require the Redis backend. |
| **Token estimation (writer/compiler)** | `token_utils.estimate_tokens()` (tiktoken when available) is used in `writer.py` and `final_answer_compiler.py`. |
| **Retrieval cache metrics** | `retrieval_cache.py` registers `synesis_cache_*` Prometheus counters. |
| **Background critic metrics** | `graph.py` defines `synesis_background_critic_approved_total` / `rejected_total`. |
| **Adversarial prompt payloads** | `tests/prompts/test_prompts.yaml` includes an **`adversarial`** category (instruction override, encoding tricks, etc.); `run_test_suite.py` knows the category. |
| **Injection defense layers** | See [SECURITY.md](SECURITY.md) — scanner + trust policy + ongoing hardening. |
| **Multi-tenant RAG isolation (C1)** | Three-tier visibility model (global/org/tenant) implemented in Milvus schema v10. `build_scope_filter()` enforces fail-closed retrieval on every search path. Indexer validates scope at upsert. Ingestion DB carries scope on sources/items/documents (Alembic `030`). Yarn escalation forwards `x-synesis-org-id` / `x-synesis-tenant-ids` headers. Integration tests in `test_tenant_isolation.py` + `test_tenant_scope.py`. Benchmarks support `--org-id`/`--tenant-ids`. **Code complete; pending reindex + deploy.** |

---

## planner-ts mapping (primary runtime)

The table above cites Python files. planner-ts reimplements or shares each theme as follows:

| Theme | TS file(s) | Status |
|-------|-----------|--------|
| Milvus hybrid / sparse / filter | `retrieval/rag-client.ts`, `retrieval/unified.ts`, `retrieval/scope-filter.ts` | Aligned — same v10 catalog, HTTP-per-request instead of Python pool |
| Taxonomy / domain boost | `nodes/entry-classifier.ts` (scoring engine), `nodes/router.ts` (cohesion, domain hints) | Different design — behavioral parity, not line-for-line |
| Rerank | `retrieval/rag-client.ts` BGE reranker path | Aligned |
| Catalog schema drift | Reads same v10 schema; field set in `retrieval/rag-client.ts` `OUTPUT_FIELDS` | Infra-only — indexer + admin own the schema |
| Semantic index TTL | N/A — planner-ts does not maintain a local semantic index | Not in TS (not needed) |
| Session / checkpointer | `context/session-store.ts` (`RedisSessionStore`) + `SessionManager` in `app.ts` | Different design — app-layer sessions, no LangGraph checkpointer; same Redis requirement for multi-replica |
| Conversation memory | Same `SessionManager` + `RedisSessionStore` | Aligned operationally; different API |
| Token estimation | No tiktoken; budgets are `max_tokens` ceilings + char context limits (`CONTEXT_MAX_CHARS`) | Different design — see [BUDGET_AND_LIMITS.md](BUDGET_AND_LIMITS.md) |
| Token budget enforcement | `budgets.ts` + `entry-classifier.ts` (scaled per-phase caps clamped by tier) | Different design — caps + scaling vs Python's centralized decrement state machine |
| Retrieval cache metrics | No retrieval-layer Prometheus counters (in-process GLiner cache only) | Not in TS |
| Background critic | `app.ts` `spawnBackgroundCritic()` — structured log + synthetic trace span | Different design — no dedicated `synesis_background_critic_*` counters |
| Prometheus metrics | `@synesis/telemetry` `createServiceMetrics` (`synesis_planner_*` request/token/cost/latency) | Aligned via shared telemetry package |
| Plan gate / grounding | `nodes/plan-gate.ts` + Vitest tests | Aligned |
| Router-governed retrieval | `nodes/router.ts` + `pipeline.ts` — single retrieval entry point | Aligned with workspace `router-governed-evidence` rule |
| Admin quality feedback | `knowledge-backlog.ts` (HTTP gap ingest), `app.ts` (`hallucinated_urls_count`, `context_curation`) | Aligned — see [ADMIN_QUALITY_UI.md](ADMIN_QUALITY_UI.md) |
| Multi-tenant scope | `retrieval/scope-filter.ts` `buildScopeFilter()` | Aligned |
| Adversarial / injection | Shared `@synesis/security` scanner; same runtime trust policy | Infra-only |
| LLM calls | `llm/client.ts` (HTTP fetch to gateway) | Aligned with LiteLLM SSOT policy |

---

## LLM resilience policy (decided)

An earlier revision of this file claimed `model_client.py` wraps all LLM calls. In the **Python planner**, nodes construct `ChatOpenAI` directly; in **planner-ts**, `llm/client.ts` makes HTTP fetch calls to the configured `SYNESIS_PLANNER_TS_LLM_BASE_URL`. Both runtimes point at the LiteLLM gateway for production traffic.

We are standardizing on a **gateway-only** resilience policy:

- LiteLLM is the source of truth for retries, timeouts, and fallback routing — neither planner runtime implements parallel per-node resilience loops.
- Admin observability uses LiteLLM health and failure telemetry for the LLM category instead of planner-local `synesis_llm_*` counters.

`base/planner/app/model_client.py` is retained as legacy helper code for targeted experiments, not as the default production path. planner-ts has no equivalent wrapper — its `llm/client.ts` is intentionally thin, delegating resilience to the gateway.

---

## Open or partial gaps (still relevant)

| Area | Python planner | planner-ts | Options / notes |
|------|---------------|------------|-----------------|
| **Token budget** | **RESOLVED.** Centralized `token_budget_remaining` state machine (`apply_budget_decrement`) with hybrid enforcement, overspend detection, and `synesis_token_budget_*` metrics. | **RESOLVED (different design).** Per-phase scaled `max_tokens` ceilings (`budgets.ts` + entry classifier + tier clamps) with trace metadata. No single decrement counter. See [BUDGET_AND_LIMITS.md](BUDGET_AND_LIMITS.md). | Unify into a shared budget counter only if the product requires cross-phase spend tracking visible to the user. |
| **Critic stop sequence** | `config.critic_stop_sequence` is **empty** — truncation would break `repair_instructions` / `requirement_coverage`. | Same — critic JSON output is not truncated. | Revisit only if critic schema is split or streaming truncation is redesigned. |
| **Retrieval regression CI** | **RESOLVED.** `retrieval-regression.yml` triggers on PRs touching `base/planner/` retrieval paths. | **Gap.** Workflow path filters do not include `base/planner-ts/src/retrieval/**`. | Extend `paths` in `retrieval-regression.yml` or document that the benchmark exercises Milvus regardless of which client is deployed. |
| **Prompt suite in CI** | **RESOLVED.** `prompt-regression.yml` runs router governance + prompt suite on `base/planner/` changes. | **Gap.** Workflow path filters do not include `base/planner-ts/**`. | Add `base/planner-ts/**` paths or a parallel TS-specific CI job. |
| **Summarizer** | **RESOLVED.** `summarizer_model_url` points at `synesis-summarizer` InferenceService; `pivot_summary_enabled=True`. | Router `summarizerOutput` parameter accepted but not wired to a dedicated summarizer call yet. | Wire when needed; current TS pipeline handles evidence without a separate summarizer step. |
| **Planner `next_node`** | Uses `writer` for generation, `planner` on hard error. | Same routing in `graph.ts` conditional edges: `planner`, `writer`, `respond`. | Done in both runtimes. |
| **Fail-fast cache dir** | `/tmp/...` unless `SYNESIS_CACHE_DIR`. | N/A — planner-ts has no local file cache. | No action needed for TS. |
| **Redis HA / timeout matrix** | Operational risk — single replica, uneven timeouts. | Same operational concern — `RedisSessionStore` uses `ioredis` with configurable timeout. | Playbook + central timeout constants when clients are next touched. |
| **Faithfulness / grounding** | **IN PROGRESS.** Five runtime layers: plan-gate phantom URL detection, `publish_knowledge_gap`, critic URL whitelist diff, citation-rate heuristic, final-scrubber pruning. Pytest coverage. `grounding` prompt suite in CI. | **Partial.** Plan gate, hallucinated URL count (`critic_scores.hallucinated_urls_count`), knowledge-gap HTTP ingest (`knowledge-backlog.ts`), `context_curation` on trace. No Python-style pytest grounding suite or `FAILURE_MODE_TAXONOMY`. | Extend Vitest coverage for grounding edge cases; align taxonomy when Python planner is fully retired. |
| **Retrieval cache metrics** | `retrieval_cache.py` registers `synesis_cache_*` counters. | Not in TS (no retrieval-layer Prometheus counters). | Add if retrieval cache hit/miss visibility is needed for TS; currently observable via Milvus-side metrics. |
| **Background critic metrics** | `synesis_background_critic_approved_total` / `rejected_total` in `graph.py`. | Background critic emits structured log + synthetic trace span; no dedicated Prometheus counters. | Add counters if dashboard parity is needed, or rely on trace-based dashboards. |

---

## Original audit artifacts

The detailed severity tables, KPI tables, and phase-2 roadmap lived in git history before this rewrite. If you need the **verbatim** old document for compliance, retrieve it from the commit **before** the cleanup that replaced this file.

---

## Suggested next actions (pick by priority)

1. **Document and verify** LiteLLM resilience settings (`num_retries`, `request_timeout`, fallback lists) for every active served model in admin registry + gateway config. Applies to both runtimes.
2. ~~**Either** enforce token budget in router/planner **or** document intentional omission.~~ **Done (Python).** Budget enforced via `apply_budget_decrement`. **planner-ts** uses per-phase scaled caps — unify only if the product requires a single cross-phase spend counter.
3. ~~**Commit** `benchmarks/retrieval/baseline.json`~~ **Done** — seed baseline committed; first benchmark run overwrites with real values.
4. ~~**Optional:** PR-scoped prompt-suite job for `adversarial` + `routing` categories.~~ **Done (Python).** `prompt-regression.yml` + Admin Testing Labs. **planner-ts gap:** workflow path filters do not include `base/planner-ts/**` — add paths or a parallel TS-specific job.
5. **Extend CI path filters** in `retrieval-regression.yml` and `prompt-regression.yml` to include `base/planner-ts/**` so retrieval and prompt regressions are caught for the primary runtime.
6. **Vitest grounding coverage** for planner-ts: port Python pytest edge cases (URL diff, citation rate, zero-evidence leniency) into Vitest tests under `base/planner-ts/tests/`.

Reduce this file to a short pointer to WORKFLOW + SECURITY once the dual-runtime mapping section is stable and CI covers both runtimes.
