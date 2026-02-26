# Model Serving (OpenShift AI 3+)

Synesis does **not** ship custom InferenceServices or ServingRuntimes. Models are deployed via **OpenShift AI 3** using the platform's model serving capabilities.

## Prerequisites

- **OpenShift AI 3.x** (fast or stable channel)
- **Single-model serving** enabled (KServe)
- **vLLM ServingRuntime** enabled for your project
- **GPU support** (NVIDIA GPU Operator) for code generation models

## Deploying Models

### Via the OpenShift AI Dashboard

1. Create or select a **Data Science Project** (use `synesis-models` to keep models in the Synesis namespace).
2. Click **Deploy model**.
3. In the wizard:
   - **Model location**: OCI registry, HuggingFace (`hf://`), or S3
   - **Serving runtime**: Select the vLLM NVIDIA GPU runtime (pre-installed by RHOAI)
   - **Hardware profile**: Choose your GPU node profile
   - **Model deployment name**: e.g. `synesis-coder`, `synesis-supervisor`

4. For validated models, use the **Model Hub** or Red Hat's [validated models](https://huggingface.co/collections/RedHatAI).

### Via CLI (InferenceService YAML)

If you prefer GitOps, create an InferenceService that references RHOAI's vLLM runtime:

```yaml
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: synesis-coder
  namespace: synesis-models
spec:
  predictor:
    model:
      # Use the runtime name from Settings → Serving runtimes in the dashboard
      runtime: vllm
      modelFormat:
        name: vllm
      # OCI modelcar, HuggingFace, or S3
      storageUri: hf://Qwen/Qwen2.5-Coder-32B-Instruct
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

After deploying models, point Synesis at your endpoints:

1. **Planner env vars** (patch in overlay or set in ConfigMap):
   - `SYNESIS_CODER_MODEL_URL` → `http://<deployment-name>-predictor.synesis-models.svc.cluster.local:8080/v1`
   - `SYNESIS_CODER_MODEL_NAME` → your model's `served-model-name`
   - `SYNESIS_SUPERVISOR_MODEL_URL` → supervisor model endpoint
   - `SYNESIS_SUPERVISOR_MODEL_NAME` → supervisor model name

2. **Supervisor config** (`base/supervisor/configmap.yaml`): Override `qwen-coder` and `mistral-nemo` service endpoints to match your deployed model URLs.

3. **LiteLLM** (`base/gateway/litellm-config.yaml`): Update `api_base` for `synesis-coder` and `synesis-supervisor` to point at your InferenceService endpoints.

Example service URL pattern:
`http://<inference-service-name>-predictor.<namespace>.svc.cluster.local:8080/v1`
