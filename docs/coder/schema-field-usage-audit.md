# Schema Field Usage Audit (v14 -> v15)

This audit captures read-path/runtime usage before any schema column removals.

## Active In Runtime Retrieval

- `artifact_kind`, `language`, `domain`, `source_url`, `heading_path`, `document_name`: consumed by planner retrieval result mapping in `base/planner-ts/src/retrieval/rag-client.ts` and `base/planner-ts/src/retrieval/unified.ts`.
- `corpus_class`, `constraint_kind`, `content_profile`, `scope_tags`, `constraint_source`, `golden_path_id`, `novel_pattern`, `novel_trace_level`: retrieved + filterable in `base/planner-ts/src/retrieval/rag-client.ts`, `base/planner-ts/src/retrieval/types.ts`, `base/planner-ts/src/retrieval/metadata-filter.ts`.
- `scan_status`, `scan_signals`, `approval_status`, `review_trace_id`, `raw_content_hash`, `crawl_timestamp`, `effective_at_epoch`: passed into trust/evidence payloads from planner retrieval code.

## Ingestion + Telemetry Critical

- `index_decision`, `quality_score`, `technical_depth`, `domain_relevance`, `content_type`: written by indexer pipeline and used for gate/evaluation telemetry (`base/rag/indexer/app/pipeline.py`).
- `visibility_scope`, `org_id`, `tenant_id`, `acl_mode`, `acl_groups`: required for scope/ACL enforcement and query filter construction.
- `scan_signals`, `review_trace_id`: required for trust attribution and admin diagnostics.

## UI / API Surfacing

- Queue/item diagnostics fields are surfaced through admin ingestion routes and queue stats payloads.
- Metadata filter fields are surfaced to planner and compatible clients via knowledge search request/response types.

## New v15 Fields

- `has_code`, `code_signal_count`, `code_density`, `code_language` are now used to:
  - enrich indexed entities in `base/rag/indexer/app/pipeline.py`
  - flow through planner retrieval mapping in `base/planner-ts/src/retrieval/rag-client.ts`
  - bias coder retrieval assembly in `base/planner-ts/src/retrieval/unified.ts`

## Removal Decision

No existing v14 columns should be removed in this rollout. Existing columns remain in active use across ingestion, filtering, and retrieval orchestration.
