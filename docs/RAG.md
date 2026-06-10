# Graph-Native RAG Pipeline

Synesis uses **NornicDB** as the canonical RAG backend. Retrieval is no longer a
vector-store-only lookup: content is indexed as a graph of documents, files,
chunks, symbols, imports, calls, references, and pack relationships, with BGE-M3
embeddings attached to searchable graph nodes.

## Runtime Flow

The active planner runtime (`base/planner-ts/`) retrieves evidence through
`retrieveUnified()`:

1. Embed the query with the TEI BGE-M3 service when configured.
2. Query the NornicDB vector index `embeddings` for seed `ContentNode` matches.
3. Apply pack, symbol, scope, ACL, version, branch, commit, and temporal filters.
4. Expand graph context over allowed edges such as `DEFINES`, `CALLS`, `IMPORTS`, and `REFERENCES`.
5. Reapply the same authorization predicate to graph neighbor nodes.
6. Rerank, apply authority and freshness boosts, and return structured evidence packets.
7. Merge RAG evidence with web evidence through Reciprocal Rank Fusion when web search is enabled.

Example query shape:

```cypher
CALL db.index.vector.queryNodes($index_name, $limit, $query)
YIELD node, score
WHERE node.pack = $pack_id
  AND ((coalesce(node.visibility_scope, "global") = "global") AND coalesce(node.acl_mode, "open") IN ["open", ""])
OPTIONAL MATCH path=(node)-[rels:DEFINES|CALLS|IMPORTS*1..2]-(neighbor)
WHERE ((coalesce(neighbor.visibility_scope, "global") = "global") AND coalesce(neighbor.acl_mode, "open") IN ["open", ""])
RETURN node, score, collect(DISTINCT neighbor)[0..12] AS neighbors
ORDER BY score DESC
LIMIT $result_limit
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

## Code-Aware Retrieval

The indexer extracts code structure without requiring an LLM:

- tree-sitter aware chunking for supported code sources
- `File` and `Symbol` graph nodes
- deterministic `CONTAINS`, `DEFINES`, `IMPORTS`, and `CALLS` relationships
- exact/same-file/package-hint resolution for symbol edges
- unresolved external references preserved as graph hints

SynPacks and language packs can still add LLM-enriched summaries and hooks, but
the graph edges used for retrieval are deterministic and available to all ingest
paths.

## Authorization

RAG authorization is structural and principal-derived.

Planner knowledge search no longer trusts caller-provided `caller_org_id`,
`caller_tenant_ids`, `caller_acl_groups`, or `caller_user_id` fields. The planner
derives scope from the resolved auth context:

- PAT rows provide `user_id`, `org_id`, `tenant_ids`, role, and scopes.
- Trusted internal calls require `SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN` plus forwarded identity headers.
- Anonymous or unscoped callers see only global/open graph nodes.

The NornicDB query applies the same visibility and ACL predicate to seed nodes
and graph-expanded neighbor nodes. ACL matching is exact: `acl_group_ids` array
membership is preferred, with trimmed CSV fallback for older rows.

`SYNESIS_RAG_AUTHZ_MODE` controls enforcement:

| Mode | Behavior |
|------|----------|
| `audit` | Principal-derived structural filters are applied; ignored request-body scope hints are logged with `authz_trace_id`. |
| `enforce` | Structural filters are applied, and non-global/restricted/private rows are post-filtered through OpenFGA `can_read` checks against indexed `rag_doc:*` objects. |

Each knowledge-search response includes `authz_trace_id` and
`x-synesis-authz-trace-id` so operators can correlate search results, logs, and
OpenFGA decisions.

## Request Controls

Planner and MCP knowledge search support:

- `pack_id` / `pack_ids`
- `pack_version`
- `pack_partition`
- `version`
- `commit`
- `branch`
- `temporal_at`
- `symbol_fqn`
- `symbol_name`
- `repo_path`
- `module_path`
- `graph_depth`
- `edge_types`
- content/profile filters such as `corpus_class`, `constraint_kind`, `content_profile`, and `golden_path_id`

Org, tenant, user, and ACL filters are not accepted from untrusted request
payloads. They are derived from authentication state.

## Content Integrity

Chunks are scanned for prompt-injection patterns during ingestion. The
`scan_status`, `scan_signals`, `approval_status`, `review_trace_id`, authority,
freshness, and authz fields are stored on graph nodes and surfaced in the Admin
review queue.

Vetting boosts ranking but does not remove prompt trust boundaries. Retrieved
content is still wrapped as untrusted reference material before reaching writer
and critic prompts.

## Configuration

Primary environment variables:

| Setting | Default |
|---------|---------|
| `SYNESIS_NORNIC_URI` | `bolt://synesis-nornicdb.synesis-rag.svc.cluster.local:7687` |
| `SYNESIS_NORNIC_DATABASE` | `nornic` |
| `SYNESIS_NORNIC_VECTOR_INDEX` | `embeddings` |
| `SYNESIS_NORNIC_RUNTIME_PROFILE` | `cpu-bge` planner metadata; keep aligned with database pod `NORNICDB_RUNTIME_PROFILE` |
| `SYNESIS_NORNIC_GRAPH_DEPTH` | `2` |
| `SYNESIS_NORNIC_EDGE_TYPES` | `CONTAINS,DEFINES,CALLS,IMPORTS,REFERENCES,OVERRIDES,IMPLEMENTS,DOCUMENTS` |
| `SYNESIS_EMBEDDER_URL` | empty |
| `SYNESIS_EMBEDDER_MODEL` | `BAAI/bge-m3` |
| `SYNESIS_RAG_AUTHZ_MODE` | `audit` |

Back to [README](../README.md) | See also: [Knowledge Indexers](INDEXERS.md) | [SynPacks](SYNPACKS.md) | [NornicDB Operations](NORNICDB_OPERATIONS.md)
