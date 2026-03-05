# Synesis V3 Cost Estimates

Cost estimates by deployment profile. All prices are approximate AWS on-demand
rates as of March 2026. Spot pricing can reduce costs by 60-70%.

See `models.yaml` for profile definitions and `scripts/generate-model-configs.sh`
for config generation.

---

## Small Profile (2x L40S)

**Use case**: Solo developer, proof of concept, evaluation.

| Resource | Type | Specification |
|----------|------|---------------|
| Instance | g6e.4xlarge | 2x NVIDIA L40S (48 GB each) |
| vCPU / RAM | 16 vCPU | 128 GB |
| Storage | 200 GB gp3 | Model weights + PVC |

**Model Placement**:

- GPU 0: Router (Qwen3-8B FP8, ~10 GB) + Critic (R1-Distill-32B FP8, ~33 GB, time-shared)
- GPU 1: Coder (Qwen3-Coder-Next Q3, ~40 GB)
- CPU: Summarizer (Qwen2.5-0.5B)
- No dedicated general model (R1/router handle general queries)

**Cost**:

- On-demand: ~$3.50/hr (~$2,520/mo)
- Spot: ~$1.05/hr (~$756/mo)
- Storage: ~$20/mo
- **Total on-demand**: ~$2,540/mo
- **Total spot**: ~$776/mo

**Concurrency**: 2-3 simultaneous users.

---

## Medium Profile (4x L40S)

**Use case**: Team of 5-15 developers, daily use, all roles dedicated.

| Resource | Type | Specification |
|----------|------|---------------|
| Instance | g6e.12xlarge | 4x NVIDIA L40S (48 GB each) |
| vCPU / RAM | 48 vCPU | 384 GB |
| Storage | 500 GB gp3 | Model weights + PVC |

**Model Placement**:

- GPU 0: General/Writer (Qwen3.5-35B-A3B BF16, ~35 GB)
- GPU 1-2: Coder (Qwen3-Coder-Next FP8, ~85 GB, TP=2)
- GPU 3: Router (Qwen3-8B FP8, ~10 GB) + Critic (R1-Distill-32B FP8, ~33 GB)
- CPU: Summarizer (Qwen2.5-0.5B)

**Cost**:

- On-demand: ~$7.00/hr (~$5,040/mo)
- Spot: ~$2.10/hr (~$1,512/mo)
- Storage: ~$50/mo
- **Total on-demand**: ~$5,090/mo
- **Total spot**: ~$1,562/mo

**Concurrency**: 10-15 simultaneous users.

**Alternative**: 2x g6e.4xlarge (2 GPUs each) for multi-node topology.
On-demand: ~$7.00/hr combined. Advantages: independent scaling, fault isolation.

---

## Large Profile (8x GPU)

**Use case**: Organization-wide deployment, 50+ developers, production SLAs.

| Resource | Type | Specification |
|----------|------|---------------|
| Option A | p5.48xlarge | 8x H100 80GB |
| Option B | 4x g6e.4xlarge | 8x L40S 48GB (multi-node) |
| Storage | 1 TB gp3 | Model weights + PVC |

**Model Placement (Option B, multi-node)**:

- Node 1 (2 GPU): General (Qwen3-235B-A22B FP8, ~120 GB, TP=2)
- Node 2 (2 GPU): Coder replica 1 (Qwen3-Coder-Next FP8, TP=2)
- Node 3 (2 GPU): Coder replica 2 (Qwen3-Coder-Next FP8, TP=2) + HPA
- Node 4 (2 GPU): Critic (R1-Distill-70B FP8, TP=2) + Router (Qwen3-8B FP8)

**Cost**:

- Option A (p5.48xlarge) on-demand: ~$98/hr (~$70,560/mo)
- Option B (4x g6e.4xlarge) on-demand: ~$14/hr (~$10,080/mo)
- Option B spot: ~$4.20/hr (~$3,024/mo)
- Storage: ~$100/mo
- **Total Option B on-demand**: ~$10,180/mo
- **Total Option B spot**: ~$3,124/mo

**Concurrency**: 50+ simultaneous users. Coder HPA scales 2-4 replicas.

---

## Scaling Strategy

### Vertical Scaling (Bigger Models)

Upgrade model sizes within a profile using `model_override` in `models.yaml`:

- General: Qwen3.5-35B-A3B -> Qwen3-235B-A22B (requires TP=2)
- Critic: R1-Distill-32B -> R1-Distill-70B (requires TP=2)
- Better quality per request, higher cost per GPU

### Horizontal Scaling (More Replicas)

Scale replicas for throughput without changing models:

- Coder: `replicas: 1` -> `replicas: 2` with HPA (auto-scales on queue depth)
- Router: `replicas: 1` -> `replicas: 2` for routing throughput
- Same model quality, more concurrent capacity

### Recommendation

1. **Start with Small** for evaluation and development
2. **Move to Medium** when team exceeds 3-5 developers or latency matters
3. **Use Large Option B** (multi-node L40S) over Option A (H100) for cost efficiency
4. **Scale horizontally first** (more replicas) before vertically (bigger models)
5. **Use spot instances** for non-production workloads (60-70% savings)

---

## Additional Costs

| Service | Approximate Cost |
|---------|-----------------|
| OpenShift cluster (control plane) | ~$0.17/hr ($122/mo) per cluster |
| Milvus (RAG, single node) | Included in compute |
| S3 (model pipeline artifacts) | ~$5-20/mo |
| EBS gp3 (PVCs) | ~$0.08/GB/mo |
| Data transfer (inter-AZ) | ~$0.01/GB |
| Load balancer | ~$0.025/hr ($18/mo) |

---

*Generated from models.yaml profiles. Update profiles and re-run
`scripts/generate-model-configs.sh --profile=<name>` to regenerate.*
