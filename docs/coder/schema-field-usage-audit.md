# Schema Field Usage Audit

The active RAG schema is the NornicDB content graph schema defined in
`base/rag/indexer/app/schema.py`.

Current audit focus:

- Graph node fields used by planner and MCP search results.
- Code fields used by coder retrieval and evidence scoring.
- Scope, ACL, and `authz_object_id` fields used for RAG hardening.
- Pack/version fields used by SynPacks and language packs.

For the current field list and update checklist, use
[rag-schema-and-knowledge-sources.md](rag-schema-and-knowledge-sources.md).
