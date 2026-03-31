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

- Promoted constraint/corpus metadata to first-class Milvus columns
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

## Upcoming

### Phase 17: Developer Hub Integration

- First-class Backstage/Developer Hub connector
- Sync golden paths, templates, and organizational standards into the RAG corpus
- Wire `golden_path_id` linking end-to-end

### Phase 18: Evaluation and Conformance Framework

- Automated evals for recall/verification/decision quality
- Conformance metrics per language pack
- Regression detection across model upgrades
