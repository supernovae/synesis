# RAG retrieval — golden checks (stub)

Use this after **schema bumps** or **gatekeeper prompt** changes.

## Suggested checks

1. **Hybrid search** — fixed queries against `synesis_catalog`; note top-1 `chunk_id` and `source_url`.
2. **MCP-style filters** — combine `language`, `artifact_kind`, `content_type`, `index_decision` via planner `build_metadata_filter` (see `base/planner/app/rag_client.py`).
3. **Regression** — store expected chunk_ids in a small YAML or pytest file; fail CI when embeddings/index change without review.

This file is intentionally minimal; expand into automated tests when the corpus stabilizes.
