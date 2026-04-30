# Graph-Native RAG Pipeline

Synesis uses **NornicDB** as the canonical RAG backend. The old vector-only
catalog has been replaced by a content graph with vector indexes, semantic
relationships, and temporal version metadata.

## Runtime Flow

The active planner runtime (`base/planner-ts/`) retrieves evidence through
`retrieveUnified()`:

1. Query NornicDB vector index `embeddings` for seed nodes.
2. Apply pack, symbol, ACL, tenant, version, branch, commit, and temporal filters.
3. Expand graph context over edges such as `DEFINES`, `CALLS`, `IMPORTS`, and `REFERENCES`.
4. Rerank and apply authority boosts.
5. Return structured context to planner and MCP callers.

Example:

```cypher
CALL db.index.vector.queryNodes('embeddings', 10, 'k8s pod eviction')
YIELD node, score
WHERE node.pack = 'kubernetes'
RETURN node, score
ORDER BY score DESC
```

## Content Graph

Canonical graph: `content_graph`.

Primary node labels:

- `ContentNode`
- `Document`
- `File`
- `Chunk`
- `Symbol`
- `Function`
- `Class`
- `Method`
- `Resource`
- `Concept`

Primary edge types:

- `CONTAINS`
- `DEFINES`
- `CALLS`
- `IMPORTS`
- `REFERENCES`
- `OVERRIDES`
- `IMPLEMENTS`
- `DOCUMENTS`
- `VALID_IN`
- `DERIVED_FROM`

## Request Controls

Planner and MCP knowledge search support:

- `pack_id` / `pack_ids`
- `pack_version`
- `version`
- `commit`
- `branch`
- `temporal_at`
- `symbol_fqn`
- `symbol_name`
- `graph_depth`
- `edge_types`
- standard org, tenant, user, and ACL filters

## Content Integrity

Chunks are scanned for prompt-injection patterns during ingestion. The
`scan_status`, `approval_status`, `review_trace_id`, and authority fields are
stored on graph nodes and surfaced in the Admin review queue.

Vetting boosts ranking but does not remove prompt trust boundaries. Retrieved
content is still treated as untrusted context by the planner.

## Configuration

Primary environment variables:

| Setting | Default |
|---------|---------|
| `SYNESIS_NORNIC_URI` | `bolt://synesis-nornicdb.synesis-rag.svc.cluster.local:7687` |
| `SYNESIS_NORNIC_DATABASE` | `neo4j` |
| `SYNESIS_NORNIC_VECTOR_INDEX` | `embeddings` |
| `SYNESIS_NORNIC_RUNTIME_PROFILE` | `cpu-bge` |
| `SYNESIS_NORNIC_GRAPH_DEPTH` | `2` |
| `SYNESIS_NORNIC_EDGE_TYPES` | `CONTAINS,DEFINES,CALLS,IMPORTS,REFERENCES,OVERRIDES,IMPLEMENTS,DOCUMENTS` |

Back to [README](../README.md) | See also: [Knowledge Indexers](INDEXERS.md) | [SynPacks](SYNPACKS.md)
