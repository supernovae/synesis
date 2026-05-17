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

## Content Pack Imports

SynPack v2 content packs are installed with the NornicDB bulk importer by
default. The content-pack job reads the graph-native `nodes/`, `edges/`, and
`vectors/` artifacts and writes them through batched Bolt `UNWIND` statements.
This keeps large packs off the old row-by-row loader.

Useful controls:

- `SYNESIS_CONTENT_PACK_IMPORT_BACKEND=auto` selects the bulk importer for v2 or
  large packs.
- `SYNESIS_CONTENT_PACK_RUNNING_STALE_MINUTES` controls when Admin marks a
  claimed content-pack install as retryable after the worker disappears or
  exceeds its job deadline. The default is 180 minutes.
- `SYNESIS_NORNIC_BULK_NODE_BATCH_SIZE` controls chunk node batches with
  embeddings.
- `SYNESIS_NORNIC_BULK_META_NODE_BATCH_SIZE` controls non-vector metadata node
  batches.
- `SYNESIS_NORNIC_BULK_EDGE_BATCH_SIZE` controls relationship batches.

For hosted language packs such as Go, keep NornicDB above the production sizing
baseline (`8Gi` request, `16Gi` limit in the Helm defaults). A `2Gi` limit can
OOM during index rebuild or leave the content-pack runner blocked on Bolt during
bulk import.

Manual import test:

```bash
python -m app.cli --mode synpack --synpack-command bulk-load --synpack ./go.synpack --replace
```

## Health

```bash
oc rollout status deployment/synesis-nornicdb -n synesis-rag
oc get svc synesis-nornicdb -n synesis-rag
```

## Data Model

The content graph stores `ContentNode` nodes and semantic edges such as
`CONTAINS`, `DEFINES`, `CALLS`, `IMPORTS`, and `REFERENCES`. Version selection
uses `source_version`, `commit`, `branch`, `valid_from`, and `valid_to`.
