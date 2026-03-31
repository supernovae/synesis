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

## Upcoming

### Phase 15: Conversation Memory and Long-Term Context

- Extend session continuity beyond the 4h Redis TTL with a durable store
- Cross-conversation recall for returning users

### Phase 16: Sub-Worker Architecture

- Node.js worker threads for CPU-bound operations (language pack parsing, compaction, evidence scoring)
- Keep main event loop responsive under load

### Phase 17: Developer Hub Integration

- First-class Backstage/Developer Hub connector
- Sync golden paths, templates, and organizational standards into the RAG corpus
- Wire `golden_path_id` linking end-to-end

### Phase 18: Evaluation and Conformance Framework

- Automated evals for recall/verification/decision quality
- Conformance metrics per language pack
- Regression detection across model upgrades
