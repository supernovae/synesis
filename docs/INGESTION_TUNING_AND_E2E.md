# Ingestion Tuning and End-to-End Checks

This page captures the current RAG ingestion verification loop. For the full
operations guide, see [INDEXERS.md](INDEXERS.md).

## Goals

- Confirm Admin ingestion queue items reach `indexed`.
- Confirm the indexer writes NornicDB `ContentNode` graph nodes and edges.
- Confirm embeddings are present in the `embeddings` vector index.
- Confirm protected content carries exact scope/ACL/authz metadata.
- Confirm planner knowledge search can retrieve allowed content and reject
  disallowed content.

## Key Files

- [`base/rag/indexer/app/pipeline.py`](../base/rag/indexer/app/pipeline.py)
- [`base/rag/indexer/app/schema.py`](../base/rag/indexer/app/schema.py)
- [`base/rag/indexer/app/nornic_writer.py`](../base/rag/indexer/app/nornic_writer.py)
- [`base/planner-ts/src/retrieval/rag-client.ts`](../base/planner-ts/src/retrieval/rag-client.ts)

## E2E Checklist

1. Add or import a source through Admin.
2. Run `./scripts/deploy-indexer.sh --run`.
3. Confirm the ingestion item reaches `indexed`.
4. Confirm NornicDB has graph nodes for the source.
5. Confirm code sources have `File`/`Symbol` nodes and `CONTAINS`/`DEFINES`/`IMPORTS`/`CALLS` edges where applicable.
6. Query `/v1/knowledge/search` with an allowed principal.
7. Query the same content with an unscoped or wrong-tenant principal and confirm it is not returned.
8. When `SYNESIS_RAG_AUTHZ_MODE=enforce`, confirm protected rows have matching `rag_doc:*` OpenFGA grants.
