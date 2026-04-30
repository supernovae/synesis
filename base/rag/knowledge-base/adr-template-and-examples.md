# ADR Template and Examples

## Template

- **Title**: Short imperative statement, for example "Use NornicDB for graph-native retrieval"
- **Status**: Proposed | Accepted | Deprecated | Superseded
- **Context**: Decision drivers and constraints
- **Decision**: The chosen approach
- **Consequences**: Tradeoffs, follow-up work, and operational impact

## ADR-001: Use NornicDB for Graph-Native Retrieval

**Status**: Accepted

**Context**: Synesis needs retrieval over documents, code, APIs, packs, and
organizational governance artifacts. Plain vector lookup is not enough for code
and structured docs because relationships such as "file contains symbol",
"chunk defines method", and "function calls function" materially improve
answers.

**Decision**: Use NornicDB as the RAG graph/vector backend.

**Rationale**:

- Vector indexes provide fast semantic seed retrieval.
- Graph nodes and edges preserve document hierarchy and code structure.
- Cypher predicates enforce pack, temporal, org, tenant, user, session, and ACL constraints.
- OpenFGA can make protected row access objective through `rag_doc:*` object checks.
- The same backend serves planner, MCP tools, admin quality surfaces, and indexer writes.

**Consequences**: The indexer must maintain graph schema compatibility and
backfill new graph/authz fields when schema versions change. In return,
retrieval gains code-aware expansion, stronger isolation, and better operator
debuggability through authz trace IDs.
