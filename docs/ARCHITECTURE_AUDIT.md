# Architecture audit — status (living document)

The long-form audit below was written against an **older** tree (line-numbered evidence, P0/P1 tables). **That narrative is removed** to avoid confusion after refactors. This page is the **current** reconciliation: what was fixed, what is intentionally different, and what remains optional or deferred.

**See also:** [SECURITY.md](SECURITY.md), [WORKFLOW.md](WORKFLOW.md), [PROMPT_EPISTEMOLOGY.md](PROMPT_EPISTEMOLOGY.md), [performance.md](performance.md).

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

## LLM resilience policy (decided)

The previous header of this file said `model_client.py` wraps all LLM calls. That is not true in current planner code: nodes construct `ChatOpenAI` directly.

We are standardizing on a gateway-only policy:

- LiteLLM is the source of truth for retries/timeouts/fallback routing.
- Planner remains focused on orchestration and does not implement parallel per-node resilience loops.
- Admin observability uses LiteLLM health and failure telemetry for the LLM category instead of planner-local `synesis_llm_*` counters.

`base/planner/app/model_client.py` is retained as legacy helper code for targeted experiments, not as the default production path.

---

## Open or partial gaps (still relevant)

| Area | Situation | Options |
|------|-----------|---------|
| **Token budget** | **RESOLVED.** `token_budget_remaining` is now enforced across all core LLM nodes (router, planner, writer, critic, compiler) and the direct-stream path. Budget accounting uses a centralized state machine (`token_utils.apply_budget_decrement`) with hybrid enforcement (degrade at warning threshold, hard-stop at zero), overspend anomaly detection, and Prometheus metrics (`synesis_token_budget_*`). Config SSOT is `settings.effective_token_budget`. | Governance tests in `test_token_budget.py` ensure all core nodes import budget accounting helpers and return `token_budget_remaining`. |
| **Critic stop sequence** | `config.critic_stop_sequence` is **empty** with an explicit comment that truncation would break `repair_instructions` / `requirement_coverage`. | Keep as-is; revisit only if critic JSON schema is split or streaming truncation is redesigned. |
| **Retrieval regression CI** | **RESOLVED.** `retrieval-regression.yml` now triggers on PRs touching retrieval paths. Seed `benchmarks/retrieval/baseline.json` committed. Self-hosted runner in `validation` environment. | First real run against populated Milvus overwrites seed baseline. |
| **Prompt suite in CI** | **RESOLVED.** `prompt-regression.yml` runs router governance + prompt suite (adversarial, retrieval_quality, node_routing) on planner changes. Admin Testing Labs for customer replay/comparison. | See `docs/TESTING.md` §9 for full workflow reference. |
| **Summarizer** | `summarizer_model_url` defaults empty — pivot summarization **off** until deployed. | Set `SYNESIS_SUMMARIZER_MODEL_URL` per [model alignment](../.cursor/rules/model-alignment.mdc) / LiteLLM. |
| **Planner `next_node`** | Was `"worker"` (removed graph node); planner now uses **`writer`** when a plan continues to generation, **`planner`** on hard error with empty plan (retry via plan_gate). | Done in code; keep naming aligned with `route_after_router` allowlist (`planner` \| `writer` \| `respond`). |
| **Fail-fast cache dir** | Default remains `/tmp/...` unless `SYNESIS_CACHE_DIR` is set. | Mount PVC + env in deployment if cross-restart cache matters. |
| **Redis HA / timeout matrix** | Single-replica Redis and uneven HTTP timeouts across clients were called out as **operational** risks, not code bugs. | Playbook + central timeout constants when you next touch clients. |
| **Faithfulness / grounding automation** | Critic has **deterministic URL** checks, **knowledge_gap** publishing, and LLM rubrics; no dedicated “must-cite” CI gate in pytest. | Extend prompt suite or add golden tests if you want merge-time enforcement. |

---

## Original audit artifacts

The detailed severity tables, KPI tables, and phase-2 roadmap lived in git history before this rewrite. If you need the **verbatim** old document for compliance, retrieve it from the commit **before** the cleanup that replaced this file.

---

## Suggested next actions (pick by priority)

1. **Document and verify** LiteLLM resilience settings (`num_retries`, `request_timeout`, fallback lists) for every active served model in admin registry + gateway config.  
2. ~~**Either** enforce token budget in router/planner **or** document intentional omission.~~ **Done** — budget enforced in all core nodes with hybrid policy.  
3. ~~**Commit** `benchmarks/retrieval/baseline.json`~~ **Done** — seed baseline committed; first benchmark run overwrites with real values.
4. ~~**Optional:** PR-scoped prompt-suite job for `adversarial` + `routing` categories.~~ **Done** — `prompt-regression.yml` + Admin Testing Labs.

When the open list is empty or moved to GitHub Issues, this file can be reduced to a short pointer to WORKFLOW + SECURITY only, or deleted.
