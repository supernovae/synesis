# RAG Schema and Knowledge Sources

## Purpose

Define how coder/planner knowledge is represented, enriched, and consumed across indexer, admin, planner, MCP, and Yarn.

## Current Baseline

- Milvus catalog schema version is currently defined in [`/Users/bymiller/src/synesis/base/rag/indexer/app/schema.py`](/Users/bymiller/src/synesis/base/rag/indexer/app/schema.py).
- Schema-sync behavior and ingestion lifecycle are documented in [`/Users/bymiller/src/synesis/docs/INDEXERS.md`](/Users/bymiller/src/synesis/docs/INDEXERS.md).

## v13+ Extension Candidates

Proposed fields for constraint-aware retrieval:

- `constraint_domain`
- `constraint_kind`
- `constraint_source`
- `constraint_confidence`
- `constraint_fix_class`
- `constraint_applicability`
- `golden_path_id`
- `validation_recipe_id`
- `novel_pattern`
- `novel_trace_level`

## Cross-Component Update Checklist

Any schema extension must update:

1. Indexer schema and ingestion mappings
2. Admin mirror schema and review endpoints
3. Planner retrieval output fields/types
4. MCP filter contracts
5. Documentation and backfill job definitions

## Knowledge Source Model

- **Backstage/Developer Hub:** first-class source for templates, pipelines, and platform standards.
- **Curated technical docs:** language/framework/tooling references for coder reliability.
- **General corpus:** non-coding domain context for product/domain reasoning.
- **Internal governance artifacts:** constitutions, ADRs, runbooks, quality bars.

All sources require provenance, authority classification, and freshness handling.
