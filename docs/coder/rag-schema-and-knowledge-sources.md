# RAG Schema and Knowledge Sources

## Purpose

Define how coder/planner knowledge is represented, enriched, authorized, and
consumed across indexer, admin, planner, MCP, and Yarn.

## Current Baseline

- Canonical graph schema lives in [`base/rag/indexer/app/schema.py`](../../base/rag/indexer/app/schema.py).
- NornicDB writer logic lives in [`base/rag/indexer/app/nornic_writer.py`](../../base/rag/indexer/app/nornic_writer.py).
- Planner retrieval lives in [`base/planner-ts/src/retrieval/rag-client.ts`](../../base/planner-ts/src/retrieval/rag-client.ts).
- Ingestion lifecycle is documented in [`docs/INDEXERS.md`](../INDEXERS.md).

Current schema version: **v19**.

## Schema v19 — NornicDB Content Graph

Schema v19 is graph-native. Chunks remain searchable by vector embeddings, but
they are also connected to structural nodes and relationships:

| Element | Purpose |
|---------|---------|
| `ContentNode` | Shared base label for searchable graph entities |
| `Document` / `File` / `Chunk` | Source hierarchy and path-aware retrieval |
| `Symbol` / `Function` / `Class` / `Method` | Code-aware retrieval anchors |
| `CONTAINS` | Document/file/chunk containment |
| `DEFINES` | Chunk-to-symbol definitions |
| `IMPORTS` / `CALLS` | Deterministic code relationship edges |
| `REFERENCES` / `DOCUMENTS` | Semantic and documentation relationships |

Code chunks preserve `import_refs` and `call_refs`; deterministic resolution
matches exact symbols, same-file symbols, package/module hints, and unresolved
external references. This works for ordinary GitHub code ingestion and managed
SynPack/language-pack artifacts without requiring an LLM.

## First-Class Retrieval Fields

Important current fields include:

| Field | Description |
|---|---|
| `pack_id`, `pack_version`, `pack_source_version`, `pack_partition` | Managed pack identity and versioning |
| `symbol_kind`, `symbol_fqn`, `symbol_name`, `package_name` | Code and API reference targeting |
| `corpus_class`, `constraint_kind`, `content_profile`, `scope_tags` | Constraint-aware retrieval and evidence scoring |
| `constraint_source`, `constraint_confidence`, `golden_path_id` | Source quality and organizational golden path linkage |
| `novel_pattern`, `novel_trace_level` | Experimental-pattern handling |
| `agent_hook`, `perf_tier`, `safety_contract`, `lifecycle_model`, `agent_enrichment_json` | Agent-facing pack guidance |
| `visibility_scope`, `org_id`, `tenant_id`, `owner_user_id`, `conversation_id` | Structural scope filtering |
| `acl_mode`, `acl_groups`, `acl_group_ids`, `authz_object_id` | Exact ACL matching and OpenFGA object mapping |

## Authorization Model

RAG authorization is no longer dependent on caller-provided semantic hints.

1. Admin RBAC normalizes effective scope on ingestion items.
2. The indexer validates scope and ACL fields before writing graph nodes.
3. Scope and ACL metadata are copied onto chunk, document, file, and symbol nodes.
4. Planner retrieval derives caller scope from auth context, not request body.
5. NornicDB applies the same auth predicate to seed nodes and graph neighbors.
6. In `SYNESIS_RAG_AUTHZ_MODE=enforce`, restricted/private or non-global rows are
   checked through OpenFGA `can_read` using `authz_object_id` such as `rag_doc:<doc_id>`.

This makes retrieval isolation objective: graph traversal can improve recall
without crossing org, tenant, session, or ACL boundaries.

## Cross-Component Update Checklist

Any schema extension must update:

1. **Indexer** — `schema.py`, `pipeline.py`, and tests.
2. **NornicDB writer** — graph node/edge propagation and indexes when needed.
3. **Planner-TS** — `rag-client.ts`, `metadata-filter.ts`, and `types.ts`.
4. **MCP-TS** — knowledge-search tool schemas and pass-through params.
5. **Yarn-TS** — knowledge-search result types and confidence scoring if consumed by coder workflows.
6. **Admin** — ingestion/RBAC fields and review/quality surfaces if operator-facing.
7. **Documentation** — this file, `docs/RAG.md`, and `docs/INDEXERS.md`.
8. **Backfill** — re-index existing corpus to populate new graph fields.

## Knowledge Source Model

- **Backstage/Developer Hub**: templates, pipelines, and platform standards linked via `golden_path_id`.
- **Curated technical docs**: language/framework/tooling references for coder reliability.
- **General corpus**: non-coding domain context for product/domain reasoning.
- **Internal governance artifacts**: constitutions, ADRs, runbooks, quality bars, and policy references.

All sources require provenance, authority classification, scan status, freshness
metadata, and scope metadata.

## Pipeline Flow

```text
Corpus / Admin queue item
  -> indexer source handler
  -> deterministic chunking and metadata extraction
  -> optional enrichment and quality gates
  -> TEI BGE-M3 embedding
  -> injection scan and review metadata
  -> NornicDB ContentNode upsert
  -> deterministic graph edge upsert

Planner-TS
  -> embed query
  -> NornicDB vector seed search
  -> metadata + authz predicates
  -> graph expansion with neighbor authz
  -> optional OpenFGA row enforcement
  -> RRF merge with web evidence

MCP / Yarn
  -> call planner knowledge-search APIs
  -> receive structured graph-aware evidence
```

## Backfill and Migration

After schema or authz metadata changes, re-run the indexer for affected sources.
Rows that predate `acl_group_ids` or `authz_object_id` remain readable in audit
mode, but `enforce` mode requires correct `rag_doc:*` grants for non-global or
restricted/private content.
