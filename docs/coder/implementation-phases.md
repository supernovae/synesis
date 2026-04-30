# Implementation Phases

## Phase 1: Foundation Alignment — COMPLETE

- Created `docs/coder/` with 13 architecture documents
- Defined capability-first adoption model
- Published migration map from milestone docs

## Phase 2: Ambiguity Governance — COMPLETE

- Finalized known/unknown/know-better contract
- Defined abstain and escalation thresholds
- Added decision policy matrix

## Phase 3: Knowledge and Schema Alignment — COMPLETE (Phase 14)

- v13+ schema extension proposal: finalized and implemented as schema v14
- Cross-component update checklist: documented in `rag-schema-and-knowledge-sources.md`
- RAG/MCP retrieval contracts: updated for first-class column filters

## Phase 4: Corpus and Loader Modernization — COMPLETE

- Implemented dual-track corpus classes (`coder_enriched`, `general`, `hybrid`)
- Standardized corpus annotation template v1 with 10 language bootstrap packs
- Added ingestion guidance and metadata quality gates

## Phase 5: Constitution and Admin Control Plane — COMPLETE

- Implemented constitution schema v1 (GovernanceConstitution, GovernanceClause)
- Implemented admin API v1 and governance UI workflows
- Integrated governance policy engine with Backstage/Developer Hub connectors

## Phase 6: Language Intelligence Packs — COMPLETE

- Prioritized top-10 language packs (TypeScript, Python, Go, Rust, Java, C#, SQL, Bash, Terraform, YAML/K8s)
- Added deterministic parsers, error family classifiers, fix recipes, verification commands
- Conformance metrics and fast-path pattern definitions per language

## Phase 7a: Recall Engine and Confidence-Based Bypass — COMPLETE

- Wired fix recipes into runtime recall resolution
- Implemented confidence-based bypass routing (deterministic vs enriched vs skip)
- Added retrieval confidence scoring to evidence prefetch

## Phase 7b: Verification Loop Activation — COMPLETE

- Wired language pack VerificationCommands into verification plan builder
- Implemented multi-round verification with stall detection
- Added per-language verification statistics

## Phase 8: Evidence-Aware Decision Routing — COMPLETE

- Implemented Decision Policy Matrix as evidence-aware routing layer
- Four-path routing: deterministic / constrained / inference-first / abstain
- Added explore mode and real escalation/de-escalation tracking

## Phase 9: Trace Enrichment and Decision Observability — COMPLETE

- Populated TraceRecord with decision-routing metadata
- Implemented DecisionSnapshot for full decision transparency
- Added session events for decision routing and escalation

## Phase 10: Sensemaking and Exploration Engine — COMPLETE

- Implemented future-backward reasoning and structured exploration plans
- Activated Known/Unknown/KnowBetter framework
- Gap analysis with evidence-aware trigger thresholds

## Phase 11: Reliability Hardening and Production Readiness — COMPLETE

- Connection pool limits, fetch timeouts, event loop monitoring
- Compaction fallback (truncation when LLM compaction fails)
- OTEL Phase 2 spans, expanded telemetry, Redis-backed diagnostic persistence

## Phase 12: Production Parity and Feature Activation — COMPLETE

- Claude OTEL span, MCP tool timeouts, compaction fallback wiring
- Dead config elimination, end-to-end integration tests
- Feature activation playbook (`docs/coder/activation-playbook.md`)

## Phase 13: Evidence Pipeline Activation — COMPLETE

- Knowledge search and evidence prefetch end-to-end activation
- Claude parity for knowledge tools (injection, resolution, streaming suppression)
- Evidence-to-decision chain: prefetch → confidence → EvidenceSignals → orchestrator
- Prefetch retry mechanism with stats tracking

## Phase 14: Schema v14 and Knowledge Pipeline Upgrade — COMPLETE

- Promoted constraint/corpus metadata to first-class NornicDB graph node properties
- Updated full pipeline: indexer → admin → planner → MCP → Yarn
- Equality filters replace tag-packed LIKE queries for efficient retrieval
- Content profile weighting in evidence confidence scoring
- Working frame explore phase wired into orchestrator and sensemaking
- `golden_path_id` linking for Backstage/Developer Hub integration

### Phase 15: Conversation Memory and Long-Term Context — COMPLETE

- SessionStore Redis TTL now configurable via `SYNESIS_YARN_SESSION_TTL_MS` (was hardcoded 4h)
- Durable `yarn_session_continuity` Postgres table for session continuity persistence beyond Redis eviction
- `enqueueContinuityUpsert` wired into `persistSessionAndUsage` for both OpenAI and Claude paths (behind `SYNESIS_YARN_CONVERSATION_MEMORY_ENABLED`)
- Cross-conversation recall: returning users get `<SESSION_RECALL>` block from Postgres on new sessions (behind `SYNESIS_YARN_CROSS_CONVERSATION_RECALL_ENABLED`)
- `loadLatestContinuity` with configurable max age (`SYNESIS_YARN_RECALL_MAX_AGE_MS`, default 7 days)
- `toRecallBlock` distinct from `toSystemBlock` — prior session context vs same-session continuity
- `conversationMemory` stats in telemetry endpoint: upserts, recall loads, hits, misses
- `cross_conversation_recall` session event emitted on recall load
- 19 new tests covering TTL configuration, continuity persistence, recall loading, and formatting

### Phase 16: Sub-Worker Architecture — COMPLETE

- Worker thread pool via `tinypool` for parallel CPU-bound enrichment processing
- `EnrichmentPool` wrapper with configurable pool size, task timeout, and sync fallback
- Worker script offloads stateless operations: JSON compaction, content type detection, log compression, JSON summarization
- `reduceMessagesAsync` fans out tool-message processing to workers via `Promise.all`
- Feature-flagged (`SYNESIS_YARN_WORKER_POOL_ENABLED`, default off) — zero overhead when disabled
- Automatic sync fallback on pool failure or timeout
- Pool lifecycle management: graceful shutdown on SIGTERM
- `workerPool` stats in `/health/telemetry`: completed tasks, failed tasks, sync fallbacks
- 17 new tests covering pool lifecycle, task correctness, sync parity, and reduction async path

### Phase 17: Developer Hub Integration — COMPLETE

- `DevHubConnector` DB model with Alembic migration (`023_devhub_connector`) for connector configuration: base URL, auth (none/bearer/oauth by reference), entity kind filters, sync interval, cached entity snapshot, org scoping
- Full CRUD REST API at `/api/v1/developer-hub/connectors` with audit events on all mutations
- `CatalogClient` async httpx client for the Backstage Catalog REST API: entity listing with kind/namespace filters, get-by-ref, health check, configurable timeout/retries, typed `CatalogEntity`/`EntityMetadata` dataclasses
- `SyncEngine` that pulls Template/Component/API/System entities and maps them to `IngestionSource` + `IngestionItem` records with proper `golden_path_id`, `backstage_entity_ref`, `content_profile`, `constraint_source`, and tags
- Incremental sync via content-hash comparison — only changed entities reset to `pending` for re-indexing
- Governance bridge: Template entities with `synesis.io/governance-constitution` annotations auto-create/update `GovernanceClause` records with provenance tracking
- Cached entity snapshot fallback: when the Backstage API is unreachable, sync falls back to the last-known-good snapshot
- Sync preview (dry-run) endpoint showing create/update/unchanged actions before committing
- Connector health endpoint combining live connectivity probe with sync freshness tracking
- 34 new tests covering CatalogClient parsing, token resolution, health check; SyncEngine content hashing, URI building, tag/metadata mapping; governance annotation detection; API CRUD, validation, and cache endpoints

### Phase 18: Evaluation and Conformance Framework — COMPLETE

- **Trace Decision Analytics**: new `get_decision_analytics()` service function aggregating decision-path distribution, escalation rate, recall routing, and evidence prefetch hit rate from `full_record` JSONB; new `GET /api/v1/traces/analytics` endpoint with `since`/`until`/`org_id` filters and RBAC
- **Conformance Rollups**: `ConformanceRollup` DB model with Alembic migration (`024_conformance_rollups`) storing periodic snapshots of Yarn telemetry metrics per language pack; `conformance_tracker` service with `scrape_yarn_telemetry()` (scrapes `/health/telemetry` with auth), `get_conformance_summary()` (latest per-language with delta vs previous), `get_conformance_history()` (time-series); new `/api/v1/conformance` router with `summary`, `history`, and `scrape` endpoints
- **Admin-to-Yarn auth fix**: telemetry and language-pack proxy endpoints now pass `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` to Yarn
- **Golden-Prompt Eval Harness**: `eval_harness` service with `EvalCase`/`EvalSuite`/`EvalResult` dataclasses, 4 built-in suites (`recall_bypass`, `verification_loop`, `decision_quality`, `latency_budget`) with 14 curated prompt cases; `run_eval_suite()` executes cases against Yarn's `/v1/chat/completions` and checks latency/token/choice expectations; new `/api/v1/evals` router with `GET /suites` and `POST /run` endpoints
- **Testing Labs Execution Engine**: `testing_labs_engine` service with `execute_run()` (extracts prompts from historical traces, replays against Yarn, writes `TestingLabsResult` rows); `detect_regressions()` performs rule-based regression detection (verdict degradation, latency >2x, token >2x, decision path degradation); `RegressionReport` dataclass; new `POST /runs/{run_id}/execute` and `GET /runs/{run_id}/regressions` endpoints wired into existing Testing Labs router
- 27 new tests covering trace analytics, conformance model/service, eval harness suites and expectations, testing labs engine and regression detection, all API endpoints, and migration verification

### Phase 19: Compositional Pattern Library, Layer 2 Completion, and Enrichment Model Config — COMPLETE

- **Indexer + Content Dispatch fixes**: added `pattern`, `conceptual`, `troubleshooting` to indexer `content_profile` allowlist; wired `SYNESIS_YARN_CONTENT_DISPATCH_ENABLED` as a real kill-switch (null-guards `ContentDispatchService` when disabled)
- **Pattern Admin Model**: `PatternEntry` DB model with migration `043_pattern_entries`; full CRUD at `/api/v1/patterns` with bulk-import, stats, sync-to-ingestion, bootstrap loader, and usage feedback endpoints; content-hash-based incremental sync to `IngestionItem` with `corpus_class=coder_enriched`, `content_profile=pattern`
- **Bootstrap Pattern Seeding**: 230 curated patterns across 10 languages (TypeScript, Python, Go, Rust, Java, C#, SQL, Bash, Terraform, YAML/K8s) covering error_handling, api_endpoint, test_scaffold, data_structure, config_pattern, async_pattern, auth_pattern, logging_pattern, validation_pattern, and more
- **Composition Intent Detection**: heuristic detector in `composition-detector.ts` identifies code generation tasks via verb patterns, language inference, and skill family mapping; phase-aware gating; integrated into evidence prefetch pipeline with `SYNESIS_YARN_PATTERN_RECALL_ENABLED` kill-switch
- **Pattern Prefetch**: `runPatternPrefetch()` in `fast-path.ts` queries MCP with `content_profile: "pattern"` filter, formats results as `<synesis_pattern_recall>` blocks injected into system prompt alongside existing evidence blocks
- **Trust/Freshness Scoring**: EMA trust score updated via `POST /api/v1/patterns/{id}/usage` (pass/fail outcomes); `constraint_confidence` propagated during ingestion sync; fire-and-forget Yarn feedback behind `SYNESIS_YARN_PATTERN_USAGE_FEEDBACK_ENABLED`
- **Fix Recipe Expansion**: expanded from 45 to 92 recipes across all 10 language packs, covering the highest-impact error families from `ROOT_CAUSE_TABLES` (e.g., TypeScript 5→12, Python 5→12, Go 5→9, Rust 5→9, Terraform 5→10, Java 5→9, C# 5→9, SQL 4→7, Bash 3→8, YAML/K8s 3→7)
- **Admin-Configurable Enrichment Model**: added `indexer-enrich` to `KNOWN_ROLES` in provider catalog; `SYNESIS_INDEXER_ENRICHMENT_MODEL` and `SYNESIS_INDEXER_ENRICHMENT_TIMEOUT` env vars replace hardcoded `synesis-general`; documented Groq/vLLM/OpenAI configuration with cost estimates in `docs/INDEXERS.md`
- **Eval Harness Decision Path Assertions**: extended `_check_expectations` with soft assertions for `expected_decision_path`, `expected_recall_routing`, and `expected_languages` (warnings, not failures); new `pattern_recall` built-in suite with 6 cases; `CaseResult` extended with `decision_path_match`, `recall_routing_match`, `language_match`, `actual_languages`, and `warnings` fields
- 20 admin tests, 15 Yarn composition detector tests, 45 language pack tests all passing; TypeScript clean build

## Upcoming

### Phase 20: TBD

- Scalability residuals (Redis scaling, PgBouncer, Postgres scaling) — user-driven separate phase
- Model A/B testing
- Tune Tier C `coder-normalizer` model choices by environment (latency/cost/accuracy)
- Expand tool schema pruning heuristics with request/task-aware ranking signals
