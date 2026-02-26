# Model Serving

KServe InferenceServices + vLLM ServingRuntimes. Models are downloaded from HuggingFace Hub via `hf://` URIs.

## vLLM Image

We use **`vllm/vllm-openai:latest`** from Docker Hub. It's public, maintained by the vLLM project, and won't vanish when RHOAI rotates its internal tags (`quay.io/modh/vllm:rhoai-*` has had tags removed in the past).

**To override** (e.g. for `registry.redhat.io/rhaiis/vllm-cuda-rhel9`):

```yaml
# overlays/<env>/model-serving-patch.yaml
apiVersion: serving.kserve.io/v1alpha1
kind: ServingRuntime
metadata:
  name: mistral-nemo-12b
  namespace: synesis-models
spec:
  containers:
    - name: kserve-container
      image: registry.redhat.io/rhaiis/vllm-cuda-rhel9:3.2.5
---
apiVersion: serving.kserve.io/v1alpha1
kind: ServingRuntime
metadata:
  name: qwen-coder-32b
  namespace: synesis-models
spec:
  containers:
    - name: kserve-container
      image: registry.redhat.io/rhaiis/vllm-cuda-rhel9:3.2.5
```

Then add to `overlays/<env>/kustomization.yaml`:

```yaml
patches:
  - path: model-serving-patch.yaml
```

**Discovering Red Hat images:** Check the [Red Hat Ecosystem Catalog](https://catalog.redhat.com/) for `vllm-cuda-rhel9` to see available tags.
