# RAG Schema and Knowledge Sources

## Purpose

Define how coder/planner knowledge is represented, enriched, and consumed across indexer, admin, planner, MCP, and Yarn.

## Current Baseline

- Milvus catalog schema version is currently defined in [`base/rag/indexer/app/schema.py`](../../base/rag/indexer/app/schema.py).
- Admin mirror schema is in [`base/admin/app/services/milvus_service.py`](../../base/admin/app/services/milvus_service.py).
- Schema-sync behavior and ingestion lifecycle are documented in [`docs/INDEXERS.md`](../INDEXERS.md).

## Schema v14 — Constraint-Aware Retrieval

Implemented in Phase 14. Promotes metadata previously packed into the 512-byte `tags` VARCHAR column to first-class Milvus columns with efficient equality/scalar-index filtering.

### New First-Class Columns

| Column | Type | Description |
|---|---|---|
| `corpus_class` | VARCHAR(32) | `coder_enriched`, `general`, `hybrid` |
| `constraint_kind` | VARCHAR(16) | `hard`, `guiding`, `advisory` |
| `content_profile` | VARCHAR(32) | `reference`, `procedural`, `tutorial`, `api_spec`, `architecture`, `policy`, `code`, `docs`, `mixed` |
| `scope_tags` | VARCHAR(256) | Comma-separated purpose tags (e.g. `error-catalog,linter-rules`) |
| `constraint_source` | VARCHAR(64) | Origin of constraint classification (e.g. `typescript-spec`, `eslint`, `ruff`) |
| `constraint_confidence` | FLOAT | 0.0–1.0 enrichment-time confidence in the constraint classification |
| `golden_path_id` | VARCHAR(128) | Links to Backstage/Developer Hub golden path template |
| `novel_pattern` | BOOL | Whether this content represents an experimental approach |
| `novel_trace_level` | VARCHAR(16) | `none`, `basic`, `enhanced` — tracing guidance for novel patterns |

### Why v14

- **Efficient filtering**: Milvus scalar indexes on `corpus_class`, `constraint_kind` instead of `LIKE "%ck:hard%"` on `tags`
- **Richer constraint metadata**: `constraint_source` and `constraint_confidence` enable the decision matrix to reason about evidence quality directly
- **Golden path linking**: Connects corpus chunks to organizational best practices from Developer Hub/Backstage
- **Novel pattern tracking**: Distinguishes proven patterns from experimental approaches, feeding sensemaking
- **Content profile on results**: Yarn can distinguish `reference` from `procedural` from `tutorial` evidence, improving confidence scoring

### Backward Compatibility

- The `tags` column is still written (tag-packed metadata alongside new columns) during the transition period
- `extractTagMetadata()` in planner-ts remains as a fallback parser for pre-v14 data
- After a full re-index, tag-packed metadata is vestigial but harmless
- Existing v13 data in `tags` remains readable — columns just default to empty/zero

### Previous Extension Candidates (v13+ doc → resolved)

The following candidates from the original v13+ proposal were resolved in v14:

| Proposed | Resolution |
|---|---|
| `constraint_domain` | Covered by `scope_tags` + `constraint_source` |
| `constraint_kind` | Promoted to first-class column |
| `constraint_source` | Promoted to first-class column |
| `constraint_confidence` | Promoted to first-class column |
| `constraint_fix_class` | Handled by language pack `FixRecipe` system (runtime, not schema) |
| `constraint_applicability` | Covered by `content_profile` + `scope_tags` |
| `golden_path_id` | Promoted to first-class column |
| `validation_recipe_id` | Handled by language pack `VerificationCommand` system (runtime, not schema) |
| `novel_pattern` | Promoted to first-class column |
| `novel_trace_level` | Promoted to first-class column |

## Cross-Component Update Checklist

Any schema extension must update:

1. **Indexer** — `schema.py` (fields, entity builder), `pipeline.py` (column writes)
2. **Admin** — `milvus_service.py` (mirror schema for recreate)
3. **Planner-TS** — `rag-client.ts` (OUTPUT_FIELDS), `metadata-filter.ts` (filter builder), `types.ts` (KnowledgeResult/RagResult)
4. **MCP-TS** — `knowledge-search.ts` (tool schemas, pass-through params)
5. **Yarn-TS** — `knowledge-search.ts` (KnowledgeSearchResult), `fast-path.ts` (confidence scoring)
6. **Documentation** — this file, `implementation-phases.md`
7. **Backfill** — re-index existing corpus to populate new columns

## Schema v16 — Managed Doc Packs

Schema v16 adds model-aware SynPack support and moves the Milvus partition key
from `authority` to `pack_id`. Existing/global ingestion writes `pack_id="global"`;
managed language/framework packs write stable ids such as `go-latest` or
`rust-1.90`.

New columns: `pack_id`, `pack_version`, `pack_source_version`,
`pack_artifact_hash`, `pack_partition`, `symbol_kind`, `symbol_fqn`,
`package_name`, and `doc_relation_ids`. Dense embeddings are now 1024-dimensional
`BAAI/bge-m3` vectors.

## Schema v17 — Agentic SynPack Enrichment

Schema v17 adds universal agent-facing enrichment fields for managed packs:
`agent_hook`, `perf_tier`, `safety_contract`, `lifecycle_model`, and
`agent_enrichment_json`. Language-specific details remain in the JSON payload;
the Go pack stores memory semantics, concurrency contracts, idiomatic version
scope, zero-value behavior, related interfaces, and hidden warnings there.

## Knowledge Source Model

- **Backstage/Developer Hub**: first-class source for templates, pipelines, and platform standards. Linked via `golden_path_id`.
- **Curated technical docs**: language/framework/tooling references for coder reliability. Identified by `content_profile` (reference, api_spec) and `constraint_source`.
- **General corpus**: non-coding domain context for product/domain reasoning. Identified by `corpus_class: general`.
- **Internal governance artifacts**: constitutions, ADRs, runbooks, quality bars. Identified by `content_profile: policy` and `constraint_kind: hard/guiding`.

All sources require provenance, authority classification, and freshness handling.

## Pipeline Flow (v14)

```
Corpus YAML → Indexer pipeline.py
  ├─ Reads corpus_class, constraint_kind, content_profile, scope_tags from source_config
  ├─ Reads constraint_source, golden_path_id, novel_pattern, novel_trace_level
  ├─ Validates whitelist (corpus_class: coder_enriched/general/hybrid, etc.)
  ├─ Falls back to synesis_meta for missing fields
  ├─ Writes new columns directly via catalog_entity()
  └─ Writes tag-packed duplicates for backward compat

Planner-TS → Milvus query
  ├─ buildMetadataFilter() uses equality on new columns
  ├─ OUTPUT_FIELDS includes all v14 columns
  ├─ toRagResult() maps raw rows to RagResult with new fields
  └─ KnowledgeResult maps first-class columns (falls back to extractTagMetadata for pre-v14)

MCP-TS → Planner API
  ├─ Tool schemas expose content_profile, constraint_source, golden_path_id
  └─ buildSearchBody() passes new params through

Yarn-TS → evidence scoring
  ├─ KnowledgeSearchResult includes content_profile, constraint_source, etc.
  ├─ computeEvidenceConfidence() weights reference/api_spec profiles higher
  └─ formatEvidenceBlock() includes profile tag in output
```

## Backfill and Migration

**Existing v13 data**: Columns default to empty string / -1.0 / false. The `tags` column remains readable and `extractTagMetadata()` parses it as a fallback.

**Migration path**:
1. Deploy v14 schema (automatic: indexer's `ensure_synesis_catalog` detects field drift, drops and recreates)
2. Re-index all corpus sources — new columns populated on insert
3. After full re-index, tag-packed metadata is vestigial

**No manual migration required** — the schema auto-migrates on indexer startup. Data re-index populates the new columns.
