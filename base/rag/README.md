# RAG Stack

Synesis RAG uses **NornicDB** as the single graph/vector backend. The planner,
MCP tools, admin UI, indexer, and content pack loader all target the same
content graph.

## Install

```bash
./scripts/install-rag-stack.sh
./scripts/install-rag-stack.sh --wait
```

The full `./scripts/deploy.sh dev` applies the RAG stack as part of the
overlay and waits for `synesis-nornicdb`.

## Components

| Component | Purpose |
|-----------|---------|
| `nornicdb.yaml` | NornicDB graph/vector database, Bolt service, and durable PVC |
| `embedder/` | BGE-M3 embedding service for components that still need explicit embeddings |
| `indexer/` | Queue/staged/content-pack indexer that writes `ContentNode` graph nodes and relationships |

## Content Graph

The canonical graph is `content_graph`.

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

## Retrieval

Planner retrieval follows:

1. vector query against the `embeddings` index
2. pack/scope/ACL/temporal Cypher filtering
3. graph expansion across semantic edges
4. rerank/authority boost
5. structured context returned to planner and MCP callers

Example:

```cypher
CALL db.index.vector.queryNodes('embeddings', 10, 'k8s pod eviction')
YIELD node, score
WHERE node.pack = 'kubernetes'
RETURN node, score
ORDER BY score DESC
```

## Content Packs

Portable content packs are ZIP archives with:

- `manifest.json`
- `nodes.jsonl`
- `edges.jsonl`
- `sources.lock.json`
- optional `vectors.npy`

The loader upserts graph nodes idempotently and creates deterministic
relationships such as `CONTAINS` and `DEFINES`. Enrichment may add candidate
relationships and retrieval hints, but deterministic extraction remains the
authoritative source for graph edges.
