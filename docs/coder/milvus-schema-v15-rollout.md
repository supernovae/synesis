# Milvus Schema v15 Rollout Notes

Schema v15 adds code-centric retrieval metadata fields:

- `has_code` (bool)
- `code_signal_count` (int64)
- `code_density` (float)
- `code_language` (varchar)

## Rollout Sequence

1. Deploy admin + indexer images that both expect `SCHEMA_VERSION = 15`.
2. Ensure Milvus proxy `maxFieldNum` is high enough for current catalog fields.
3. Allow schema sync/reset path to recreate `synesis_catalog` as v15.
4. Re-run targeted Go ingestion (`scripts/go-first-rag-load.sh`) with upsert defaults.
5. Validate retrieval payloads include v15 fields and coding-bias behavior in planner retrieval.

## Verification Checklist

- Admin schema check reports expected v15.
- New ingestion item stats include:
  - `parsed_total`
  - `dedup_skipped`
  - `gate_rejected`
  - `gatekeeper_skipped_docs`
  - `written_total`
- Planner retrieval responses include code fields and bucket tags for coding intents.

## Rollback Strategy

If rollback is required:

1. Revert app code expecting v15 back to v14-compatible build.
2. Reset/recreate `synesis_catalog` with v14 schema via admin reset path.
3. Requeue ingestion items for affected corpus domains.
4. Verify planner retrieval can deserialize rows without v15 fields.

Note: Schema rollback is destructive to catalog data and requires re-indexing.
