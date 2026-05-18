# RAG Schema and Knowledge Sources

## Purpose

This document is the coder-facing reference for how Synesis knowledge is built,
stored, searched, and exposed to agents. It covers the current NornicDB content
graph, SynPack v2 bundles, language packs, and planner/Yarn/MCP search paths.

## Current Baseline

- Canonical graph schema: [`base/rag/indexer/app/schema.py`](../../base/rag/indexer/app/schema.py)
- Graph writer and indexes: [`base/rag/indexer/app/nornic_writer.py`](../../base/rag/indexer/app/nornic_writer.py)
- SynPack v2 builder/import contract: [`base/rag/indexer/app/synpack.py`](../../base/rag/indexer/app/synpack.py)
- Language-pack builder: [`base/rag/indexer/app/language_pack.py`](../../base/rag/indexer/app/language_pack.py)
- Planner retrieval client: [`base/planner-ts/src/retrieval/rag-client.ts`](../../base/planner-ts/src/retrieval/rag-client.ts)
- Planner knowledge routes: [`base/planner-ts/src/app.ts`](../../base/planner-ts/src/app.ts)
- MCP/Yarn search tool schemas: [`packages/synesis-mcp-tools/src/knowledge-schemas.ts`](../../packages/synesis-mcp-tools/src/knowledge-schemas.ts), [`base/yarn-ts/src/state/knowledge-search.ts`](../../base/yarn-ts/src/state/knowledge-search.ts)

Current content graph schema version: **v20**.

## Schema v20

Schema v20 stores all searchable knowledge as `ContentNode` graph nodes in
NornicDB. Dense embeddings are still attached to searchable nodes, but retrieval
also depends on typed node properties and deterministic graph relationships.

Core constants:

| Item | Current value |
|---|---|
| Catalog graph | `content_graph` |
| Embedding model | `BAAI/bge-m3` |
| Embedding dimension | `1024` |
| Embedding profile | `bge-m3-1024-cosine-v1` |
| Vector index | `embeddings` |

Primary node labels:

| Label | Purpose |
|---|---|
| `ContentNode` | Shared indexed base label for all retrieval-visible nodes |
| `Pack`, `Source`, `Version` | Pack identity, provenance, and versioning anchors |
| `Document`, `File`, `Module`, `Chunk` | Source hierarchy and chunk-level evidence |
| `Symbol`, `Function`, `Class`, `Method`, `Resource` | Code/API reference anchors |
| `Concept`, `Pattern`, `Constraint`, `Example`, `ContextCard` | Agent-ready enriched retrieval artifacts |
| `ExternalRef` | Unresolved import/call/reference target preserved as graph evidence |
| `EvalCase` | Retrieval eval/training case nodes |

Graph edge types:

| Edge | Meaning |
|---|---|
| `CONTAINS` | Pack/source/document/module/file containment |
| `DEFINES` | Chunk or file defines a symbol/API |
| `CALLS`, `IMPORTS`, `REFERENCES` | Deterministic code and documentation references |
| `OVERRIDES`, `IMPLEMENTS` | Language/framework relationship edges when extractable |
| `DOCUMENTS` | Documentation node explains an API/resource |
| `HAS_CONSTRAINT`, `HAS_EXAMPLE`, `HAS_PATTERN`, `HAS_CONTEXT_CARD` | Enrichment artifacts attached to source evidence |
| `APPLIES_TO`, `WARNS_ABOUT`, `RELATED_TO` | Agent-useful semantic relationships |
| `DEPRECATED_BY`, `REPLACED_BY` | Deprecation and migration guidance |
| `VALID_IN`, `DERIVED_FROM` | Version/provenance relationships |

## Retrieval-Visible Fields

Every graph node may carry the base `ContentNode` fields. Important current
field groups:

| Group | Fields |
|---|---|
| Identity | `id`, `chunk_id`, `doc_id`, `kind`, `name`, `document_name`, `path` |
| Text | `text`, `content`, `context_prefix`, `chunk_summary`, `heading_path`, `section` |
| Pack/version | `pack`, `pack_id`, `pack_version`, `pack_partition`, `pack_source_version`, `source_version`, `source_release`, `upstream_commit`, `upstream_tag`, `pack_artifact_hash` |
| Code/API | `language`, `package_name`, `symbol_kind`, `symbol_type`, `symbol_fqn`, `symbol_name`, `module_path`, `repo_path`, `import_refs`, `call_refs`, `has_code`, `code_language`, `code_density`, `code_signal_count` |
| Retrieval text | `retrieval_terms`, `query_aliases`, `task_intents`, `tags`, `keywords`, `scope_tags` |
| Agent guidance | `agent_hook`, `perf_tier`, `safety_contract`, `lifecycle_model`, `agent_enrichment_json` |
| Quality | `quality_score`, `technical_depth`, `domain_relevance`, `index_decision`, `spam_score`, `trust_score`, `freshness_score` |
| Freshness/provenance | `source_type`, `handler`, `source_url`, `url`, `crawl_timestamp`, `effective_at_epoch`, `raw_content_hash`, `clean_content_hash`, `enrichment_profile` |
| Constraints | `corpus_class`, `constraint_kind`, `content_profile`, `constraint_source`, `constraint_confidence`, `golden_path_id`, `novel_pattern`, `novel_trace_level` |
| Deprecation | `deprecated`, `deprecation_status`, `replacement_api` |
| Security/review | `scan_status`, `scan_signals`, `approval_status`, `review_trace_id` |
| Scope/authz | `visibility_scope`, `org_id`, `tenant_id`, `owner_user_id`, `conversation_id`, `is_ephemeral`, `expires_at_epoch`, `acl_mode`, `acl_groups`, `acl_group_ids`, `authz_object_id` |

The writer creates indexes for high-value filters such as `pack`,
`source_version`, `kind`, `domain`, `content_type`, `language`, `package_name`,
`symbol_fqn`, `artifact_kind`, `deprecated`, `path`, visibility scope, and
`authz_object_id`, plus the `embeddings` vector index.

## SynPack v2

SynPack v2 is the managed content-pack format used for portable language and
domain packs. A `.synpack` archive is a ZIP file with a `manifest.json`, chunk
rows, typed graph nodes, grouped edge files, enrichment rows, quality report,
and vector sidecars.

Required/important payloads:

| Path | Purpose |
|---|---|
| `manifest.json` | Pack identity, model/dimension/schema requirements, source version |
| `nodes/chunks.jsonl` | Searchable chunk rows; required for v2 validation |
| `nodes/documents.jsonl`, `nodes/packages.jsonl`, `nodes/modules.jsonl`, `nodes/symbols.jsonl` | Structural graph nodes |
| `nodes/concepts.jsonl`, `nodes/patterns.jsonl`, `nodes/constraints.jsonl`, `nodes/examples.jsonl`, `nodes/context_cards.jsonl`, `nodes/external_refs.jsonl`, `nodes/eval_cases.jsonl` | Enrichment and retrieval support nodes |
| `nodes/resource_kinds.jsonl`, `nodes/api_group_versions.jsonl`, `nodes/schema_properties.jsonl`, `nodes/platform_constraints.jsonl`, `nodes/platform_commands.jsonl`, `nodes/validation_recipes.jsonl`, `nodes/risk_patterns.jsonl` | Platform-pack graph nodes for Kubernetes/OpenShift/API/tooling packs |
| `edges/*.jsonl` | Grouped graph relationships by edge type |
| `enrichment/enrichment.jsonl` | Raw enrichment payloads keyed by chunk/symbol |
| `quality/report.json` | Node/edge counts, enrichment coverage, graph resolution, dangling refs |
| `vectors/index.json`, `vectors/chunks.f32` | Float32 BGE-M3 vector sidecar for chunks |

Validation rejects packs whose embedding model, dimensions, or required schema
version are incompatible with the runtime. Current runtime accepts packs with
schema requirements up to v20, model `BAAI/bge-m3`, and dimension `1024`.

Large hosted packs are installed through Admin content-pack jobs and the
Helm-managed `synesis-indexer-content-packs` runner. Packs marked
`requires_bulk_import: true` should use the bulk path rather than the slow
row-by-row Bolt importer.

## Language Packs

Language packs are curated SynPack v2 builds. Current pack configs live under
[`base/rag/pack-configs`](../../base/rag/pack-configs) and cover Go, Rust,
Python, Quarkus, Godot, Terraform/OpenTofu, and Ecma/JS/TS.

The language-pack builder:

- Resolves stable upstream source versions where supported.
- Normalizes docs/code into `LanguageChunk` rows.
- Extracts symbols, package/module paths, import refs, call refs, and code
  density signals when possible.
- Applies content quality gates before enrichment.
- Runs source-grounded enrichment prompts that populate `agent_hook`,
  `query_aliases`, `task_intents`, `verification_hints`, `anti_patterns`,
  `canonical_examples`, `related_symbols`, and other agent-facing fields.
- Materializes typed SynPack v2 nodes and edges so search can retrieve context
  cards, examples, constraints, patterns, and symbols directly.

Common `artifact_kind` values include `code`, `docs`, `repo_map`,
`compiler_error`, `language_spec`, `unsafe_guidance`, `async_guidance`,
`config_reference`, `cli_command`, `pep`, `packaging_spec`, `tool_docs`,
`type_stub`, `class_reference`, `engine_manual`, `engine_proposal`,
`shader_language`, `provider_docs`, `provider_schema`, `terraform_guide`,
`opentofu_feature`, `iac_policy_rule`, `terraform_plan`, `live_state`,
`ecma_spec`, `tc39_proposal`, `temporal_api`, `typescript_handbook`,
`runtime_api`, `web_api`, `runtime_config`, and `package_policy`.

## Platform Packs

Platform packs are curated SynPack v2 builds for operational platforms such as
OpenShift, Kubernetes, GitOps, observability, and DevOps tooling. They are built
with `base/rag/indexer/app/platform_pack.py` and configured under
`base/rag/pack-configs/platform/`.

The first rich pack is OpenShift with Kubernetes as a base layer. It parses
OpenAPI/CRD-style schemas structurally, then materializes resource kinds, API
group/versions, schema properties, constraints, commands, validation recipes,
and risk patterns. This lets retrieval answer platform searches such as
`OpenShift route TLS passthrough`, `deployment selector immutable`, or
`service account can-i create pods` with exact API kinds, fields, commands,
examples, and risk constraints instead of plain markdown chunks.

## Search Behavior

Planner knowledge search is graph-native with three public modes:

| Endpoint/mode | Use |
|---|---|
| `POST /v1/knowledge/search` | General source evidence. With `mode=bundle` or `mode=cards`, delegates to bundle retrieval. |
| `POST /v1/knowledge/bundle` | Answer-ready bundle: context cards, examples, anti-patterns, source chunks, related symbols, quality, freshness warnings. |
| `POST /v1/knowledge/resolve-pack` | Resolve candidate packs before deep retrieval by language/domain/package/symbol/version. |

The default source search path:

1. Embed the query with TEI/BGE-M3 when the embedder is configured.
2. Query NornicDB vector index `embeddings` for `ContentNode` seeds.
3. Apply metadata, temporal, visibility, and ACL predicates in Cypher.
4. Optionally expand graph neighbors up to `graph_depth <= 3` over allowed edge
   types. Neighbor nodes receive the same auth predicate.
5. Map graph rows into `RagResult` / `KnowledgeResult`.
6. Apply authority boosts (`canonical`, `vetted`, `community`, `external`).
7. Apply OpenFGA `can_read` checks in `SYNESIS_RAG_AUTHZ_MODE=enforce` for
   non-global or restricted/private rows.

Bundle retrieval adds a pack-aware layer:

1. Resolve likely packs using text predicates over pack id, name, domain,
   content type, language, package, symbol, `retrieval_terms`, `query_aliases`,
   and `task_intents`.
2. Run source search scoped to the selected pack/version/metadata.
3. Query typed nodes directly for `ContextCard`, `Example`, `Pattern`,
   `Constraint`, `Symbol`, and `Concept`.
4. Return cards/examples/warnings/source chunks/related symbols plus quality and
   freshness signals.

Important detail: `retrieval_source: "hybrid"` currently means vector seed
search plus metadata, graph, pack-resolver, and typed-node retrieval. BM25
fields and RRF score fields remain in the result contract for compatibility,
but the current NornicDB path is not a standalone BM25 engine.

## Search Filters

Supported planner/MCP/Yarn filters include:

| Filter group | Fields |
|---|---|
| Pack | `pack_id`, `pack_ids`, `pack_version`, `pack_partition`, `version`, `version_preference` |
| Code/API | `language`, `package_name`, `symbol`, `symbol_kind`, `symbol_fqn`, `symbol_name`, `code_language`, `has_code` |
| Content | `domain`, `content_type`, `artifact_kind`, `content_format`, `tags`, `scope_tags`, `topic`, `task` |
| Constraints | `corpus_class`, `constraint_kind`, `content_profile`, `constraint_source`, `golden_path_id`, `perf_tier` |
| Paths | `repo_path`, `module_path` |
| Time/version | `commit`, `branch`, `temporal_at` |
| Graph | `graph_depth`, `edge_types` |
| Bundle controls | `include_examples`, `include_antipatterns`, `include_context_cards`, `mode` |

Coder guidance:

- Prefer `mode=bundle` for implementation guidance because it returns context
  cards, examples, anti-patterns, and freshness warnings.
- Use `language`, `artifact_kind`, `scope_tags`, and exact `symbol`/`symbol_fqn`
  filters before broad searches.
- Use `/v1/knowledge/resolve-pack` or the MCP resolver when a query could match
  multiple language versions or domains.
- Use `graph_depth=0` for exact source-only answers; use `graph_depth=1..2` for
  related examples/constraints/patterns; reserve `graph_depth=3` for broad
  relationship exploration.
- Use explicit edge types when hunting specific evidence: `DEFINES`,
  `DOCUMENTS`, `HAS_EXAMPLE`, `HAS_CONSTRAINT`, `HAS_PATTERN`,
  `HAS_CONTEXT_CARD`, `DEPRECATED_BY`, `REPLACED_BY`, `WARNS_ABOUT`,
  `RELATED_TO`.

## Authorization Model

Knowledge search does not trust caller-provided semantic scope hints on public
routes. Planner derives scope from auth context:

1. PAT/internal auth resolves user/org/tenant identity.
2. Planner derives `ScopeFilterOptions` from trusted auth, not untrusted request
   body fields.
3. NornicDB seed search and graph-neighbor expansion both apply visibility and
   ACL predicates.
4. In audit mode, graph predicates enforce basic scope/ACL group filtering.
5. In enforce mode, non-global or restricted/private rows require OpenFGA
   `can_read` on `authz_object_id`, usually `rag_doc:<doc_id>`.
6. Responses include `authz_trace_id` and header
   `x-synesis-authz-trace-id` for correlation.

This keeps graph expansion from crossing org, tenant, user, session, or ACL
boundaries.

## Knowledge Sources

Current source classes:

- **SynPack language packs**: curated language/framework/API packs with typed
  nodes, enrichment, examples, constraints, and vector sidecars.
- **Backstage/Developer Hub**: templates, platform standards, pipelines, and
  golden paths linked through `golden_path_id`.
- **Curated technical docs**: language/framework/tool references for coder
  reliability.
- **Code/API sources**: GitHub code, OpenAPI specs, structured data, markdown,
  PDFs, web pages, and repo maps handled by the indexer source handlers.
- **Internal governance artifacts**: constitutions, ADRs, runbooks, policy
  references, quality bars, and eval cases.
- **Feedback/gap loop**: retrieval gaps, curated proposals, and eval outputs
  that can become future indexed content.

All sources should carry provenance, authority classification, scan/review
status, freshness/version metadata, and scope/authz metadata.

## Pipeline Flow

```text
Source config / Admin queue item / SynPack catalog job
  -> indexer source handler or language-pack builder
  -> deterministic chunking, source cleanup, metadata extraction
  -> content gate, injection scan, optional enrichment
  -> BGE-M3 embedding
  -> catalog_entity() graph property normalization
  -> NornicDB ContentNode upsert
  -> deterministic edge upsert
  -> schema sync / quality and review surfaces

Planner / MCP / Yarn
  -> validate request and derive trusted scope
  -> optional pack resolution
  -> vector seed search + Cypher metadata/auth filters
  -> graph expansion with neighbor auth filters
  -> optional typed-node bundle queries
  -> OpenFGA enforcement when configured
  -> return structured evidence, cards, examples, warnings, quality, freshness
```

## Cross-Component Update Checklist

Any retrieval-visible schema or search behavior change must update:

1. **Indexer schema**: `schema.py`, `nornic_writer.py`, and schema/version tests.
2. **Ingestion pipeline**: `pipeline.py`, source handlers, content gate, scan,
   enrichment, and backfill behavior.
3. **SynPack/language packs**: `synpack.py`, `language_pack.py`, pack configs,
   prompt schemas, quality reports, and import validation.
4. **Planner retrieval**: `rag-client.ts`, `types.ts`, `metadata-filter.ts`,
   app route mapping, auth/scope handling, and retrieval tests.
5. **MCP/Yarn tools**: `packages/synesis-mcp-tools`, Yarn knowledge-search
   schemas/descriptions, and any tool guidance.
6. **Admin**: corpus schema display, content-pack install, review/quality pages,
   schema sync, retrieval eval surfaces.
7. **Docs**: this file, `docs/RAG.md`, `docs/INDEXERS.md`,
   `docs/rag-content-packs.md`, and operator runbooks as needed.
8. **Backfill/reindex**: rebuild affected packs/corpus so new fields and edges
   are actually present in NornicDB.

## Migration Notes

- Schema version is currently v20. Admin and indexer both report expected graph
  schema version `20`.
- Rows older than current schema may lack typed enrichment fields,
  `acl_group_ids`, `authz_object_id`, freshness/trust scores, or deprecation
  metadata until reindexed.
- Enforce-mode retrieval requires correct `rag_doc:*` OpenFGA grants for
  private/restricted/non-global content.
- Pack changes usually require rebuilding the `.synpack`, publishing a new
  artifact/checksum, and installing via Admin content-pack jobs.
