# Model Selection for ROSA GPU (G6e / G7e)

Analysis for Synesis on ROSA HCP. **G6e.4xlarge** (2× L40S, 96 GB total) is the current target; **G7e.2xlarge** (1× Blackwell 96 GB) when available. Compares **Qwen3.5-35B-A3B (Manager)** + **DeepSeek-R1-Distill-70B (Executor)**.

---

## Quick Fit Summary

| Model | Role | VRAM | G6e (2×48GB) | G7e (1×96GB) | Notes |
|-------|------|------|--------------|--------------|-------|
| **DeepSeek-R1-Distill-70B NVFP4** | Executor | ~40 GB | ✅ GPU 0 | ✅ | **G6e default**; pre-quantize via pipeline |
| **DeepSeek-R1-Distill-70B FP8** | Executor | ~70 GB | ❌ | ✅ | Needs single 96 GB; G7e option |
| **Qwen3.5-35B-A3B** | Manager | ~18 GB (A3B) | ✅ GPU 1 | ✅ | Current; mirrors from HF |
| **Qwen3.5-27B Dense** | Manager | 14–18 GB | ✅ | ✅ | No MoE jitter; structured output |
| **DeepSeek-V3.2 NVFP4** | Executor | 391 GB | ❌ | ❌ | 2× GB300 |
| **GLM-4-32B** | Manager/Executor | ~16–20 GB 4-bit | ✅ | ✅ | Reasoning-trained |

---

## Manager: Qwen3.5-27B Dense

**Recommendation: Use Qwen3.5-27B Dense for Manager.**

- **Dense:** No MoE routing → no jitter, predictable structured output (Supervisor/Critic JSON).
- **Context:** 262K native, ~1M with YaRN.
- **Performance:** IFEval 95.0, SWE-bench 72.4, LiveCodeBench 80.7.
- **Size:** BF16 ~54 GB; 4-bit ~14 GB → fits comfortably on 96 GB.
- **License:** Apache 2.0.

Better choice than Qwen3.5-35B-A3B (MoE) for structured feedback roles where consistency matters.

---

## Executor: Single GPU Default

### DeepSeek-R1-Distill-70B (default for 96 GB)

- **Params:** 70B dense (Llama-based).
- **VRAM:** FP8 ~70 GB; NVFP4 ~40 GB (pre-quantize with llm-compressor).
- **Fits:** Single 96 GB GPU with `--tensor-parallel-size=1`.
- **Model:** `nm-testing/DeepSeek-R1-Distill-Llama-70B-FP8-Dynamic` (FP8) or base `deepseek-ai/DeepSeek-R1-Distill-Llama-70B` for NVFP4 pipeline.
- **Thinking mode:** `SYNESIS_EXECUTOR_THINKING_PARAM=thinking`; R1 has reasoning/thinking support.
- **vLLM:** `--tensor-parallel-size=1`, `--model=/mnt/models`, `--trust-remote-code`.

### NVFP4 for maximum Blackwell efficiency

No pre-quantized NVFP4 for 70B Distill exists on HuggingFace. To use NVFP4:

1. Install [llm-compressor](https://docs.vllm.ai/projects/llm-compressor/) and run NVFP4 quantization on `deepseek-ai/DeepSeek-R1-Distill-Llama-70B`.
2. Save the compressed model to disk.
3. Build ModelCar image from that directory and mirror to ECR.
4. Serve with vLLM; ~40 GB VRAM, optimal on Blackwell.

---

## OpenShift AI: Staging NVFP4 via LLM Compressor

**Can we run NVFP4 quantization in OpenShift AI as part of the model tooling?**

**Yes.** OpenShift AI integrates [LLM Compressor](https://docs.redhat.com/en/documentation/red_hat_ai_inference_server/3.1/html-single/llm_compressor/index) for model optimization. The pipeline flow:

1. **Model download** → HuggingFace or S3
2. **Quantization** → LLM Compressor (AWQ, GPTQ, FP8, and in newer releases NVFP4)
3. **Validation** → lm_eval, GuideLLM
4. **ModelCar packaging** → OCI container
5. **Registry push** → ECR, Quay, or internal registry
6. **Deploy** → vLLM on OpenShift AI

Red Hat’s LLM Compressor docs currently highlight AWQ, GPTQ, FP8; [NVFP4 is supported](https://developers.redhat.com/articles/2026/02/04/accelerating-large-language-models-nvfp4-quantization) in llm-compressor and in OpenShift AI examples. To stage your own NVFP4 models, either:

- Use the [Red Hat AI Examples](https://github.com/red-hat-data-services/red-hat-ai-examples/tree/main/examples/llmcompressor) and extend the data science pipeline with an NVFP4 `QuantizationModifier` step, or  
- Run a custom Kubeflow / Pipeline job that calls llm-compressor with `scheme="NVFP4"` and pushes the result to your model registry.

Models are downloaded to PVC; deployments load from PV directly (no OCI/ECR build).

**Note:** LLM Compressor in OpenShift AI is currently Developer Preview.

---

## G6e (2× L40S): NVFP4 Required for Executor

**FP8 Executor (~70 GB) does not fit on a single 48 GB L40S.** Use NVFP4 pipeline for Executor; Manager via mirror script.

| Strategy | Executor | Manager | Result |
|----------|----------|---------|--------|
| **NVFP4 (recommended)** | ~40 GB on GPU 0 | ~18 GB on GPU 1 | ✅ Both fit, concurrent |
| **FP8 tp=2** | ~35 GB/GPU, both GPUs | No GPU left | ❌ Manager needs another node |
| **FP8 single GPU** | 70 GB | — | ❌ Won't fit 48 GB |

## G7e (1× Blackwell 96 GB): FP8 or NVFP4

With NVFP4, a single 96 GB GPU can host both (or use MIG when available):

| Component | FP8 | NVFP4 | Notes |
|-----------|-----|-------|------|
| Executor (R1-Distill-70B) | ~70 GB | ~40 GB | NVFP4 saves ~30 GB |
| Manager (Qwen3.5-35B-A3B) | ~18 GB | ~18 GB | Same |
| **Total** | ~88 GB | ~58 GB | NVFP4 leaves ~38 GB headroom |
| **Fits 96 GB?** | Tight | ✅ | |

---

## GLM alternatives (GLM-4, GLM-4.7, GLM-5)

If you prefer Zhipu GLM models:

| Model | Params | VRAM (approx) | Fits 96 GB? | Notes |
|-------|--------|----------------|-------------|-------|
| **GLM-4-9B** | 9B dense | ~9 GB BF16 / ~2 GB int4 | ✅ | Small; good for Manager or lightweight Executor |
| **GLM-4-32B** | 32B dense | ~64 GB BF16 / ~16–20 GB 4-bit | ✅ | Reasoning-trained; comparable to larger models on benchmarks |
| **GLM-4.7** | 355B MoE, 32B active | FP8 80% less → still large | ❌ | Needs multi-GPU |
| **GLM-5** | 744B MoE, 40B active | Very large | ❌ | Multi-GPU only |

**Recommendation for single 96 GB:** GLM-4-32B (4-bit or FP8) fits comfortably and has strong reasoning. Use for both Manager and Executor if you want a GLM stack. GLM-4-9B is an option if you need maximum headroom or multiple model instances. GLM-5 and GLM-4.7 are too large for single 96 GB; stick with GLM-4 family.

**How many GPUs do you need?**

| Model | Quantization | Min GPUs | Example |
|-------|--------------|----------|---------|
| DeepSeek-R1-Distill-70B | FP8 | 1× 96 GB | RTX 6000, H100 |
| DeepSeek-R1-Distill-70B | NVFP4 | 1× 96 GB | Pre-quantize; Blackwell-optimal |
| DeepSeek-V3.2 | NVFP4 | 2× GB300 (288 GB) | `-tp 2` |
| DeepSeek-Coder-V2 | FP8 | 4× H100 (80 GB) | `-tp 4` |

### DeepSeek-V3.2 (reasoning, agentic)

- **Params:** 671B total, 37B active.
- **VRAM:** NVFP4 ≈ **391 GB** → needs **2× GB300** (or 2× high-end GPUs).
- **Config:** `vllm serve nvidia/DeepSeek-V3.2-NVFP4 -tp 2`
- **vLLM:** `--reasoning-parser deepseek_v3`, `--tokenizer-mode deepseek_v32`.

### DeepSeek-Coder-V2 (code-focused)

- **Params:** 236B total, 21B active.
- **VRAM:** FP8 ~320 GB total → needs **4× H100** (80 GB each).
- **Model:** `RedHatAI/DeepSeek-Coder-V2-Instruct-FP8`.

---

## Proposed Stack for Single 96 GB

| Role | Model | VRAM | Rationale |
|------|-------|------|------------|
| **Manager** | Qwen3.5-27B Dense or Qwen3.5-35B-A3B | ~14–18 GB | Dense preferred: no MoE jitter; structured output |
| **Executor** | DeepSeek-R1-Distill-70B (FP8) | ~70 GB | Reasoning/code; tp=1; fits 96 GB |
| **Reserve** | KV cache, system | ~8–20 GB | Long-context, routing, UDS |

Manager + Executor fit within 96 GB. For Executor NVFP4 (~40 GB), pre-quantize per above.

---

## Proposed Stack for Multi-GPU (2× 96 GB or 2× GB300)

| Role | Model | VRAM | Rationale |
|------|-------|------|------------|
| **Manager** | Qwen3.5-27B Dense | ~14–18 GB | Dense, no jitter; structured output |
| **Executor** | DeepSeek-V3.2 NVFP4 | 391 GB (2× GPUs) | Best reasoning/agentic; path to V4 |
| **Config** | `vllm serve nvidia/DeepSeek-V3.2-NVFP4 -tp 2` | | TP=2 across 2 GPUs |

Or, with 4× H100 / 4× 80 GB:

- **Executor:** DeepSeek-Coder-V2-Instruct-FP8 (`RedHatAI/DeepSeek-Coder-V2-Instruct-FP8`).

---

## DeepSeek Variants (V2.3, V2.5, V4)

- **V2.3:** No public release; you may mean V2.5 or V3.2.
- **V2.5:** 236B, 4-bit 136 GB — does not fit single 96 GB.
- **V4 Coder (upcoming):** If it fits 96 GB, could be Executor. Watch for specs.

---

## Config Updates When Switching Models

**DeepSeek-R1-Distill-70B (default Executor):**

- Mirror script: `nm-testing/DeepSeek-R1-Distill-Llama-70B-FP8-Dynamic` (or base for NVFP4 pipeline).
- For NVFP4: use OpenShift AI LLM Compressor pipeline (see § OpenShift AI: Staging NVFP4).
- `SYNESIS_EXECUTOR_THINKING_PARAM=thinking` (R1 has thinking mode).
- vLLM: `--tensor-parallel-size=1`, `--trust-remote-code`.

**Qwen3.5-27B Dense for Manager:**

- Mirror script: use `Qwen/Qwen3.5-27B` (or official quantized variant).
- Manager deployment: update model path and `served-model-name`.
- Planner: no change (prompts/params already model-agnostic).

**DeepSeek-V3.2 for Executor (multi-GPU):**

- `SYNESIS_EXECUTOR_THINKING_PARAM=thinking`
- vLLM: `--reasoning-parser deepseek_v3`, `--tokenizer-mode deepseek_v32`, `-tp 2` (or more).
