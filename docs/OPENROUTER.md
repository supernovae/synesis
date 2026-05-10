# OpenRouter Deployment

Run Synesis without GPU hardware by routing upstream LLM traffic directly from planner and Yarn to [OpenRouter.ai](https://openrouter.ai). Open WebUI still talks only to planner-ts; planner resolves the active role assignments from the admin Model Registry and uses the configured provider endpoint, model name, API key environment variable, and generation parameters.

## Architecture

```
Open WebUI ──► planner-ts ──► openrouter.ai/api/v1
                              ▲
                              └── OPENROUTER_API_KEY (K8s Secret)

IDE / Yarn ──► Yarn runtime ──► openrouter.ai/api/v1
```

The admin Model Registry is the source of truth for role-to-provider mapping. No local GPU nodes or model-serving namespace are required when every active role is assigned to hosted OpenRouter models.

## Quick Start

```bash
# 1. Get an API key from https://openrouter.ai/keys

# 2. Deploy (prompts for key on first run)
./scripts/deploy.sh openrouter
```

The deploy script:
- Prompts for your OpenRouter API key, or reads `OPENROUTER_API_KEY` from the environment
- Stores provider credentials in the `provider-api-keys` Secret
- Skips GPU/RHOAI/PVC checks for hosted-only deployments
- Applies the selected deployment overlay

## Model Mapping

Configure OpenRouter models in the admin Model Registry:

| Synesis Role | Example OpenRouter Model | Purpose |
|---|---|---|
| **Router** | `qwen/qwen3-14b` | Fast classification, query generation, and routing |
| **Planner** | `qwen/qwen3-14b` | Structured plan generation |
| **Writer** | `deepseek/deepseek-v3.2` | Final synthesis and user-facing responses |
| **Coder** | `qwen/qwen-2.5-coder-32b-instruct` | IDE and agentic coding flows |
| **Critic** | `deepseek/deepseek-r1-distill-llama-70b` | Quality review and evidence checks |
| **Summarizer** | `qwen/qwen3-14b` | Conversation history compression |

Use `https://openrouter.ai/api/v1` as the endpoint and `OPENROUTER_API_KEY` as the API key environment variable. Generation parameters such as `max_tokens`, `temperature`, `top_p`, `top_k`, and `reasoning_effort` can be stored with each role assignment in the registry.

## Key Management

### CI / non-interactive

```bash
OPENROUTER_API_KEY=sk-or-v1-xxx ./scripts/deploy.sh openrouter
```

### Key rotation

Update the provider key from the Admin UI or refresh the cluster Secret, then restart direct consumers:

```bash
oc create secret generic provider-api-keys \
  -n synesis-gateway \
  --from-literal=OPENROUTER_API_KEY=sk-or-v1-YOUR_KEY_HERE \
  --dry-run=client -o yaml | oc apply -f -

oc rollout restart deployment/synesis-planner-ts -n synesis-planner
oc rollout restart deployment/synesis-yarn -n synesis-yarn
```

## Verification

```bash
# Check the provider key exists
oc get secret provider-api-keys -n synesis-gateway \
  -o jsonpath='{.data.OPENROUTER_API_KEY}' | base64 -d

# Test planner's OpenAI-compatible API
TOKEN="syn-..." # Personal Access Token or valid bearer accepted by planner
ROUTE=$(oc get route synesis-api -n synesis-planner -o jsonpath='{.spec.host}')

curl -s "https://$ROUTE/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"synesis-router","messages":[{"role":"user","content":"ping"}],"max_tokens":10}'
```

## Troubleshooting

### "Connection refused" from planner

Check the configured endpoint in the admin Model Registry and confirm the planner pod has egress to `https://openrouter.ai/api/v1`.

```bash
oc logs -n synesis-planner deployment/synesis-planner-ts --tail=100
```

### "Authentication failed" or 401 from OpenRouter

The provider key is missing, invalid, or not available in the planner/Yarn pod environment.

```bash
oc get secret provider-api-keys -n synesis-gateway \
  -o jsonpath='{.data.OPENROUTER_API_KEY}' | base64 -d
oc exec -n synesis-planner deployment/synesis-planner-ts -- env | grep OPENROUTER
```

### "Model not found" from OpenRouter

The upstream model id in the admin Model Registry does not match an available OpenRouter model. Verify the id at [openrouter.ai/models](https://openrouter.ai/models), update the registry assignment, and retry.

### Guided JSON errors

Hosted providers do not universally support vLLM's constrained decoding. If you see JSON parsing errors, planner's prompt-based JSON extraction should handle most cases. If issues persist, check planner logs:

```bash
oc logs -n synesis-planner deployment/synesis-planner-ts --tail=100 | grep -i json
```
