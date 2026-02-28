# Model Serving (OpenShift AI 3+)

Synesis ships **InferenceService** manifests for the JCS pipeline models. `./scripts/deploy.sh` applies them when a DataScienceCluster has `kserve: Managed`. Manifests include ODH dashboard labels, display names, **Generative AI** model type, and **Add as AI asset endpoint** (for GenAI Playground testing).

## Important: Use RHOAI Built-in vLLM Only

**Do not use Docker Hub vLLM images.** Custom vLLM containers from Docker Hub failed on RHOAI v2 due to Python path issues. Always use **RHOAI or llm-on-openshift vLLM images** (e.g. `quay.io/rh-aiservices-bu/*`).

## Prerequisites

- **OpenShift AI 3.x** (fast or stable channel)
- **Single-model serving** enabled (KServe)
- **NVIDIA GPU** for all models — supervisor/critic use Red Hat catalog Qwen3-8B-FP8-dynamic (1 GPU, 8Gi each); executor uses Qwen3-Coder-30B-A3B-FP8
- **HuggingFace token** (recommended): `./scripts/bootstrap.sh --hf-token` to avoid rate limiting

## Deploying Models

**Primary**: `./scripts/bootstrap.sh --hf-token` (once), then `./scripts/deploy.sh dev` applies everything. Manifests match ODH dashboard-created format (verified against cluster).

**What deploy.sh creates:**
- **Connection secret** (ODH URI): synesis-executor (hf:// Qwen3-Coder-30B-A3B-Instruct-FP8)
- **ServingRuntimes**: synesis-executor, synesis-supervisor-critic (vLLM CUDA, speculative), synesis-summarizer (0.5B GPU)
- **InferenceServices**: synesis-supervisor, synesis-executor, synesis-critic, synesis-summarizer (optional)
  - Supervisor/critic: `RedHatAI/Qwen3-8B-FP8-dynamic` from HuggingFace (1 GPU, 8Gi each; OCI registry has sigstore 500 issues)
  - Executor: `Qwen3-Coder-30B-A3B-Instruct-FP8` from HuggingFace (~48Gi GPU; 30B MoE, ~30GB VRAM)

**Ports:** All models use port 8080. Planner, gateway, and supervisor config point at these URLs.

**GPU scheduling:** Supervisor and critic use `nodeSelector: nvidia.com/gpu.product=NVIDIA-A10G` (g5.xlarge, 24GB); executor uses `nvidia.com/gpu.product=NVIDIA-L40S` (g6e.4xlarge, 48GB). Adjust nodeSelectors if your instance types differ.

**Deployment strategy:** We use `Recreate` (not `RollingUpdate`) so apply-triggered restarts don't require N+1 GPU capacity. RHOAI 3 can restart pods even when the spec is unchanged.

**Migrating from dashboard-created deployments:** If you have `synesis-supervisor-qwen3-14b`, `synesis-executor-qwen3-coder-next`, or `critic` from the wizard, delete them before deploy to avoid duplicates: `oc delete inferenceservice synesis-supervisor-qwen3-14b synesis-executor-qwen3-coder-next critic -n synesis-models`

**AI asset / Playground**: Models include `dashboard.opendatahub.io/add-as-ai-asset: "true"` so they appear on **AI assets endpoints** and can be added to the GenAI Playground. If that annotation is not supported on your version, use the dashboard **Edit** on the deployment and check **Add as AI asset endpoint** manually.

## Troubleshooting

### "Specified runtime does not support specified framework/version"

The vLLM CPU runtime (`vllm-cpu`) declares `supportedModelFormats: pytorch`, so it rejects `modelFormat: vLLM`. Use the vLLM CUDA runtime (synesis-executor) with the Red Hat catalog OCI model `Qwen3-8B-FP8-dynamic` for supervisor/critic instead.

### "Waiting for runtime to become available" / Deployments show Failed

Deploy.sh creates the ServingRuntime and InferenceServices. Verify:
```bash
oc get servingruntimes -n synesis-models
oc get inferenceservice -n synesis-models
```
If runtimes exist but InferenceServices fail, check pod logs: `oc logs -n synesis-models -l component=model-server --tail=50`. For executor OOM or vLLM errors, see `docs/VLLM_RECIPES.md` and [vLLM Qwen3 recipes](https://docs.vllm.ai/projects/recipes/en/latest/Qwen/).

### Dashboard Edit shows "mandatory fields missing"

When editing a deployment created via YAML, the dashboard may show:
- **Create connection to this location** — Not needed for `hf://` models; optional HF_TOKEN from `bootstrap.sh --hf-token`.
- **Model type: Generative AI** — Our manifests set `opendatahub.io/model-type: genai`.
- **Serving runtime** — Must match an enabled runtime. Use `./scripts/list-model-runtimes.sh` to see available names.

If the dashboard rejects the deployment, ensure the `runtime` name exists. Supervisor/critic use the same vLLM CUDA runtime as the executor (synesis-executor).

### URI connection type (Model Registry) for dashboard wizard

When deploying via the **dashboard Deploy model wizard** (not deploy.sh), the wizard may require a connection for the model location. To use HuggingFace:

1. **Settings → Environment setup → Connection types**
2. Ensure **URI** connection type is enabled (categories: `model registry`, `URI`).
3. When creating a connection, select **URI** type and set:
   - **Name**: e.g. `huggingface-uri`
   - **URL**: `https://huggingface.co` (or leave default if the type provides it)
   - **HF_TOKEN** (or equivalent): your HuggingFace token (avoids throttling)

Deploy.sh creates ODH-style connection secrets (connection-*.yaml) and uses `storageUri: hf://` plus optional `synesis-hf-token` from `bootstrap.sh --hf-token`.

### Via the OpenShift AI Dashboard (alternative)

If you prefer manual deployment or `deploy.sh` skips model serving (no kserve Managed):

1. Create or select a **Data Science Project** (use `synesis-models` to keep models in the Synesis namespace).
2. Click **Deploy model**.
3. In the wizard:
   - **Model location**: URI / HuggingFace; create a connection first if prompted (category: model registry, URI)
   - **Serving runtime**: Select **vllm-cuda-runtime-template** (GPU) for all models; use catalog Qwen3-8B-FP8-dynamic for supervisor/critic
   - **Hardware profile**: Choose your GPU node profile for executor
   - **Model deployment name**: `synesis-supervisor`, `synesis-executor`, `synesis-critic`

4. Use `hf://` URIs from `models.yaml`: `Qwen/Qwen3-14B`, `Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8`.

The manifests in `base/model-serving/` follow this structure. Check **Settings → Serving runtimes** for the exact `runtime` name on your cluster.

## Configuring Synesis

After models are deployed (via `deploy.sh` or dashboard), Synesis expects three predictors: **synesis-supervisor** (also used by planner), **synesis-executor**, **synesis-critic**.

1. **Planner env vars** (`base/planner/deployment.yaml` or ConfigMap):
   - `SYNESIS_SUPERVISOR_MODEL_URL` → `http://synesis-supervisor-predictor.synesis-models.svc.cluster.local:8080/v1`
   - `SYNESIS_PLANNER_MODEL_URL` → `http://synesis-supervisor-predictor.synesis-models.svc.cluster.local:8080/v1` (planner shares Supervisor)
   - `SYNESIS_EXECUTOR_MODEL_URL` → `http://synesis-executor-predictor.synesis-models.svc.cluster.local:8080/v1`
   - `SYNESIS_CRITIC_MODEL_URL` → `http://synesis-critic-predictor.synesis-models.svc.cluster.local:8080/v1`
   - `SYNESIS_SUMMARIZER_MODEL_URL` → `http://synesis-summarizer-predictor.synesis-models.svc.cluster.local:8080/v1` (optional; pivot history + Tier 3 manifest summarization)

2. **Supervisor config** (`base/supervisor/configmap.yaml`): Health monitor circuit breakers for synesis-supervisor, synesis-planner, synesis-executor, synesis-critic. Override endpoints if your deployment names differ.

3. **LiteLLM** (`base/gateway/litellm-config.yaml`): `synesis-agent` routes to the planner orchestrator; individual models are listed for direct access. Update `api_base` if deployment names differ.

Example service URL pattern:
`http://<inference-service-name>-predictor.<namespace>.svc.cluster.local:8080/v1`
