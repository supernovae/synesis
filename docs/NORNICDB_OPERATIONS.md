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

NornicDB pod runtime profile:

```bash
NORNICDB_RUNTIME_PROFILE=cpu-bge
```

GPU/accelerated deployments can override with `cuda-bge` or `metal-bge`.
The planner also records `SYNESIS_NORNIC_RUNTIME_PROFILE` as retrieval metadata;
keep it aligned with the database pod profile when changing hardware class.

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
- `SYNESIS_NORNIC_BULK_RETRY_ATTEMPTS` and
  `SYNESIS_NORNIC_BULK_RETRY_BASE_DELAY` control retry/backoff for transient
  Bolt disconnects during node and relationship batches.
- `SYNESIS_NORNIC_BULK_SUSPEND_VECTOR_INDEX=true` drops only the vector index
  during large bulk imports and recreates it after verification. The id
  constraint stays online so node/edge `MERGE` and `MATCH` operations remain
  indexed.
- `SYNESIS_NORNIC_FAST_NODE_CREATE=true` enables faster create-first writes
  when a content-pack install is replacing an existing pack.

For hosted language packs such as Go, keep NornicDB above the production sizing
baseline (`8Gi` request, `16Gi` limit in the Helm defaults). A `2Gi` limit can
OOM during index rebuild or leave the content-pack runner blocked on Bolt during
bulk import.

If a load fails with `Failed to read from defunct connection`, inspect the
NornicDB pod first. If the previous container state is `OOMKilled` / exit 137,
the Bolt client error is downstream of the server restart. Increase the live
NornicDB resources or lower the bulk batch sizes before retrying the pack.

Manual import test:

```bash
python -m app.cli --mode synpack --synpack-command bulk-load --synpack ./go.synpack --replace
```

## Health

```bash
oc rollout status deployment/synesis-nornicdb -n synesis-rag
oc get svc synesis-nornicdb -n synesis-rag
```

## NornicDB 1.1.5 Upgrade Notes

Synesis pins NornicDB to upstream `v1.1.5` in both Helm and the raw Kustomize
deployment:

- Helm default: `workloads.nornicdb.image.tag: v1.1.5`
- Raw manifest: `docker.io/timothyswt/nornicdb-amd64-cpu:v1.1.5`
- Release: `https://github.com/orneryd/NornicDB/releases/tag/v1.1.5`
- Docker docs:
  `https://github.com/orneryd/NornicDB/blob/v1.1.5/docs/operations/docker.md`

The v1.1.5 release is a post-v1.1.4 stabilization release focused on
Cypher/Bolt correctness, Badger storage recovery, large embedding chunk
persistence, and deterministic Neo4j-driver query behavior. The fixes are
directly relevant to Synesis content-pack imports because the indexer uses
batched Bolt `MATCH`, `CREATE`, `MERGE`, `SET`, `UNWIND`, relationship writes,
and vector queries.

No Synesis setting change is required for this upgrade. The upstream README now
documents CPU images with bundled BGE embeddings, headless images, retention
policies, Qdrant-compatible gRPC, and per-database search-index configuration.
Synesis keeps the smaller `nornicdb-amd64-cpu` image because embedding is handled
by the separate TEI/BGE service. The NornicDB HTTP port remains internal and is
used by the Admin service health prober, so do not switch to a headless image or
disable HTTP without also updating health checks. Continue to override the
repository/tag at deploy time if you need a GPU, ARM64, or BGE-bundled NornicDB
image.

**Log hygiene:** NornicDB v1.1.5 startup logs include authentication details.
Treat startup logs as sensitive, avoid sharing them externally, and rotate the
`synesis-nornicdb-auth` Secret if those logs are exported to a broad audience or
attached to support tickets.

## Fresh Reset for Pack Reload Testing

NornicDB v1.1.5 includes the former search-index master-switch work plus
additional storage/Bolt correctness fixes. For content pack bug verification, a
fresh PVC reset is still often faster and cleaner than deleting graph content
through Cypher.

Use the v1.1.5 load-test override when you want the upstream release tag plus
cold BM25/vector indexes during bulk ingestion. As of v1.1.5, the upstream
NornicDB Docker guide lists Docker Hub images under `timothyswt/*`; Synesis pins
`docker.io/timothyswt/nornicdb-amd64-cpu:v1.1.5` and annotates the workload with
the GitHub release URL at `https://github.com/orneryd/NornicDB/releases/tag/v1.1.5`.
If upstream later publishes a GHCR or `nornicdb/*` org image, override the
repository in Helm values while keeping the release annotation pointed at the
same upstream tag.

```bash
helm upgrade synesis charts/synesis \
  --namespace default \
  --reuse-values \
  -f charts/synesis/examples/values-aks-nornicdb-v1.1.5-load-test.yaml
```

To reset the graph store before reloading a pack, scale NornicDB down, delete
only its data PVC, then scale it back up:

```bash
kubectl -n synesis-rag scale deployment/synesis-nornicdb --replicas=0
kubectl -n synesis-rag delete pvc synesis-nornicdb-data
kubectl -n synesis-rag scale deployment/synesis-nornicdb --replicas=1
kubectl -n synesis-rag rollout status deployment/synesis-nornicdb
```

For the raw Kustomize deployment, the PVC name is `nornicdb-data` instead of
`synesis-nornicdb-data`:

```bash
kubectl -n synesis-rag delete pvc nornicdb-data
```

## Data Model

The content graph stores `ContentNode` nodes and semantic edges such as
`CONTAINS`, `DEFINES`, `CALLS`, `IMPORTS`, and `REFERENCES`. Version selection
uses `source_version`, `commit`, `branch`, `valid_from`, and `valid_to`.
