# OpenRouter Deployment

Run Synesis without GPU hardware by routing **upstream** LLM traffic through [OpenRouter.ai](https://openrouter.ai). The LiteLLM gateway proxies those model calls to OpenRouter. **Open WebUI** → **planner-ts** → **LiteLLM** → OpenRouter for that stack: WebUI never talks to LiteLLM directly; planner is what calls LiteLLM for upstream API traffic. **Yarn** (when configured) may follow a similar planner → LiteLLM pattern depending on env.

## Architecture

Browser traffic is **Open WebUI → planner-ts** only; **planner-ts** then calls **LiteLLM** for upstream OpenRouter API traffic (not the other way around).

```
Open WebUI ──► planner-ts ──► LiteLLM Proxy ──► openrouter.ai/api/v1
                                  ▲
                                  └── OPENROUTER_API_KEY (K8s Secret)

IDE / Yarn ──► planner and/or gateway (per deployment; not shown)
```

The planner env vars (`SYNESIS_ROUTER_MODEL_URL`, etc.) point at the in-cluster LiteLLM service. LiteLLM resolves each `synesis-*` model name to an OpenRouter model path using the API key from a K8s Secret. No vLLM pods, no GPU nodes, no model-serving namespace.

## Quick Start

```bash
# 1. Get an API key from https://openrouter.ai/keys

# 2. Deploy (prompts for key on first run)
./scripts/deploy.sh openrouter
```

That's it. The deploy script:
- Prompts for your OpenRouter API key (or reads `OPENROUTER_API_KEY` from the environment)
- Stores the key in a K8s Secret (`openrouter-api-key` in `synesis-gateway`)
- Auto-generates a LiteLLM master key (same as other environments)
- Skips all GPU/RHOAI/PVC checks
- Applies the `overlays/openrouter` Kustomize overlay

## Manual Deployment

If you prefer not to use `deploy.sh`:

```bash
# Create the API key secret
oc create namespace synesis-gateway 2>/dev/null || true
oc create secret generic openrouter-api-key \
  --from-literal=api-key=sk-or-v1-YOUR_KEY_HERE \
  -n synesis-gateway --dry-run=client -o yaml | oc apply -f -

# Build and apply
kustomize build overlays/openrouter | oc apply -f -
```

## Default Model Mapping (Budget Tier)

The overlay ships with the **budget** tier from `models.yaml`. All models are OpenRouter-hosted — no local inference.

| Synesis Role | OpenRouter Model | Input Cost | Output Cost | Context |
|---|---|---|---|---|
| **Router** (classification, planning, advisor) | `qwen/qwen3-14b` | $0.06/M | $0.24/M | 41K |
| **General** (executor, writer, synthesis) | `deepseek/deepseek-v3.2` | $0.26/M | $0.38/M | 163K |
| **Coder** (IDE direct, agentic coding) | `qwen/qwen-2.5-coder-32b-instruct` | $0.20/M | $0.20/M | 32K |
| **Critic** (quality gate, R1 distill) | `deepseek/deepseek-r1-distill-llama-70b` | $0.70/M | $0.80/M | 131K |
| **Thinking** (Open WebUI "think out loud") | `deepseek/deepseek-r1-distill-llama-70b` | $0.70/M | $0.80/M | 131K |
| **Summarizer** (pivot history compression) | `qwen/qwen3-14b` | $0.06/M | $0.24/M | 41K |

## Quality Tier

For maximum quality at higher cost, swap the model paths in `overlays/openrouter/litellm-config-openrouter.yaml`. The quality tier mappings from `models.yaml`:

| Synesis Role | OpenRouter Model | Input Cost | Output Cost |
|---|---|---|---|
| **Router** | `qwen/qwen3-32b` | $0.08/M | $0.24/M |
| **General** | `qwen/qwen3-235b-a22b` | $0.14/M | $0.34/M |
| **Coder** | `qwen/qwen3-coder-plus` | $0.65/M | $3.25/M |
| **Critic** | `deepseek/deepseek-r1-0528` | $0.45/M | $2.15/M |

## Changing Models

Edit `overlays/openrouter/litellm-config-openrouter.yaml` and change the `model:` field for any role. The format is `openrouter/<provider>/<model-name>`. Browse available models at [openrouter.ai/models](https://openrouter.ai/models).

Example — upgrade the general model to Qwen3-235B:

```yaml
# In litellm-config-openrouter.yaml
- model_name: synesis-general
  litellm_params:
    model: openrouter/qwen/qwen3-235b-a22b    # was qwen/qwen3-32b
    api_key: "os.environ/OPENROUTER_API_KEY"
    max_tokens: 32768
    temperature: 0.3
```

Then re-deploy:

```bash
./scripts/deploy.sh openrouter
```

## API Key Management

### First deploy

The deploy script prompts interactively:

```
OpenRouter API key required.
  Get one at: https://openrouter.ai/keys

  Enter your OpenRouter API key: ▊
```

### CI / non-interactive

Pass the key via environment variable (no prompt):

```bash
OPENROUTER_API_KEY=sk-or-v1-xxx ./scripts/deploy.sh openrouter
```

### Key rotation

```bash
oc delete secret openrouter-api-key -n synesis-gateway
./scripts/deploy.sh openrouter
# Prompts for new key, then re-deploys
```

### Verifying the key

```bash
# Check the secret exists
oc get secret openrouter-api-key -n synesis-gateway

# Test via LiteLLM
LITELLM_KEY=$(oc get secret litellm-secrets -n synesis-gateway \
  -o jsonpath='{.data.master-key}' | base64 -d)
ROUTE=$(oc get route synesis-api -n synesis-gateway -o jsonpath='{.spec.host}')

curl -s "https://$ROUTE/v1/chat/completions" \
  -H "Authorization: Bearer $LITELLM_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"synesis-router","messages":[{"role":"user","content":"ping"}],"max_tokens":10}'
```

## What Gets Deployed

The `overlays/openrouter` Kustomize overlay includes everything **except** `base/model-serving`:

| Component | Namespace | Included |
|---|---|---|
| LiteLLM gateway | `synesis-gateway` | Yes (routes to OpenRouter) |
| Planner (LangGraph pipeline) | `synesis-planner` | Yes |
| RAG stack (Milvus, embedder, keyword-service, preprocess-service, spam-service, GLiNER) | `synesis-rag` | Yes |
| Supervisor (health monitoring) | `synesis-planner` | Yes (checks LiteLLM, not vLLM) |
| Open WebUI | `synesis-webui` | Yes |
| SearXNG (web search) | `synesis-search` | Yes |
| Sandbox (code execution) | `synesis-sandbox` | Yes |
| Admin dashboard | `synesis-admin` | Yes |
| vLLM model serving | `synesis-models` | **No** |

## What Changes vs. Self-Hosted

| Aspect | Self-Hosted (dev/staging/prod) | OpenRouter |
|---|---|---|
| GPU hardware | Required (L40S / A100 / H100) | None |
| Model weight storage (EFS PVC) | Required | None |
| RHOAI / KServe | Required for InferenceService | Not needed |
| Model URLs | Direct to vLLM pods (`synesis-router.synesis-models:8080`) | Through LiteLLM (`litellm-proxy.synesis-gateway:4000`) |
| Guided JSON decoding | Enabled (vLLM native) | Disabled (not universally supported) |
| UDS (Unix Domain Socket) co-location | Optional | Disabled |
| Latency | Low (in-cluster) | Higher (internet round-trip) |
| Per-token cost | Fixed hardware cost | Pay-per-token |
| Scaling | Add GPU nodes | Automatic (OpenRouter handles it) |

## Cost Estimation

Rough per-query cost depends on the pipeline depth. A typical knowledge query with RAG hits the router (classification + planning), general model (writer), and optionally the critic:

| Scenario | ~Input Tokens | ~Output Tokens | Est. Cost (Budget) |
|---|---|---|---|
| Simple question (router + general) | ~2,000 | ~500 | ~$0.0003 |
| Standard knowledge query (router + planner + general + writer) | ~8,000 | ~2,000 | ~$0.001 |
| Complex deep-dive (full pipeline + critic + retry) | ~25,000 | ~8,000 | ~$0.005 |
| Coder session (IDE, direct to coder model) | ~10,000 | ~5,000 | ~$0.003 |

At budget-tier pricing, 1,000 standard queries costs roughly **$1.00**.

## Troubleshooting

### "Connection refused" from planner

The planner can't reach LiteLLM. Check that the LiteLLM pod is running:

```bash
oc get pods -n synesis-gateway
oc logs -n synesis-gateway deployment/litellm-proxy --tail=50
```

### "Authentication failed" or 401 from OpenRouter

The API key is missing or invalid:

```bash
# Check the secret exists and isn't the placeholder
oc get secret openrouter-api-key -n synesis-gateway \
  -o jsonpath='{.data.api-key}' | base64 -d

# Check LiteLLM picked up the env var
oc exec -n synesis-gateway deployment/litellm-proxy -- env | grep OPENROUTER
```

### "Model not found" from OpenRouter

The model path in the LiteLLM config doesn't match an available OpenRouter model. Verify at [openrouter.ai/models](https://openrouter.ai/models) and update `litellm-config-openrouter.yaml`.

### Guided JSON errors

The overlay disables guided JSON (`SYNESIS_GUIDED_JSON_ENABLED=false`) because OpenRouter providers don't universally support vLLM's constrained decoding. If you see JSON parsing errors, the planner's prompt-based JSON extraction should handle it. If issues persist, check the planner logs:

```bash
oc logs -n synesis-planner deployment/synesis-planner --tail=100 | grep -i json
```

### Switching between overlays (dev ↔ openrouter)

The `dev` and `openrouter` overlays share all non-model infrastructure (Milvus, embedder, Redis, SearXNG, etc.) with identical manifests. Switching overlays only changes the resources that actually differ — LiteLLM config, planner env vars, and supervisor health checks. Shared infra stays untouched and pods don't restart.

To switch back to self-hosted:

```bash
./scripts/deploy.sh dev    # or staging, prod
```

The self-hosted overlays include `base/model-serving` and point model URLs back to vLLM services. The OpenRouter secret is ignored (LiteLLM config no longer references it).

## File Reference

| File | Purpose |
|---|---|
| `overlays/openrouter/kustomization.yaml` | Main overlay — excludes model-serving, applies all patches |
| `overlays/openrouter/openrouter-secret.yaml` | K8s Secret template for the OpenRouter API key |
| `overlays/openrouter/litellm-config-openrouter.yaml` | LiteLLM ConfigMap — maps synesis-* names to OpenRouter paths |
| `overlays/openrouter/supervisor-config-patch.yaml` | Supervisor health checks — redirected through LiteLLM |
| `overlays/openrouter/openwebui-direct-planner.yaml` | Pins Open WebUI `OPENAI_API_BASE_URL` to planner-ts (direct; not via LiteLLM) |
| `models.yaml` (`openrouter_profiles`) | Budget and quality tier model recommendations |
| `scripts/deploy.sh openrouter` | One-command deploy with interactive key setup |
