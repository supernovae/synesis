# Open WebUI

Synesis includes a built-in **Open WebUI** instance that provides a polished chat interface for interacting with the AI assistant. It is pre-configured to connect to the LiteLLM gateway — no manual API URL or key setup required.

## Zero-Configuration Setup

The deploy script automatically:

1. Generates the LiteLLM API key (or reuses an existing one)
2. Copies the key into the `synesis-webui` namespace as a Secret
3. Deploys Open WebUI with the API URL and key pre-injected as environment variables
4. Creates an OpenShift Route at `synesis.apps.openshiftdemo.dev`

On first visit, create an admin account. The `synesis-agent` model is available immediately.

## Routes by Environment

| Environment | Web UI URL | API URL |
|-------------|-----------|---------|
| **Dev** | `https://synesis.apps.openshiftdemo.dev` | `https://synesis-api.apps.openshiftdemo.dev` |
| **Staging** | `https://synesis-staging.apps.openshiftdemo.dev` | `https://synesis-api-staging.apps.openshiftdemo.dev` |
| **Prod** | `https://synesis.apps.openshiftdemo.dev` | `https://synesis-api.apps.openshiftdemo.dev` |

## Available Models in the UI

| Model Name | What It Does |
|------------|-------------|
| `synesis-agent` | Full pipeline: Router → Planner → Worker → Critic → Respond |
| `synesis-router` | Direct access to Router model (Qwen3-8B) |
| `synesis-general` | Direct access to General model (reasoning, writing) |
| `synesis-coder` | Direct access to Coder model (Qwen3-Coder-Next) |
| `synesis-critic` | Direct access to Critic model (R1-Distill-32B, thinking) |

Users can select the Critic (R1) model as a dedicated "thinking" model for tasks that benefit from deep reasoning.

## Code Formatting

Open WebUI renders code blocks with syntax highlighting out of the box. When Synesis returns code in fenced markdown blocks, the UI displays them with language-specific syntax highlighting, copy-to-clipboard, and line numbers.

## Phase/Status Display

The planner emits SSE status events during graph execution (Thinking, Validating, Testing). See [OPENWEBUI_PHASES.md](OPENWEBUI_PHASES.md) for implementation details and troubleshooting.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `WEBUI_AUTH` | `true` | Require login (first user becomes admin) |
| `ENABLE_SIGNUP` | `true` | Allow new user registration |
| `DEFAULT_MODELS` | `synesis-agent` | Pre-selected model for new conversations |
| `ENABLE_OLLAMA_API` | `false` | Disabled — all inference goes through LiteLLM |

## Resource Requirements

| Environment | CPU Request | Memory | Storage |
|-------------|-----------|--------|---------|
| Dev | 100m | 256Mi | 5Gi PVC |
| Staging/Prod | 250m | 512Mi | 5Gi PVC |

Prod scales to 2 replicas. The PVC stores user accounts, chat history, and settings.

## Network Policy

Open WebUI can only reach the LiteLLM gateway (`synesis-gateway:4000`) and DNS. It has no access to the planner, Milvus, sandbox, or external internet. All model inference goes through the LiteLLM proxy.

## Troubleshooting

### "500: Open WebUI: Server Connection Error"

**Cause:** (a) Open WebUI cannot reach its backend, (b) bad URL persisted in Admin → Settings, or (c) planner's graph execution failed (models down, timeout, etc.).

**If /v1/models works but chat fails:** The planner is reachable; the failure is during graph execution. Check:

```bash
oc logs -n synesis-planner -l app.kubernetes.io/name=synesis-planner --tail=100
```

**Quick fixes:**

1. **Reset persisted config** — dev-webui overlay sets `RESET_CONFIG_ON_START=true` so env vars override DB. Re-apply and restart:
   ```bash
   kustomize build overlays/dev-webui | oc apply -f -
   oc rollout restart deployment/open-webui -n synesis-webui
   ```

2. **Verify planner is reachable**:
   ```bash
   oc get pods -n synesis-planner -l app.kubernetes.io/name=synesis-planner
   oc run -it --rm debug --image=curlimages/curl --restart=Never -n synesis-webui -- \
     curl -s http://synesis-planner.synesis-planner.svc.cluster.local:8000/v1/models
   ```

3. **Switch to LiteLLM** — if planner path is broken, remove the direct-planner patch and set `OPENAI_API_BASE_URL` to `http://litellm-proxy.synesis-gateway.svc.cluster.local:4000/v1`.

### "Connection error" / "OpenAIException" for synesis-agent

The dev overlay includes `openwebui-direct-planner.yaml`, which points Open WebUI directly at the planner. Redeploy and Open WebUI will talk to the planner without LiteLLM.

See [OPENWEBUI_ADMIN_GUIDE.md](OPENWEBUI_ADMIN_GUIDE.md) for admin dashboard import and feedback plugin setup.

---

Back to [README](../README.md) | See also: [Open WebUI Phases](OPENWEBUI_PHASES.md), [Admin Guide](OPENWEBUI_ADMIN_GUIDE.md)
