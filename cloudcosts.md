# Synesis Cloud Costs on ROSA HCP (AWS)

This document estimates the monthly cost to run Synesis on **Red Hat OpenShift Service on AWS with Hosted Control Planes (ROSA HCP)**. All prices are on-demand in **us-east-1** as of February 2026. Reserved instances and Spot pricing can reduce costs significantly.

---

## ROSA HCP Service Fees

ROSA HCP billing has two components billed through AWS Marketplace:

| Component | Rate | Notes |
|-----------|------|-------|
| **Cluster control plane** | $0.25/hr | Managed by Red Hat. No EC2 instances to manage. |
| **Worker node service fee** | $0.171/hr per 4 vCPU | Metered per worker node based on vCPU count. |

The control plane fee is fixed regardless of cluster size. Worker fees scale with the number and size of nodes.

**Commitment discounts** are available:

| Term | Discount |
|------|----------|
| On-demand | Full price |
| 1-year commitment | ~33% off worker fees |
| 3-year commitment | ~55% off worker fees |

---

## Reference Architecture

The Synesis reference deployment uses three node pools:

| Pool | Instance Type | Count | Purpose |
|------|--------------|-------|---------|
| **Default** | m6i.xlarge (4 vCPU, 16 GiB) | 5 | Platform, logging, observability, Milvus, planner, gateway, SearXNG, admin |
| **GPU** | g6e.4xlarge (1x L40S 48GB, 16 vCPU, 128 GiB) | 1 | Qwen2.5-Coder-32B FP8 via vLLM |
| **CPU-Inference** | m6i.2xlarge (8 vCPU, 32 GiB) | 1 | Mistral Nemo 12B FP8 supervisor model (CPU-only vLLM) |

---

## Cost Breakdown: Affordable Tier (L40S)

The L40S on g6e instances offers the best cost-per-VRAM ratio for the 48GB requirement.

### Monthly Costs (730 hours)

| Line Item | Hourly | Monthly | Notes |
|-----------|--------|---------|-------|
| **ROSA HCP Control Plane** | $0.25 | **$182.50** | Fixed per cluster |
| **ROSA Worker Fee (5x m6i.xlarge)** | 5 × $0.171 = $0.855 | **$624.15** | 5 nodes × 4 vCPU each |
| **ROSA Worker Fee (1x g6e.4xlarge)** | $0.684 | **$499.32** | 16 vCPU ÷ 4 × $0.171 |
| **ROSA Worker Fee (1x m6i.2xlarge)** | $0.342 | **$249.66** | 8 vCPU ÷ 4 × $0.171 |
| **EC2: 5x m6i.xlarge** | 5 × $0.192 = $0.96 | **$700.80** | General-purpose workers |
| **EC2: 1x g6e.4xlarge** | $3.004 | **$2,193.10** | 1x NVIDIA L40S (48GB) |
| **EC2: 1x m6i.2xlarge** | $0.384 | **$280.32** | CPU inference node |
| **EBS Storage** | ~$0.11 | **~$80** | ~1 TB gp3 across nodes |
| **S3 Model Storage** | -- | **$0** | Not required — RHOAI 3 uses Model Hub / HuggingFace directly |
| **Data Transfer** | -- | **~$10** | Internal mostly; minimal egress |
| | | | |
| **Total (On-Demand)** | **$6.59/hr** | **~$4,822/mo** | |

### With 1-Year Commitment

| Adjustment | Monthly Savings |
|------------|----------------|
| ROSA worker fees (–33%) | –$453 |
| EC2 reserved instances (–34%) | –$1,079 |
| **Total (1-Year Reserved)** | **~$3,290/mo** |

### With 3-Year Commitment

| Adjustment | Monthly Savings |
|------------|----------------|
| ROSA worker fees (–55%) | –$756 |
| EC2 reserved instances (–55%) | –$1,746 |
| **Total (3-Year Reserved)** | **~$2,320/mo** |

---

## Cost Breakdown: Performance Tier (A100 80GB)

For production workloads needing faster inference (~30-40 tok/s vs ~15-25 on L40S).

| Line Item | Hourly | Monthly | Notes |
|-----------|--------|---------|-------|
| **ROSA HCP Control Plane** | $0.25 | **$182.50** | Fixed |
| **ROSA Worker Fees (all nodes)** | $1.881 | **$1,373.13** | Same node count |
| **EC2: 5x m6i.xlarge** | $0.96 | **$700.80** | Same |
| **EC2: 1x p4d.24xlarge** | $32.77 | **$23,922.10** | 8x A100 40GB (overkill for 1 model) |
| **EC2: 1x m6i.2xlarge** | $0.384 | **$280.32** | Same |
| **Storage + Transfer** | -- | **~$92** | Same |
| | | | |
| **Total (On-Demand)** | **$36.25/hr** | **~$26,551/mo** | |

> **Important**: The p4d.24xlarge bundles 8x A100 GPUs. Synesis only needs 1 GPU. This is the fundamental cost challenge with A100 on AWS -- there is no single-A100 instance type. For production A100 workloads, consider:
>
> - **Multi-tenancy**: Run multiple vLLM instances on the same p4d node
> - **Capacity reservations**: Share the node across teams
> - **Bare-metal alternatives**: Providers like CoreWeave, Lambda, or on-prem offer single-A100 options at ~$2-3/hr

### Realistic A100 Cost with Multi-Tenancy

If you share the p4d.24xlarge across 4 teams/workloads, the effective Synesis cost drops to approximately **~$7,600/mo** on-demand.

---

## GPU Tier Comparison

| GPU Instance | GPU | VRAM | Inference Speed | EC2 $/hr | Effective $/mo | Recommendation |
|-------------|-----|------|-----------------|----------|----------------|----------------|
| **g6e.4xlarge** | 1x L40S | 48 GB | ~15-25 tok/s | $3.00 | $2,193 | **Best value for Synesis.** Fits the 48GB budget perfectly. |
| g6e.12xlarge | 4x L40S | 192 GB | ~15-25 tok/s | $10.49 | $7,660 | Overkill unless running multiple models. |
| g5.12xlarge | 4x A10G | 96 GB | ~10-18 tok/s | $5.67 | $4,139 | Cheaper multi-GPU but A10G is slower than L40S. |
| p4d.24xlarge | 8x A100 40GB | 320 GB | ~30-40 tok/s | $32.77 | $23,922 | Fast but massively over-provisioned for 1 model. |
| p5.48xlarge | 8x H100 80GB | 640 GB | ~50-60 tok/s | $98.32 | $71,774 | Fastest. Only for large-scale production. |

**Recommendation**: Start with **g6e.4xlarge** (1x L40S, $3/hr). It fits Qwen2.5-Coder-32B FP8 within its 48GB VRAM and provides acceptable inference speed for development and small-team production. Scale to multi-GPU or A100 when concurrent user demand justifies it.

---

## Cost by Usage Pattern

Not every deployment runs 24/7. Here are estimates for different usage patterns:

| Pattern | Hours/Month | GPU $/mo | Total $/mo (On-Demand) |
|---------|------------|----------|------------------------|
| **Always-on** (24/7) | 730 | $2,193 | ~$4,822 |
| **Business hours** (10hr × 22 days) | 220 | $661 | ~$2,449 |
| **Dev/testing** (8hr × 5 days) | 160 | $481 | ~$2,123 |

For non-production environments, shut down the GPU node outside business hours using cluster autoscaler or scheduled scaling. The platform nodes (m6i.xlarge) can remain running at ~$2/hr total.

---

## Purchasing Red Hat OpenShift AI

Red Hat OpenShift AI (RHOAI) provides the model serving infrastructure (KServe, vLLM runtimes, model registry) that Synesis relies on. There are several ways to purchase it:

### Option 1: AWS Marketplace (Recommended for ROSA)

The simplest path for ROSA HCP clusters:

1. Open the [AWS Marketplace Console](https://console.aws.amazon.com/marketplace)
2. Search for **"Red Hat OpenShift AI"**
3. Select the appropriate listing:
   - **Red Hat OpenShift AI** (self-managed) -- you manage the RHOAI operator on your ROSA cluster
   - **Managed Red Hat OpenShift AI on AWS** -- fully managed deployment with support
4. Click **View purchase options** and complete the subscription
5. Costs appear on your consolidated AWS bill alongside ROSA and EC2 charges

AWS Marketplace subscriptions support **pay-as-you-go** billing, making it easy to start without upfront commitments.

### Option 2: Red Hat Hybrid Cloud Console

If you already have a Red Hat subscription:

1. Log in to [console.redhat.com](https://console.redhat.com)
2. Navigate to **OpenShift** > **Add-ons**
3. Enable the **OpenShift AI** add-on for your ROSA cluster
4. The operator installs automatically

This option uses your existing Red Hat contract terms.

### Option 3: Red Hat Sales / Partner

For enterprise agreements with custom pricing:

- Contact your Red Hat account manager
- Request a **private offer** through AWS Marketplace for volume discounts
- Bundle with other Red Hat products (OpenShift Platform Plus, Ansible, etc.)

### OpenShift AI Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| Worker nodes | 2 | 5+ |
| CPU per worker | 8 vCPU | 16 vCPU |
| RAM per worker | 32 GiB | 64 GiB |
| GPU nodes | 0 (CPU inference) | 1+ with NVIDIA GPU |
| NVIDIA GPU Operator | Required for GPU nodes | Install via OperatorHub |

OpenShift AI is included in **OpenShift Platform Plus** subscriptions at no additional cost. For standalone ROSA clusters, it is an add-on subscription.

---

## Cost Optimization Tips

1. **Start with g6e.4xlarge**: The L40S provides the best $/VRAM ratio for Synesis's 48GB requirement.

2. **Use cluster autoscaler**: Scale GPU nodes to zero when not in use. The ROSA HCP control plane fee ($182/mo) is fixed regardless.

3. **Reserved Instances**: If running 24/7, commit to 1-year reserved pricing for 34% savings on EC2.

4. **Spot Instances for non-GPU workloads**: The default m6i.xlarge pool can use Spot instances at ~$0.05/hr (75% savings). GPU Spot is risky due to interruptions during inference.

5. **Right-size the default pool**: 5x m6i.xlarge provides comfortable headroom. For minimal deployments (dev/test), 3 nodes may suffice.

6. **Disable optional components**: SearXNG, LSP Gateway, Admin Dashboard, and Warm Pool can all be disabled to reduce CPU requirements.

7. **Share GPU nodes**: A p4d.24xlarge running 8x A100 can host Synesis alongside other ML workloads, amortizing the cost.

---

## Quick Reference

| Metric | Affordable Tier | Performance Tier |
|--------|----------------|-----------------|
| GPU | 1x L40S (48GB) | 1x A100 80GB |
| Inference speed | ~15-25 tok/s | ~30-40 tok/s |
| EC2 instance | g6e.4xlarge | p4d.24xlarge (shared) |
| Monthly cost (on-demand) | **~$4,822** | **~$26,551** |
| Monthly cost (1-yr reserved) | **~$3,290** | ~$17,500 |
| Monthly cost (3-yr reserved) | **~$2,320** | ~$12,000 |
| Hourly cost (all-in) | **$6.59/hr** | $36.25/hr |

All estimates include ROSA HCP fees, EC2 compute, storage, and transfer. They do not include Red Hat OpenShift AI subscription costs (varies by contract).

---

*Prices are on-demand in us-east-1 as of February 2026. Verify current rates at [aws.amazon.com/rosa/pricing](https://aws.amazon.com/rosa/pricing/) and [aws.amazon.com/ec2/pricing](https://aws.amazon.com/ec2/pricing/on-demand/).*
