# Synesis V3 Cost Estimates

Cost estimates by explicit resource footprint. All prices are approximate AWS on-demand
rates as of March 2026. Spot pricing can reduce costs by 60-70%.

---

## 3x L40S Footprint

**Use case**: Multi-user small team, evaluation.

| Resource | Type | Specification |
|----------|------|---------------|
| Instance | 3x g6e.2xlarge | 3x NVIDIA L40S (48 GB each) |
| vCPU / RAM | 24 vCPU | 192 GB |
| Storage | 200 GB gp3 | Model weights + PVC |

**Model Placement**:

- GPU 0: Router (Qwen2.5-14B, ~14 GB) + Critic (R1-Distill-Qwen-32B FP8, ~33 GB, time-shared)
- GPU 1: General (Qwen3-32B FP8, ~33 GB)
- GPU 2: Coder (Qwen3-Coder-30B-A3B FP8, ~40 GB)
- CPU: Summarizer (Qwen2.5-0.5B)

**Cost**:

- On-demand: ~$3.50/hr (~$2,520/mo)
- Spot: ~$1.05/hr (~$756/mo)
- Storage: ~$20/mo
- **Total on-demand**: ~$2,540/mo
- **Total spot**: ~$776/mo

**Concurrency**: 2-3 simultaneous users.

---

## 4x L40S Footprint

**Use case**: Team of 5-15 developers, daily use, all roles dedicated.

| Resource | Type | Specification |
|----------|------|---------------|
| Instance | g6e.12xlarge | 4x NVIDIA L40S (48 GB each) |
| vCPU / RAM | 48 vCPU | 384 GB |
| Storage | 500 GB gp3 | Model weights + PVC |

**Model Placement**:

- GPU 0: General/Writer (Qwen3-32B FP8, ~33 GB)
- GPU 1-2: Coder (Qwen3-Coder-30B-A3B FP8, TP=2)
- GPU 3: Router (Qwen2.5-14B, ~14 GB) + Critic (R1-Distill-Qwen-32B FP8, ~33 GB)
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

## 8x GPU Footprint

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
- Node 4 (2 GPU): Critic (R1-Distill-70B FP8, TP=2) + Router (Qwen2.5-14B)

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

Upgrade model sizes by adjusting runtime assignments and deployment specs:

- General: Qwen3-32B -> Qwen3-235B-A22B (requires TP=2)
- Critic: R1-Distill-32B -> R1-Distill-70B (requires TP=2)
- Better quality per request, higher cost per GPU

### Horizontal Scaling (More Replicas)

Scale replicas for throughput without changing models:

- Coder: `replicas: 1` -> `replicas: 2` with HPA (auto-scales on queue depth)
- Router: `replicas: 1` -> `replicas: 2` for routing throughput
- Same model quality, more concurrent capacity

### Recommendation

1. **Start with 3x L40S** for evaluation and development
2. **Move to 4x L40S** when team size and latency requirements increase
3. **Use multi-node L40S footprints** over H100 for cost efficiency unless you need top-end throughput
4. **Scale horizontally first** (more replicas) before vertically (bigger models)
5. **Use spot instances** for non-production workloads (60-70% savings)

---

## Additional Costs

| Service | Approximate Cost |
|---------|-----------------|
| OpenShift cluster (control plane) | ~$0.17/hr ($122/mo) per cluster |
| Milvus (RAG, single node) | Included in compute |
| S3 (model pipeline artifacts) | ~$5-20/mo |
| EFS (shared model storage) | ~$0.30/GB/mo (pay for actual usage) |
| Data transfer (inter-AZ) | ~$0.01/GB |
| Load balancer | ~$0.025/hr ($18/mo) |

---

## ROSA HCP Deployment Costs

The following section provides detailed cost breakdowns for running Synesis on
**Red Hat OpenShift Service on AWS with Hosted Control Planes (ROSA HCP)**.
All prices are on-demand in **us-east-1** as of February 2026. Reserved
instances and Spot pricing can reduce costs significantly.

### ROSA HCP Service Fees

ROSA HCP billing has two components billed through AWS Marketplace:

| Component | Rate | Notes |
|-----------|------|-------|
| **Cluster control plane** | $0.25/hr | Managed by Red Hat. No EC2 instances to manage. |
| **Worker node service fee** | $0.171/hr per 4 vCPU | Metered per worker node based on vCPU count. |

The control plane fee is fixed regardless of cluster size. Worker fees scale
with the number and size of nodes.

**Commitment discounts** are available:

| Term | Discount |
|------|----------|
| On-demand | Full price |
| 1-year commitment | ~33% off worker fees |
| 3-year commitment | ~55% off worker fees |

### GPU Tier Comparison

| GPU Instance | GPU | VRAM | Inference Speed | EC2 $/hr | Effective $/mo | Recommendation |
|-------------|-----|------|-----------------|----------|----------------|----------------|
| **g6e.4xlarge** | 1x L40S | 48 GB | ~15-25 tok/s | $3.00 | $2,193 | **Best value for Synesis.** Fits the 48GB budget perfectly. |
| g6e.12xlarge | 4x L40S | 192 GB | ~15-25 tok/s | $10.49 | $7,660 | Overkill unless running multiple models. |
| g5.12xlarge | 4x A10G | 96 GB | ~10-18 tok/s | $5.67 | $4,139 | Cheaper multi-GPU but A10G is slower than L40S. |
| p4d.24xlarge | 8x A100 40GB | 320 GB | ~30-40 tok/s | $32.77 | $23,922 | Fast but massively over-provisioned for 1 model. |
| p5.48xlarge | 8x H100 80GB | 640 GB | ~50-60 tok/s | $98.32 | $71,774 | Fastest. Only for large-scale production. |

### Cost by Usage Pattern

| Pattern | Hours/Month | GPU $/mo | Total $/mo (On-Demand) |
|---------|------------|----------|------------------------|
| **Always-on** (24/7) | 730 | $2,193 | ~$4,822 |
| **Business hours** (10hr x 22 days) | 220 | $661 | ~$2,449 |
| **Dev/testing** (8hr x 5 days) | 160 | $481 | ~$2,123 |

### Purchasing Red Hat OpenShift AI

Red Hat OpenShift AI (RHOAI) can provide integrated model serving infrastructure
(KServe, vLLM runtimes, model registry) for Synesis deployments on OpenShift.

- **AWS Marketplace** (recommended for ROSA): Search for "Red Hat OpenShift AI"
  in the AWS Marketplace console. Pay-as-you-go billing appears on your
  consolidated AWS bill.
- **Red Hat Hybrid Cloud Console**: Enable the OpenShift AI add-on for your
  ROSA cluster at [console.redhat.com](https://console.redhat.com).
- **Red Hat Sales / Partner**: Contact your Red Hat account manager for
  enterprise agreements and volume discounts.

OpenShift AI is included in **OpenShift Platform Plus** subscriptions at no
additional cost.

### Cost Optimization Tips

1. **Start with g6e instances**: The L40S provides the best $/VRAM ratio for Synesis.
2. **Use cluster autoscaler**: Scale GPU nodes to zero when not in use.
3. **Reserved Instances**: Commit to 1-year pricing for ~34% savings on EC2.
4. **Spot Instances**: Use for non-GPU workloads (~75% savings).
5. **Right-size the default pool**: 3 nodes suffice for dev/test.
6. **Disable optional components**: SearXNG, Admin, Warm Pool can
   be disabled to reduce CPU requirements.

*Prices are on-demand in us-east-1 as of February 2026. Verify current rates at
[aws.amazon.com/rosa/pricing](https://aws.amazon.com/rosa/pricing/) and
[aws.amazon.com/ec2/pricing](https://aws.amazon.com/ec2/pricing/on-demand/).*
