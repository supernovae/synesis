# Model Serving (OpenShift AI 3+)

Synesis does **not** ship custom InferenceServices or ServingRuntimes. Models are deployed via **OpenShift AI 3** using the platform's model serving capabilities.

## Important: Use RHOAI Built-in vLLM Only

**Do not use Docker Hub vLLM images.** Custom vLLM containers from Docker Hub failed on RHOAI v2 due to Python path issues. Always use the **RHOAI built-in vLLM ServingRuntime** (select it in the Deploy model wizard). The platform provides validated, OpenShift-compatible images.

## Prerequisites

- **OpenShift AI 3.x** (fast or stable channel)
- **Single-model serving** enabled (KServe)
- **vLLM ServingRuntime** (RHOAI's built-in vLLM NVIDIA GPU runtime)
- **GPU support** (NVIDIA GPU Operator) for code generation models

## Deploying Models

**Strategy (keep it simple):**
- **Primary**: HuggingFace direct (`hf://Qwen/Qwen3-14B`, `hf://Qwen/Qwen3-Coder-Next`) — reliable for our models.
- **Optional**: Red Hat validated models when available (e.g. `RedHatAI/Qwen3-14B-FP8-dynamic` in Model Hub).
- **Optional**: Custom catalog — add a Synesis catalog via `model-catalog-sources` ConfigMap if you manage catalogs manually.

### Via the OpenShift AI Dashboard

1. Create or select a **Data Science Project** (use `synesis-models` to keep models in the Synesis namespace).
2. Click **Deploy model**.
3. In the wizard:
   - **Model location**: HuggingFace (`hf://`), Model Hub, or OCI
   - **Serving runtime**: Select the **vLLM NVIDIA GPU** runtime (RHOAI built-in — not custom Docker Hub images)
   - **Hardware profile**: Choose your GPU node profile
   - **Model deployment name**: e.g. `synesis-supervisor`, `synesis-planner`, `synesis-executor`, `synesis-critic`

4. For each model, use `hf://` or Model Hub: see `models.yaml` for HuggingFace repo IDs.

### Via CLI (InferenceService YAML)

If you prefer GitOps, create an InferenceService that references RHOAI's vLLM runtime:

```yaml
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: synesis-executor
  namespace: synesis-models
spec:
  predictor:
    model:
      # Use the runtime name from Settings → Serving runtimes in the dashboard
      runtime: vllm
      modelFormat:
        name: vllm
      # OCI model or HuggingFace (hf://)
      storageUri: hf://Qwen/Qwen3-Coder-Next
      resources:
        limits:
          cpu: "8"
          memory: 48Gi
          nvidia.com/gpu: "1"
        requests:
          cpu: "4"
          memory: 32Gi
          nvidia.com/gpu: "1"
```

Check **Settings → Serving runtimes** in the OpenShift AI dashboard for the exact `runtime` name (e.g. `vllm`, `vllm-nvidia-gpu`).

## Configuring Synesis

After deploying models, point Synesis at your endpoints. Deploy three model predictors: **synesis-supervisor** (also used by planner), **synesis-executor**, **synesis-critic**.

1. **Planner env vars** (`base/planner/deployment.yaml` or ConfigMap):
   - `SYNESIS_SUPERVISOR_MODEL_URL` → `http://synesis-supervisor-predictor.synesis-models.svc.cluster.local:8080/v1`
   - `SYNESIS_PLANNER_MODEL_URL` → `http://synesis-supervisor-predictor.synesis-models.svc.cluster.local:8080/v1` (planner shares Supervisor)
   - `SYNESIS_EXECUTOR_MODEL_URL` → `http://synesis-executor-predictor.synesis-models.svc.cluster.local:8080/v1`
   - `SYNESIS_CRITIC_MODEL_URL` → `http://synesis-critic-predictor.synesis-models.svc.cluster.local:8080/v1`

2. **Supervisor config** (`base/supervisor/configmap.yaml`): Health monitor circuit breakers for synesis-supervisor, synesis-planner, synesis-executor, synesis-critic. Override endpoints if your deployment names differ.

3. **LiteLLM** (`base/gateway/litellm-config.yaml`): `synesis-agent` routes to the planner orchestrator; individual models are listed for direct access. Update `api_base` if deployment names differ.

Example service URL pattern:
`http://<inference-service-name>-predictor.<namespace>.svc.cluster.local:8080/v1`
