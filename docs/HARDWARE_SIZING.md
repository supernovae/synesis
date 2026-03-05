# Hardware Sizing

This guide covers GPU and CPU requirements for Synesis model deployments. For composable deployment profiles (small/medium/large), see [`models.yaml`](../models.yaml).

## GPU Requirements

The primary GPU-bound workloads are the model serving deployments. Memory bandwidth is the primary driver of token generation speed (decode is memory-bound).

### By Deployment Profile

| Profile | Hardware | Model Distribution |
|---------|----------|-------------------|
| **Small** | 2x L40S (48GB each) | GPU 0: Router + Critic (Qwen3-8B, thinking mode); GPU 1: Coder (FP8) |
| **Medium** | 4x L40S | General on GPU 0; Coder TP=2 on GPUs 1-2; Router + R1 Critic on GPU 3 |
| **Large** | 8x GPU (A100/H100) | All roles dedicated; Coder scales 2-4 replicas on queue depth |

**Small profile note**: The critic uses the same Qwen3-8B model as the router via Qwen3's per-request thinking mode (`enable_thinking=True`). This eliminates the separate R1 deployment, freeing GPU 1 entirely for the Coder. The executor deployment is scaled to 0 replicas.

### GPU Comparison

| GPU | VRAM | Bandwidth | Est. tok/s (single user) | Notes |
|-----|------|-----------|--------------------------|-------|
| **NVIDIA L40S** | 48 GB | 864 GB/s | ~15-25 | Cost-effective. Fits FP8 models up to ~40B params. |
| **NVIDIA A100 80GB SXM** | 80 GB | 2.0 TB/s | ~30-40 | Recommended for large profile. Headroom for concurrent requests. |
| NVIDIA H100 80GB SXM | 80 GB | 3.35 TB/s | ~50-60 | Fastest option. ~1.7x faster decode than A100. |
| NVIDIA A100 40GB | 40 GB | 1.5 TB/s | ~25-35 | Tight fit. May require reduced `--max-model-len`. Not recommended for production. |

### VRAM Estimation by Model

| Role | Default Model | FP8 Weights | KV Cache (32K ctx) | Total Active VRAM |
|------|--------------|-------------|--------------------|--------------------|
| Router | Qwen3-8B | ~8 GB | ~2 GB | ~10 GB |
| General | Qwen3.5-35B-A3B | ~8 GB (MoE active) | ~4 GB | ~14 GB |
| Coder (small) | Qwen3-Coder-30B-A3B-FP8 | ~15 GB | ~4 GB (65K ctx) | ~20 GB |
| Coder (medium+) | Qwen3-Coder-Next-FP8 | ~46 GB (all 512 experts) | ~4 GB (65K ctx) | ~50 GB (TP=2) |
| Critic (small) | Qwen3-8B thinking | shared with Router | shared | ~10 GB (shared) |
| Critic (medium) | R1-Distill-32B | ~32 GB | ~4 GB | ~38 GB |
| Critic (large) | R1-Distill-70B | ~70 GB | ~6 GB | ~78 GB |
| Summarizer | Qwen2.5-0.5B | CPU only | N/A | 0 GPU |

**Coder note**: The small profile uses the 30B-A3B model which fits easily on a single L40S. The 80B Next model requires TP=2 (medium/large) because all 512 expert weights must reside in VRAM despite only 10 being active per token. Even at FP8 (~46GB), it exceeds any single 48GB card.

## CPU Services

Non-model services (planner, RAG, gateway, admin, etc.) run on standard worker nodes:

| Component | CPU Request | Memory | Notes |
|-----------|------------|--------|-------|
| Planner (FastAPI + LangGraph) | 2 cores | 4Gi | Includes FlashRank re-ranker |
| LiteLLM Gateway | 500m | 512Mi | Lightweight proxy |
| Milvus (standalone) | 2 cores | 8Gi | Vector database |
| Embedder | 1 core | 2Gi | Sentence transformer |
| SearXNG | 250m | 256Mi | Meta-search engine |
| LSP Gateway | 1 core | 2Gi | 6-language runtimes |
| Open WebUI | 250m | 512Mi | Chat frontend |
| Admin Dashboard | 100m | 256Mi | Failure patterns |

## Cluster Summary (Production)

| Component | Node Type | Count | Minimum Spec |
|-----------|-----------|-------|--------------|
| **GPU models** | GPU node | 2-4 | Per profile above |
| **Services** | Worker node | 2 | 8 vCPU, 16 GB RAM each |
| **Milvus + Infra** | Worker node | 1 | 4 vCPU, 16 GB RAM |

## Scaling Guidance

- **Horizontal**: Add replicas of the Coder model for concurrent IDE users. HPA can scale on vLLM queue depth.
- **Vertical**: Move from `small` to `medium` or `large` profile for larger models with higher quality.
- **Cost**: See [COST_ESTIMATE.md](COST_ESTIMATE.md) for cloud cost estimates by profile.
- **GPU Topology**: See [GPU_TOPOLOGY.md](GPU_TOPOLOGY.md) for scheduling and affinity configuration.

---

Back to [README](../README.md) | See also: [GPU Topology](GPU_TOPOLOGY.md), [Cost Estimate](COST_ESTIMATE.md)
