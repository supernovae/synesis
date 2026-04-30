# NornicDB Operations

Synesis runs NornicDB as the RAG graph/vector database. The default deployment
is a single `synesis-nornicdb` pod with a durable PVC and Bolt service on
`7687`.

## Planner Fanout

Planner retrieval issues graph-native requests:

- vector seed query
- Cypher metadata/ACL/temporal filters
- graph expansion
- rerank/authority boost

Tune graph fanout with:

- `SYNESIS_NORNIC_GRAPH_DEPTH`
- `SYNESIS_NORNIC_EDGE_TYPES`
- `SYNESIS_RAG_OVERFETCH_MIN`
- `SYNESIS_RAG_OVERFETCH_MAX`

## Runtime Profiles

Default:

```bash
SYNESIS_NORNIC_RUNTIME_PROFILE=cpu-bge
```

GPU/accelerated deployments can override with `cuda-bge` or `metal-bge`.

## Health

```bash
oc rollout status deployment/synesis-nornicdb -n synesis-rag
oc get svc synesis-nornicdb -n synesis-rag
```

## Data Model

The content graph stores `ContentNode` nodes and semantic edges such as
`CONTAINS`, `DEFINES`, `CALLS`, `IMPORTS`, and `REFERENCES`. Version selection
uses `source_version`, `commit`, `branch`, `valid_from`, and `valid_to`.
