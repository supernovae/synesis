# RAG Stack

Synesis RAG uses **NornicDB** as the single graph/vector backend. The planner,
MCP tools, admin UI, indexer, and content pack loader all target the same
content graph.

## Install

```bash
helm upgrade --install synesis ./charts/synesis \
  -f my-synesis-values.yaml
```

The Helm chart applies the RAG stack as part of the Synesis release. Enable
indexer CronJobs under `jobs.indexer` in Helm values when you want queue
processing or content-pack installation managed by the release.

## Components

| Component | Purpose |
|-----------|---------|
| `nornicdb.yaml` | NornicDB native hybrid-search/graph database, HTTP + Bolt services, and durable PVC |
| `embedder/` | BGE-M3 embedding service for components that still need explicit embeddings |
| `indexer/` | Queue/staged/SynPack indexer that writes `ContentNode` graph nodes and relationships |
| `pack-configs/` | Canonical SynPack v2 language/domain/platform pack definitions |

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

1. native NornicDB HTTP vector + BM25 retrieval, equal-weight RRF fusion, and
   optional BGE stage-2 reranking
2. point lookup of candidate IDs with pack/scope/ACL/temporal Cypher filtering
3. bounded graph expansion across semantic edges
4. authority-aware ordering without rewriting native score diagnostics
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

Portable content packs are SynPack v2 ZIP archives with:

- `manifest.json`
- typed `nodes/*.jsonl`, including one indexed `PackManifest` routing node
- typed `edges/*.jsonl`
- `sources.lock.json`
- `vectors/index.json` plus `vectors/chunks.f32`
- `quality/report.json`

The loader upserts graph nodes idempotently and creates deterministic
relationships such as `CONTAINS` and `DEFINES`. Enrichment may add candidate
relationships and retrieval hints, but deterministic extraction remains the
authoritative source for graph edges.

Use `base/rag/pack-configs/` for Synesis-maintained reusable packs. Use Admin
queue bootstrap files, such as
`examples/ingestion/custom-ingestion-items.example.yaml`, for local or
organization-specific custom loads.
