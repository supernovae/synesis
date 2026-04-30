# Architecture Audit

This page is intentionally short. Older audit notes for the removed Python
planner and retired vector-store era have been removed from the active docs
because they were misleading for operators.

## Current Runtime

- **Planner:** `base/planner-ts/`
- **Coder:** `base/yarn-ts/`
- **RAG backend:** NornicDB content graph and vector index
- **Authorization:** OpenFGA plus principal-derived structural RAG filters
- **Indexer:** queue-driven Python indexer writing schema v19 graph nodes/edges

## Current RAG Audit Points

| Area | Current status |
|------|----------------|
| Graph retrieval | NornicDB vector seeds plus graph expansion over document/code edges |
| Scope isolation | Org, tenant, user, session, and ACL predicates applied to seeds and neighbors |
| Object authorization | `SYNESIS_RAG_AUTHZ_MODE=enforce` post-filters protected rows through OpenFGA `can_read` |
| Code graph | Ordinary code ingestion and SynPacks both emit deterministic code graph edges |
| Prompt trust | Retrieved evidence remains untrusted and wrapped in TrustPacketV1 |

For implementation details, use [RAG](RAG.md), [INDEXERS](INDEXERS.md), and
[SECURITY](SECURITY.md) as the source of truth.
