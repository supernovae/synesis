# ROSA HCP GPU Inference Architecture

Target architecture for Synesis on ROSA HCP with OpenShift AI 3.x.

**Deployment:** See [GPU_TOPOLOGY.md](GPU_TOPOLOGY.md) for deploy flow. This doc describes the architecture.

| Instance | GPUs | VRAM | Status |
|----------|------|------|--------|
| **G6e.4xlarge** | 2× L40S | 2× 48 GB (96 GB total) | **Current target** — available on ROSA today |
| **G7e.2xlarge** | 1× RTX 6000 Blackwell | 1× 96 GB | Coming soon — not yet on ROSA |

**Related:** [MODEL_SELECTION.md](MODEL_SELECTION.md), [LORA_TRAINING_GUIDE.md](LORA_TRAINING_GUIDE.md), [WORKFLOW.md](WORKFLOW.md)

---

## G6e.4xlarge (2× L40S, 96 GB total) — Current Target

**Topology:** Single node, 2 GPUs. Executor and Manager each use 1 GPU. Planner co-located for UDS.

| Component | Model | VRAM | GPU |
|-----------|-------|------|-----|
| **Executor** | DeepSeek-R1-Distill-70B **NVFP4** | ~40 GB | GPU 0 (L40S) |
| **Supervisor+Critic** | Qwen3.5-35B-A3B (or 8B) | ~18 GB | GPU 1 (L40S) |
| **Planner** | — | CPU | Same node, UDS to both |

**Why NVFP4 for Executor:** FP8 Executor (~70 GB) does not fit on a single 48 GB L40S. NVFP4 (~40 GB) fits, leaving Manager on the other GPU. Both models run concurrently with headroom.

**UDS:** Shared node-local PVC for vLLM sockets; Planner mounts same volume. Lowest latency, no TCP.

---

## G7e.2xlarge (1× Blackwell 96 GB) — Coming Soon (not yet on ROSA)

| Component | Model | VRAM | Strategy |
|-----------|-------|------|----------|
| **Executor** | DeepSeek-R1-Distill-70B FP8 or NVFP4 | ~70 GB / ~40 GB | Single GPU, tp=1 |
| **Supervisor+Critic** | Qwen3.5-35B-A3B | ~18 GB | Same node or MIG slice |
| **KV Cache** | — | ~25 GB | Shared working memory |
| **System / CUDA** | Blackwell kernels | ~5 GB | FP4/FP8 acceleration |

**Single 96 GB:** FP8 Executor + Supervisor+Critic fits (tight). NVFP4 leaves ~38 GB headroom.

**MIG (Blackwell only):** RTX 6000 supports MIG. L40S does not. When G7e is available, MIG slices can isolate Executor and Supervisor+Critic. See [MODEL_SELECTION.md](MODEL_SELECTION.md).

---

## Model IDs

| Role | Model | HuggingFace / OCI | VRAM | G6e (2×48GB) | G7e (1×96GB) |
|------|-------|-------------------|------|--------------|--------------|
| **Executor (G6e)** | DeepSeek-R1-Distill-70B NVFP4 | Pipeline: llm-compressor → ModelCar | ~40 GB | ✅ GPU 0 | ✅ |
| **Executor (G7e)** | DeepSeek-R1-Distill-70B FP8 | `nm-testing/DeepSeek-R1-Distill-Llama-70B-FP8-Dynamic` | ~70 GB | ❌ (needs tp=2) | ✅ tp=1 |
| **Supervisor+Critic** | Qwen3.5-35B-A3B (text) | `nightmedia/Qwen3.5-35B-A3B-Text` | ~18 GB | ✅ GPU 1 | ✅ |
| **Supervisor / Planner / Critic** | Same model | prompts + params | — | No LoRA needed |

**G6e:** NVFP4 Executor required (FP8 won't fit single 48GB). Use NVFP4 pipeline. **G7e:** FP8 or NVFP4, tp=1.

---

## Planner–vLLM Co-location (Option B)

**Choice:** Separate pods, shared **node-local PVC** for UDS. Planner and vLLM run on the same node with pod affinity.

**Rationale:**

- Operational flexibility: restart Planner without touching vLLM.
- Node-local PVC: fast, no network storage.
- Avoids hostPath and privileged SCC.
- UDS socket in shared volume (`/tmp/vllm`) for low-latency IPC.

**Topology:**

```
Node (GPU)
├── vLLM Executor pod
│   ├── volumeMount: vllm-sockets (node-local PVC)
│   └── listens on unix:///tmp/vllm/executor.sock
├── vLLM Manager pod
│   ├── volumeMount: vllm-sockets (node-local PVC)
│   └── listens on unix:///tmp/vllm/manager.sock
└── Planner pod (synesis-planner-gpu-0)
    ├── volumeMount: vllm-sockets (same PVC)
    ├── tolerates: GPU taint
    └── connects via UDS to local vLLM
```

**Pod affinity:** Planner must schedule on the same node as the vLLM it uses. Use `podAffinity` or `nodeSelector` + GPU node pool.

---

## Logical Naming and Scaling

### Naming

- **Planners:** `synesis-planner-gpu-0`, `synesis-planner-gpu-1`, … (one per GPU node).
- **vLLM services:** `synesis-vllm-executor-gpu-0`, `synesis-vllm-manager-gpu-0`, or equivalent.
- Names encode GPU/node attachment for ops and debugging.

### Load Balancing

- Ingress/LoadBalancer fronts Planner instances.
- **Session affinity** or **consistent hashing** so a session sticks to one Planner.
- Planner always talks to the vLLM on its own node (UDS).

### Scaling Modes

| Mode | Use case |
|------|----------|
| **Per-customer** | Dedicated Planner+GPU per tenant. `synesis-planner-tenant-acme`. |
| **Per-workload** | Different Planner configs (strict vs. relaxed) for different queues. |
| **N+1 for HA** | Multiple Planners per GPU for availability. One primary; others standby or load-shared. |
| **Horizontal** | Add GPU node → add Planner → scales capacity. |

---

## UDS and HTTP Support

- **Primary:** UDS for Planner ↔ vLLM when co-located. Lowest latency.
- **Fallback:** HTTP for remote vLLM or debugging. Planner detects capability and chooses.
- **Streaming:** Disable buffering in HAProxy/proxies. Small token chunks must reach the client for status updates.

---

## vLLM Configuration

- **Source:** Upstream vLLM (vllm/vllm-openai or vendor image), not community forks. Multi-LoRA support (0.15+).
- **Speculative decoding:** Draft model in same vLLM process where supported.
- **Models:** Served from ModelCar images in ECR. No HF/S3 pulls at runtime.

### Executor model compatibility

| Executor model | `SYNESIS_EXECUTOR_THINKING_PARAM` | Notes |
|----------------|-----------------------------------|------|
| Qwen3-Coder | `enable_thinking` (default) | Thinking mode for complex tasks |
| DeepSeek-Coder-V2 | `""` (empty) | No thinking mode; code model only |
| DeepSeek-V3 (reasoning) | `thinking` | If using V3 for executor |

When using DeepSeek-Coder-V2 as executor, set `SYNESIS_EXECUTOR_THINKING_PARAM=""` so the Worker does not pass unsupported thinking params. The validator (JSON extraction/repair) is model-agnostic.

---

## Implementation Checklist

- [ ] **G6e:** Run NVFP4 pipeline for Executor; mirror Manager to ECR (`scripts/mirror-models-to-ecr.sh`).
- [ ] **G7e:** Mirror both Executor (FP8) + Manager (`scripts/mirror-models-to-ecr.sh`).
- [x] **UDS:** hostPath `/var/lib/synesis/vllm-sockets` shared by planner + vLLM pods. socat sidecars forward UDS→TCP. See [UDS_SETUP.md](UDS_SETUP.md).
- [ ] Deploy vLLM Executor + Supervisor-Critic (`base/model-serving/deployment-vllm-*.yaml`). Use `./scripts/deploy.sh dev`.
- [x] Planner deploys with `deploy.sh`; nodeSelector + tolerations for GPU co-location.
- [x] Configure Planner: `*_MODEL_UDS` set in base deployment for UDS.
- [ ] Disable proxy buffering for streaming (see [STREAMING_BUFFERING.md](STREAMING_BUFFERING.md)).
