# Milvus Scaling and HA Guide

## Current Architecture: Operator-Managed Standalone

Synesis uses the **Milvus Operator** (Helm-installed) to manage Milvus as a `kind: Milvus` Custom Resource in standalone mode.

```
base/rag/milvus-operator.yaml  →  Milvus CR (spec.mode: standalone)
                                    ├── etcd (PVC on efs-sc, 2Gi)
                                    ├── Milvus standalone pod (2 req / 6 limit CPU, 8Gi)
                                    ├── S3: byron-ai-d8a35264-rhoai-data/milvus/
                                    └── Service: synesis-milvus:19530
```

## Concurrency and Fan-Out (Planner → Milvus)

The planner **fans out** evidence retrieval: for each turn it may run **N evidence requests in parallel** (e.g. 2–10), each doing a Milvus hybrid search. Each planner pod has a **client pool** of size `SYNESIS_MILVUS_POOL_SIZE` (default 4), so at most that many concurrent gRPC requests to Milvus per pod.

| Scenario | Planner pods | Pool size | Max concurrent Milvus requests |
|----------|--------------|-----------|-------------------------------|
| 1 user   | 1            | 4         | 4                             |
| 2 users  | 2            | 4         | 8                             |
| N users  | N            | 4         | 4N                            |

**Sizing for standalone:**

- **CPU**: Request ≥ 2, limit 4–6 so the single Milvus process isn’t throttled when 4–8 concurrent searches hit. If you increase pool size or planner replicas, consider raising the limit (or moving to cluster mode).
- **Memory**: 4Gi request / 8Gi limit is enough for HNSW + BM25 and typical corpus size.
- **Pool size**: Default 4 is a good balance. Increase (e.g. 6–8) only if Milvus has spare CPU and you want lower queueing; don’t exceed what Milvus can handle without RPC errors (see below).

**If you see RPC/connection errors under load:** Standalone has one query node; it can be overwhelmed by too many concurrent gRPC requests. Options:

1. **Keep pool size at 4** and give Milvus more CPU (already 2 req / 6 limit) so each request finishes faster.
2. **Avoid raising pool size** until Milvus is clearly underutilized (monitor CPU and `MilvusHighQueryLatency`).
3. **Scale out**: Move to **cluster mode** and scale `queryNode` replicas so multiple nodes serve searches in parallel (see “Upgrade Path: Distributed Mode” below).

**Tuning from the planner:** Set `SYNESIS_MILVUS_POOL_SIZE` (default 4) in the planner deployment to control how many concurrent Milvus clients each planner pod uses. Only increase if Milvus has headroom (check CPU and query latency).

The operator handles:
- etcd provisioning and lifecycle
- Milvus pod rolling updates
- Service (`synesis-milvus`) creation on ports 19530 (gRPC) and 9091 (health/metrics)

### S3 Object Storage

Milvus v2.6 uses **woodpecker** as its WAL (write-ahead log), which requires S3-compatible
object storage. Segments and WAL data are stored at `s3://byron-ai-d8a35264-rhoai-data/milvus/`.

#### IAM User Setup

Create a dedicated IAM user with scoped S3 access:

```bash
aws iam create-user --user-name milvus-synesis

aws iam put-user-policy --user-name milvus-synesis \
    --policy-name s3-milvus \
    --policy-document '{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:*"],
    "Resource": [
      "arn:aws:s3:::byron-ai-d8a35264-rhoai-data",
      "arn:aws:s3:::byron-ai-d8a35264-rhoai-data/milvus/*"
    ]
  }]
}'

aws iam create-access-key --user-name milvus-synesis
```

Store the keys in a Kubernetes secret:

```bash
oc create secret generic milvus-s3-secret \
    -n synesis-rag \
    --from-literal=accesskey="<ACCESS_KEY_ID>" \
    --from-literal=secretkey="<SECRET_ACCESS_KEY>" \
    --dry-run=client -o yaml | oc apply -f -
```

The Milvus CR references this secret via `dependencies.storage.secretRef: milvus-s3-secret`.

#### Why Not IRSA?

ROSA HCP blocks the EC2 Instance Metadata Service (IMDS) from pods, so `useIAM: true`
fails. Static keys via the S3 secret are the reliable path. If your cluster enables
Pod Identity or IRSA with projected tokens in the future, switch to `useIAM: true` and
set empty keys in the secret.

### OpenShift SCC Requirements

The Milvus Operator's init container and the Milvus v2.6 image require UIDs outside
the namespace-allocated range. Grant `anyuid` SCC to the default SA:

```bash
oc adm policy add-scc-to-user anyuid -z default -n synesis-rag
```

The etcd chart's hardcoded UIDs are handled by disabling `podSecurityContext` and
`containerSecurityContext` in the etcd Helm values within the CR.

### Why Operator over Manual Manifests

- CRD-based management — `oc get milvus` shows cluster state
- Automatic etcd lifecycle — no manual etcd Deployment to maintain
- Rolling updates — operator handles version upgrades
- Clear upgrade path — change `spec.mode: standalone` to `spec.mode: cluster` for distributed

## etcd on EFS: Trade-offs

etcd stores Milvus metadata (collection schemas, segment locations, partition maps). It is sensitive to disk I/O latency.

### Why EFS (`efs-sc`)

- **Durability across AZs** — survives spot instance termination and AZ failover
- **No volume re-attach delays** — EFS mounts are available immediately on any node
- **Cost** — pay per GB stored, no pre-provisioned IOPS needed for small metadata volume

### Latency Characteristics

| Storage | Typical fsync latency | etcd compatibility |
|---------|----------------------|-------------------|
| gp3 EBS | 1-5ms | Excellent |
| io2 EBS | <1ms | Excellent |
| EFS (General Purpose) | 5-25ms | Acceptable for standalone |
| EFS (Elastic Throughput) | 5-25ms, bursts lower | Acceptable for standalone |

For a single-user standalone Milvus with moderate write rates, EFS latency is acceptable. etcd's write volume for Milvus metadata is low (segment registration, schema changes — not per-query).

### Monitoring

Prometheus alerts in `base/observability/prometheus-rule-rag.yaml` monitor:

- **EtcdHighFsyncLatency** — WAL fsync p99 >50ms for 15 min (warning)
- **EtcdHighCommitLatency** — backend commit p99 >100ms for 15 min (warning)
- **MilvusPodNotReady** — pod down >5 min (critical)
- **MilvusHighQueryLatency** — vector search p95 >500ms for 10 min (warning)
- **EmbedderNotReady** — TEI pod down >5 min (critical)

### When to Switch to EBS

If `EtcdHighFsyncLatency` fires persistently (not just during burst indexing), consider:

```yaml
# In milvus-operator.yaml, change etcd persistence:
dependencies:
  etcd:
    inCluster:
      values:
        persistence:
          storageClassName: gp3  # or io2 for guaranteed IOPS
          size: 2Gi
```

This requires the etcd PVC to be recreated (operator handles this with `deletionPolicy: Retain` for safety).

## Upgrade Path: Distributed Mode

Standalone Milvus handles significant load — up to ~10M vectors with HNSW on a 4-CPU/8Gi node. When you need to scale beyond that:

### Distributed Architecture

```
spec:
  mode: cluster
  components:
    proxy:
      replicas: 2
    queryNode:
      replicas: 2
    dataNode:
      replicas: 2
    indexNode:
      replicas: 1
    mixCoord:
      replicas: 1
```

Distributed mode separates concerns:
- **Proxy** — routes queries and inserts
- **QueryNode** — handles vector search (scale for read throughput)
- **DataNode** — handles data ingestion (scale for write throughput)
- **IndexNode** — builds HNSW/IVF indexes (scale for index build speed)
- **MixCoord** — merged coordinator (replaces rootcoord+querycoord+datacoord+indexcoord)

### S3 for Object Storage (Distributed)

Distributed mode requires shared object storage for segments. Use the existing S3 bucket instead of deploying MinIO:

```yaml
dependencies:
  storage:
    external: true
    type: S3
    endpoint: s3.us-east-1.amazonaws.com
    accessKeyID: ""      # Use IRSA (IAM Roles for Service Accounts)
    secretAccessKey: ""
    bucketName: byron-ai-d8a35264-rhoai-data
    rootPath: milvus
    useSSL: true
    region: us-east-1
    useIAM: true
```

This shares the same bucket used by OpenShift AI pipelines, with data isolated under the `/milvus` prefix.

### Message Queue (Distributed)

Distributed mode needs a message queue for write-ahead log streaming:

- **Pulsar** — default, operator can deploy in-cluster
- **Kafka** — if you already run Strimzi/AMQ Streams on the cluster
- **NATS** — lightweight alternative (Milvus 2.5+)

For cost, Kafka via Strimzi is recommended if already available on the cluster.

## Production HA Recommendations

For production deployments requiring high availability:

| Component | Standalone | Production HA |
|-----------|-----------|---------------|
| Milvus | 1 pod | 2+ proxy, 2+ queryNode, 2+ dataNode |
| etcd | 1 replica (EFS) | 3 replicas (gp3 EBS, anti-affinity) |
| Storage | Local PVC | S3 (shared, durable) |
| Message Queue | rocksmq (embedded) | Kafka or Pulsar (3+ replicas) |
| PodDisruptionBudget | N/A | minAvailable: 1 per component |

### Migration Checklist (Standalone to Distributed)

1. Update `milvus-operator.yaml`: change `mode: standalone` to `mode: cluster`
2. Add S3 dependency (see above) — data in local PVC must be migrated
3. Add message queue dependency (Kafka/Pulsar)
4. Scale etcd to 3 replicas with gp3 EBS
5. Add PodDisruptionBudgets for each component
6. Update resource requests per component role
7. Run `oc apply` — operator handles the transition

### Cost Considerations

- Standalone on spot instances with EFS etcd is the most cost-effective option
- Distributed mode adds 5-8 pods minimum (proxy, queryNode, dataNode, indexNode, mixCoord, etcd x3, message queue)
- S3 storage cost is negligible for vector data (<$1/month for typical RAG corpora)
- Consider distributed mode when: query latency SLOs require it, data volume exceeds single-node memory, write throughput from concurrent indexers causes contention, or **multiple users cause RPC/connection errors** because standalone’s single query node can’t keep up (scale `queryNode` replicas for read throughput).
