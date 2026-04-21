# Hardware Sizing

This guide covers GPU and CPU requirements for Synesis model deployments using explicit resource footprints (GPU count, role placement, and replica strategy).

## GPU Requirements

The primary GPU-bound workloads are the model serving deployments. Memory bandwidth is the primary driver of token generation speed (decode is memory-bound).

### Reference Capacity Footprints

| Hardware Footprint | Model Distribution |
|--------------------|-------------------|
| **3x L40S (3x g6e.2xlarge)** | GPU 0: Router + Critic (shared endpoint strategy); GPU 1: General; GPU 2: Coder |
| **4x L40S** | General on GPU 0; Coder TP=2 on GPUs 1-2; Router + dedicated Critic on GPU 3 |
| **8x GPU (A100/H100 class)** | Dedicated role endpoints with horizontal scale on latency-critical roles |

**3x L40S note**: 3× g6e.2xlarge (8 vCPU, 64 GiB RAM, 1× L40S each). On-demand ~$6.72/hr; spot ~$2.73/hr. Shared router/critic placement reduces GPU footprint and can be promoted later to dedicated critic runtime when quality/concurrency requirements increase.

### GPU Comparison

| GPU | VRAM | Bandwidth | Est. tok/s (single user) | Notes |
|-----|------|-----------|--------------------------|-------|
| **NVIDIA L40S** | 48 GB | 864 GB/s | ~15-25 | Cost-effective. Fits FP8 models up to ~40B params. |
| **NVIDIA A100 80GB SXM** | 80 GB | 2.0 TB/s | ~30-40 | Headroom for larger models and concurrent workloads. |
| NVIDIA H100 80GB SXM | 80 GB | 3.35 TB/s | ~50-60 | Fastest option. ~1.7x faster decode than A100. |
| NVIDIA A100 40GB | 40 GB | 1.5 TB/s | ~25-35 | Tight fit. May require reduced `--max-model-len`. Not recommended for production. |

### VRAM Estimation by Model

| Role | Default Model | FP8 Weights | KV Cache (32K ctx) | Total Active VRAM |
|------|--------------|-------------|--------------------|--------------------|
| Router | Qwen2.5-14B-Instruct FP8 | ~14 GB | ~5.5 GB | ~22 GB |
| General (single GPU) | Qwen3-32B FP8-dynamic | ~32 GB | ~4.2 GB | ~38.7 GB |
| Coder (single GPU) | Qwen3-Coder-30B-A3B-FP8 | ~15 GB | ~4 GB (65K ctx) | ~20 GB |
| Coder (TP=2) | Qwen3-Coder-Next-FP8 | ~46 GB (all 512 experts) | ~4 GB (65K ctx) | ~50 GB (TP=2) |
| Critic (shared with router) | Qwen2.5-14B-Instruct FP8 | shared with Router | shared | ~22 GB (shared) |
| Critic (dedicated) | R1-Distill-32B | ~32 GB | ~4 GB | ~38 GB |
| Critic (high-capacity) | R1-Distill-70B | ~70 GB | ~6 GB | ~78 GB |
| Summarizer | Qwen2.5-0.5B | CPU only | N/A | 0 GPU |

**Coder note**: Qwen3-Coder-30B-A3B fits easily on a single L40S. Qwen3-Coder-Next requires TP=2 because all 512 expert weights must reside in VRAM despite only 10 being active per token. Even at FP8 (~46 GB), it exceeds a single 48 GB card.

## CPU Services

Non-model services (planner, RAG, gateway, admin, etc.) run on standard worker nodes:

| Component | CPU Request | Memory | Notes |
|-----------|------------|--------|-------|
| Planner (FastAPI + LangGraph) | 2 cores | 6Gi req / 12Gi limit | One worker per pod by default; scale via replicas for multi-user. See Scaling Guidance. |
| LiteLLM Gateway | 500m | 512Mi | Lightweight proxy |
| Milvus (standalone) | 2 cores | 8Gi | Vector database |
| Embedder | 1 core | 2Gi | Sentence transformer |
| SearXNG | 250m | 256Mi | Meta-search engine |
| Open WebUI | 250m | 512Mi | Chat frontend |
| Admin Dashboard | 100m | 256Mi | Failure patterns |

## Cluster Summary (Production)

| Component | Node Type | Count | Minimum Spec |
|-----------|-----------|-------|--------------|
| **GPU models** | GPU node | 2-4 | Per role placement and model memory footprint |
| **Services** | Worker node | 2 | 8 vCPU, 16 GB RAM each |
| **Milvus + Infra** | Worker node | 1 | 4 vCPU, 16 GB RAM |

## Scaling Guidance

- **Planner (multi-user)**: Time-to-first-token for a single request is unchanged by `WEB_CONCURRENCY` (one request uses one worker). For more concurrent users, scale planner **replicas** (more pods); each pod runs one worker by default to avoid OOM. Raising in-pod concurrency (e.g. 2 workers) uses more memory per pod and only helps when multiple requests hit the same pod.
- **Horizontal**: Add replicas of the Coder model for concurrent IDE users. HPA can scale on vLLM queue depth.
- **Vertical**: Increase GPU memory class or tensor parallelism when moving to larger model families.
- **Cost**: See [COST_ESTIMATE.md](COST_ESTIMATE.md) for cloud cost estimates by resource footprint.
- **GPU Topology**: See [GPU_TOPOLOGY.md](GPU_TOPOLOGY.md) for scheduling and affinity configuration.

---

Back to [README](../README.md) | See also: [GPU Topology](GPU_TOPOLOGY.md), [Cost Estimate](COST_ESTIMATE.md)
