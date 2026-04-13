# Ingestion Tuning, Verification, and End-to-End UX

This runbook is the practical guide for operating and improving ingestion quality from:

- fetch/normalize/enrich execution,
- to Milvus v9 field quality,
- to planner retrieval behavior and user-facing answer quality.

Use this with [`INDEXERS.md`](INDEXERS.md) (pipeline operations), [`INGESTION_ENRICHMENT.md`](INGESTION_ENRICHMENT.md) (format extraction boundaries), and [`RAG.md`](RAG.md) (retrieval/query path).

## 1) Responsibility split: deterministic vs LLM

The system should keep deterministic work in Python/services and reserve GPU LLM calls for semantic interpretation.

### Deterministic (must stay non-LLM)

- Format parsing: HTML -> Markdown, PDF -> text/tables, structured file normalization.
- Chunk construction: heading-aware/code-aware/table-safe boundaries.
- Boilerplate cleanup, dedup/hash identity, token/byte guards.
- Syntax-aware splitting for code (tree-sitter path).

Current implementation references:

- [`base/rag/indexer/app/extract.py`](../base/rag/indexer/app/extract.py)
- [`base/rag/indexer/app/chunking.py`](../base/rag/indexer/app/chunking.py)
- [`base/rag/indexer/app/handlers/github_code.py`](../base/rag/indexer/app/handlers/github_code.py)
- [`base/rag/indexer/app/handlers/pdf_document.py`](../base/rag/indexer/app/handlers/pdf_document.py)
- [`base/rag/indexer/app/content_gate.py`](../base/rag/indexer/app/content_gate.py)

### LLM (semantic enrichment only)

- Document semantic classification and quality scoring.
- Index/no-index/review decisions.
- Entity and section-outline extraction.
- Optional chunk summaries/contextual prefix enhancement.

Current implementation references:

- [`base/rag/indexer/app/gatekeeper.py`](../base/rag/indexer/app/gatekeeper.py) (structured doc-level JSON)
- [`base/rag/indexer/app/enrichment.py`](../base/rag/indexer/app/enrichment.py) (optional chunk-level text enrichment)
- [`base/rag/indexer/app/pipeline.py`](../base/rag/indexer/app/pipeline.py) (field mapping into Milvus entities)

## 2) Tunables by phase

### Fetch + normalize (staged phases 1/2)

- `SYNESIS_INGESTION_S3_BUCKET` (required for staged)
- `SYNESIS_INGESTION_S3_PREFIX` (optional namespace/prefix)
- `SYNESIS_INDEXER_PREPROCESS_URL` (optional preprocess-service)
- `SYNESIS_INDEXER_PREPROCESS_CLEAN_HTML` (optional jusText clean path)

### Enrich + index (staged phase 3 / direct queue)

- `SYNESIS_INDEXER_GATEKEEPER_ENABLE`
- `SYNESIS_INDEXER_GATEKEEPER_URL`
- `SYNESIS_INDEXER_GATEKEEPER_MODEL`
- `SYNESIS_INDEXER_GATEKEEPER_API_KEY`
- `SYNESIS_INDEXER_GATEKEEPER_TIMEOUT`
- `SYNESIS_INDEXER_GATEKEEPER_SKIP_AUTHORITY`
- `SYNESIS_INDEXER_SPAM_URL` (optional classifier signal)
- `--enrich basic|full` and `--llm-url` for chunk-level Tier 2 enrich

### Retrieval quality sensitivity (planner)

- Metadata filters via `buildMetadataFilter()` in [`base/planner-ts/src/retrieval/metadata-filter.ts`](../base/planner-ts/src/retrieval/metadata-filter.ts) for:
  - `content_type`
  - `index_decision`
  - `content_format`
  - domain and language/artifact signals
- Output field consumption includes v9 semantic fields (`content_type`, `quality_score`, `technical_depth`, `domain_relevance`, `index_decision`, `entities_json`, `enrichment_profile`).

## 3) Verification levels

## 3.1 Phase health checks

### Staged pipeline status checks

1. Ingestion queue status in Admin UI (`staged_raw` -> `staged_norm` -> `indexed`).
2. Enrich queue depth (`enrich_queue_pending`) and document counts.
3. Spot-check one doc per phase:
   - raw object exists in S3,
   - normalized `.md` + `.json` exist,
   - enrich job reaches done and corresponding Milvus rows exist.

## 3.2 Schema and field-population checks

Validate that v9 enrichment fields are materially populated, not just default placeholders.

Checklist:

- `content_type` distribution is non-trivial (not all empty/other).
- `index_decision` includes `index` and optionally `review`/`skip` where expected.
- `quality_score`, `technical_depth`, `domain_relevance` are in valid ranges.
- `entities_json` and `section_boundaries_json` parse as JSON.
- `enrichment_profile` aligns with run mode (`v9_gatekeeper`, `v9_default`, etc.).

## 3.3 Retrieval-fit checks (planner path)

Run targeted prompts and inspect whether enriched metadata improves retrieval selection:

- API-reference query should bias `content_type=reference`-like docs.
- Deep implementation query should return higher technical-depth chunks.
- Noise/junk sample set should show reduced retrieval/citation rates.

Use:

- `GET /api/v1/rag/quality`
- `GET /api/v1/rag/quality/domains`
- `GET /api/v1/rag/review/stats`
- `GET /api/v1/rag/benchmarks` and benchmark history endpoints

(See [`base/admin/app/routers/rag.py`](../base/admin/app/routers/rag.py).)

## 4) End-to-end UX validation

Validate from ingestion to user answer quality, not only ingestion internals.

## 4.1 Golden prompt set

Maintain a small controlled suite:

- focused technical how-to,
- composite multi-domain architecture,
- noisy/marketing-heavy source case,
- code-example vs conceptual-doc case.

For each prompt, record:

- top retrieved sources/chunks,
- citations in final answer,
- whether the answer style/fit matches expected user intent.

## 4.2 Failure taxonomy

When answer quality drops, classify first:

- bad fetch/normalize,
- bad chunk boundaries,
- bad semantic labels,
- bad retrieval/rerank/filtering,
- good retrieval but poor generation/prompt behavior.

This determines whether to rerun a specific ingestion phase, adjust LLM enrichment prompt/thresholds, or tune retrieval/prompting.

## 5) Feedback-loop operations

Use this closed loop:

1. Observe low-fit outputs from user-facing flows.
2. Trace to source chunks and enrichment metadata.
3. Decide action:
   - phase rerun (fetch/normalize/enrich),
   - enrichment prompt/model update,
   - retrieval filter/tunable adjustment.
4. Re-run benchmarks and quality snapshots.
5. Promote only when quality deltas are positive on the golden set.

## 6) Prompt quality guardrails for enrichment

For document-level gatekeeper prompts:

- enforce strict JSON-only output,
- include machine-valid enums/ranges,
- reject malformed outputs with explicit fallback behavior,
- version prompts and store prompt-version markers in `enrichment_profile`.

For chunk-level enrichment:

- keep optional and bounded (token caps, strict timeout),
- avoid replacing deterministic parsing/cleanup logic.

## 7) Suggested rollout discipline for enrichment changes

1. Introduce prompt/model change behind versioned profile.
2. Re-enrich a sampled corpus subset (not full corpus first).
3. Compare:
   - JSON validity rate,
   - field completeness,
   - retrieval-fit metrics,
   - answer-level evaluator results on golden prompts.
4. Promote to bulk runs only if all gates pass.

## 8) Documentation + test deliverables checklist

When changing ingestion/enrichment behavior, update all of:

- [`INDEXERS.md`](INDEXERS.md): operations, envs, run/rollback steps.
- [`INGESTION_ENRICHMENT.md`](INGESTION_ENRICHMENT.md): format and microservice boundaries.
- This file: tunables, verification, and UX impact checks.
- Tests under [`base/rag/indexer/tests`](../base/rag/indexer/tests): deterministic chunk/normalize and enrichment contract checks.
- Admin quality/review dashboards where new signals are surfaced.

If any one of these is missing, treat rollout as incomplete.
