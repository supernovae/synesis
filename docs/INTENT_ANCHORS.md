# Intent anchors (superseded) — ambiguity resolution today

> **This file used to describe a separate "two-tier intent anchor" subsystem** (`SYNESIS_ANCHOR_*`, `intent_anchors` state, Tier 1/Tier 2 resolution). **That design is not in the planner anymore.**
> **Do not use this page for env vars or state fields** — they do not exist in current code.

## Where ambiguity is handled now

Synesis resolves "what kind of task is this?" **through frame extraction and sensemaking**, not through a standalone anchor resolver. This behavior is implemented in **planner-ts**.

### planner-ts (current runtime)

| Step | Module | Key function / type |
|------|--------|-------------------|
| 1. Entry classification | `src/nodes/entry-classifier.ts` | `classifyEntry()` — YAML-driven `ScoringEngine` (BM25 intent, split-axis complexity/risk/domain) |
| 2. Scoring engine | `src/nodes/scoring-engine.ts` | `ScoringEngine.analyze()` — embedded weights from `intent_weights.yaml`, brevity adjustments, deliverable counting |
| 3. Domain profile | `src/nodes/domain-profile.ts` | `buildDomainProfile()` → `DomainProfile` with `frameCoherence` ("focused" / "composite" / "diffuse") |
| 4. Frame extraction | `src/nodes/frame-extractor.ts` | `frameExtractorNode()` — parallel LLM segmentation + GLiNER NER enrichment → `TaskFrame` on `GraphState.task_frame` |
| 5. GLiNER client | `src/nodes/gliner-client.ts` | `extractGliner()` — HTTP to GLiNER microservice `/extract` |
| 6. Cynefin classification | `src/nodes/entry-classifier.ts` | `classifyCynefin()` — maps difficulty × frame coherence → clear/complicated/complex/chaotic |
| 7. Unified retrieval | `src/retrieval/unified.ts` | `retrieveUnified()` — parallel RAG + web, RRF merge, adaptive top-k, domain boosts, cohesion pipeline |
| 8. Cohesion lock | `src/retrieval/cohesion.ts` | `detectCohesionLock()`, `cohesionFilter()`, `compressToCohesion()` — conflict groups from `cohesion_groups.yaml` |
| 9. Router (evidence) | `src/nodes/router.ts` | `runRouter()` — parallel evidence dispatch, preseeded cohesion lock for focused frames, `topic_frame` + `domainHints` injection |
| 10. Clarification | `src/nodes/llm-planner.ts` | `shouldClarify()` — diffuse-frame or low-confidence probe |

| Step | Module | Key function / type |
|------|--------|-------------------|
| 1. Frame extraction | `app/nodes/frame_extractor.py` | `frame_extractor_node()` — LLM segment + GLiNER, `link_units_to_frame()` |
| 2. Domain profile | `app/nodes/frame_extractor.py` | `_build_domain_profile()` → `DomainProfile` in `schemas.py` |
| 3. Entry classification | `app/entry_classifier_engine.py` | `ScoringEngine.analyze()` — YAML-driven, BM25 intent |
| 4. Unified retrieval | `app/unified_retrieval.py` | `retrieve_unified()` — parallel RAG + web, RRF, cohesion |
| 5. Cohesion | `app/cohesion.py` | `detect_cohesion_lock()`, `cohesion_filter()`, `compress_to_cohesion()` |
| 6. Router | `app/nodes/router.py` | `RouterNode` — query variants, `_preseeded_lock`, `_topic_frame` |

## Key concepts

1. **Frame extraction** builds a structured view of the prompt: goals, tasks, constraints, technologies, domain tags, requested format, and a `topic_frame` string for retrieval.

2. **Domain profile** treats the prompt as a **weighted mixture of domains** (topic-mixture model), not a single forced label.

3. **Frame coherence** is classified as:
   - **Focused** — one domain clearly dominates; safe to bias retrieval and **pre-seed a cohesion lock** from YAML conflict groups.
   - **Composite** — multiple domains matter; retrieval **diversifies** across hints; **no** hard lock.
   - **Diffuse** — frame is unclear (**Cynefin complex/chaotic**); the pipeline **probes the user** with a guided clarification instead of assuming.

4. **Topic frame** guides **what** to search for (deliverables / intent), while technologies constrain the answer.

5. **Cohesion lock** — For focused frames, the router builds a `preseededLock` from the dominant domain using conflict groups (`cohesion_groups.yaml`). This filters retrieved documents for inter-document coherence before summarization.

6. **Clarification** — When the frame is diffuse or confidence is low, the planner asks the user using partial understanding (joint cognitive system pattern).

## Canonical documentation

| Topic | Document |
|-------|----------|
| Research ↔ code mapping (Klein, Cynefin, JCS, LDA) | [SYSTEMS_THEORY.md](SYSTEMS_THEORY.md) |
| Design narrative (complexity, sensemaking, Safety-II) | [DESIGN_THEORY.md](DESIGN_THEORY.md) |
| End-to-end pipeline, cohesion lock, query normalization | [WORKFLOW_PLANNER.MD](WORKFLOW_PLANNER.MD) |
| Planner ↔ TS parity tracker | [PLANNER_PYTHON_TS_FEATURE_GAP_TRACKER.md](PLANNER_PYTHON_TS_FEATURE_GAP_TRACKER.md) |

## Historical note

The old "intent anchors" doc listed papers and `SYNESIS_ANCHOR_STRATEGY` as if they were live configuration. The **ideas** (resolve ambiguity early, avoid mixed-evidence thrash, ask when truly conflicted) are preserved in the **sensemaking** design; the **implementation** is **domain profile + diffuse probe + focused preseed**, not a separate anchor node.
