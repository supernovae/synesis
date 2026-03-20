# Yarn Agent Runtime

The Yarn runtime is a fast, stateful agent execution layer for IDE clients. It exposes an OpenAI-compatible API (`/v1/chat/completions`) and handles the hot agentic loop — tool calls, memory management, and streaming — without LangChain. Complex tasks (RAG, multi-step planning) escalate to the existing planner.

## Coder model

Yarn is the **agentic shell around the coder workload**: LLM traffic is intended to use the same **coder** family as the rest of Synesis (`synesis-coder` in `models.yaml`). For **local / in-cluster** inference, the default upstream base URL is the **`synesis-coder`** vLLM service — see `model_url` in [`base/yarn/app/config.py`](../base/yarn/app/config.py) (env `SYNESIS_YARN_MODEL_URL` when using `SYNESIS_YARN_PROVIDER=local`). You may override with **DeepInfra** or another host for testing (`SYNESIS_YARN_PROVIDER`, `SYNESIS_YARN_MODEL`, etc.). The **LiteLLM** route name exposed to clients remains **`synesis-yarn`** (product surface), which is distinct from the direct **`synesis-coder`** gateway route.

## Architecture

```
IDE Clients (Cursor, Claude Code, Windsurf, OpenCode)
    │
    ▼
┌─────────────────────────────────────────────────┐
│  Yarn Runtime (synesis-yarn namespace)          │
│                                                  │
│  ┌──────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ Session   │  │ Memory Buffer│  │ Tool      │ │
│  │ Manager   │  │ (3-zone)     │  │ Orchestra.│ │
│  └──────────┘  └──────────────┘  └───────────┘ │
│  ┌──────────┐  ┌──────────────┐                 │
│  │ Model     │  │ Escalation   │                 │
│  │ Executor  │  │ Bridge       │                 │
│  └──────────┘  └──────────────┘                 │
└─────────────────────────────────────────────────┘
    │              │               │
    ▼              ▼               ▼
  DeepInfra     Planner        MCP Server
  (Qwen3-480B)  (LangGraph)    (tools)
```

## Modules

### Session Manager (`app/session/`)
- Authenticates via Keycloak JWT or `syn-` prefix PATs
- Per-session state in Redis DB 3 (`yarn:session:{user_id}:{conversation_id}`)
- Token-bucket rate limiting per session/role

### Memory Buffer (`app/memory/`)
The core differentiator. A three-zone rolling buffer optimized for prefix caching:

1. **Pinned Zone**: System prompt + tool schemas + memory replay. Never changes. Always a cache hit.
2. **Stable Zone**: Completed conversation turns. Grows monotonically. High cache hit rate.
3. **Delta Zone**: Current user message. The only cache miss.

This layout ensures 80-85% prefix cache hits on DeepInfra (10x cheaper cached tokens) and vLLM APC.

When turns are evicted from the window, the **compressor** summarizes them into a memory replay message pinned to the first zone, preserving long-session context.

### Tool Orchestrator (`app/tools/`)
- Loads tools from the MCP server + built-in local tools
- JSON Schema validation for arguments
- Retries on transient failure
- The `synesis_escalate` tool triggers LangChain escalation

### Model Executor (`app/model/`)
Provider-agnostic transport with streaming:
- **DeepInfra** (Phase 1): `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo`
- **Local vLLM** (Phase 2+): Direct HTTP with APC
- **LiteLLM** (fallback): Multi-provider failover

Includes circuit breaker, usage tracking (cached/uncached token split), and cost computation.

### Escalation Bridge (`app/escalation/`)
Triggers when:
- The model calls `synesis_escalate`
- Context utilization exceeds 90%
- Tool loop count exceeds 25

Proxies transparently to the planner's `/v1/chat/completions` and streams the response back.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/completions` | Chat completions (streaming/non-streaming) |
| GET | `/v1/models` | List available models |
| GET | `/v1/mcp/tools` | List available tools |
| POST | `/v1/mcp/tools/call` | Execute a tool |
| GET | `/health` | Liveness check |
| GET | `/health/readiness` | Readiness check |
| GET | `/metrics` | Prometheus metrics |

## Configuration

All configuration is via environment variables with the `SYNESIS_YARN_` prefix:

| Variable | Default | Description |
|----------|---------|-------------|
| `SYNESIS_YARN_PROVIDER` | `deepinfra` | Model backend: `deepinfra`, `local`, `litellm` |
| `SYNESIS_YARN_MODEL` | `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo` | Model name |
| `DEEPINFRA_API_KEY` | | DeepInfra API key |
| `SYNESIS_YARN_SESSION_REDIS_URL` | `redis://localhost:6379/3` | Redis for sessions |
| `SYNESIS_YARN_MEMORY_REDIS_URL` | `redis://localhost:6379/4` | Redis for memory |
| `SYNESIS_YARN_PLANNER_URL` | `http://synesis-planner...` | Planner for escalation |
| `SYNESIS_YARN_MCP_URL` | `http://synesis-mcp...` | MCP server for tools |
| `SYNESIS_YARN_KEYCLOAK_ISSUER_URL` | | Keycloak realm URL |
| `SYNESIS_YARN_MEMORY_WINDOW_TOKENS` | `131072` | Memory window size |
| `SYNESIS_YARN_MAX_TOKENS` | `32768` | Max output tokens |
| `SYNESIS_YARN_TEMPERATURE` | `0.2` | Model temperature |
| `SYNESIS_YARN_LOG_LEVEL` | `info` | Log level |

## Local Development

```bash
# 1. Copy the env template
cp .env.example .env
# Edit .env and add your DEEPINFRA_API_KEY

# 2. Start services
podman-compose up

# 3. Test with curl
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer syn-dev-test" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "synesis-yarn",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## OpenShift Deployment

The Yarn service is deployed via Kustomize overlays alongside other Synesis services:

```bash
# Deploy via deploy.sh (handles namespace creation, DB wiring, Keycloak)
./scripts/deploy.sh dev

# Or manually
oc apply -k overlays/dev
```

The deploy script automatically:
- Creates the `synesis-yarn` namespace
- Wires Keycloak issuer URL
- Patches admin DB URL for usage tracking

## IDE Client Configuration

### Cursor
Settings > Models > Add Custom Model:
- API Base: `https://synesis-yarn.apps.your-cluster.dev/v1`
- API Key: Your `syn-` PAT or Keycloak Bearer token
- Model: `synesis-yarn`

### Other IDE Clients
Any client that supports OpenAI-compatible endpoints works the same way.

## Agentic Loop Flow

```
1. Client sends POST /v1/chat/completions
2. Auth → resolve Keycloak JWT or PAT
3. Session → load or create session state
4. Memory → append user message to buffer
5. Loop:
   a. Build context from buffer (pinned + stable + delta)
   b. Stream model response
   c. If tool_calls → execute → append results → continue loop
   d. If content → append to buffer → stream to client → done
   e. If escalation trigger → proxy to planner → done
```

## Database Tables

Two tables in the admin database (`base/admin/alembic/versions/012_yarn_sessions_usage.py`):

- **yarn_sessions**: Durable session metadata (user, provider, token totals, costs)
- **yarn_usage_log**: Per-request usage records (cached/uncached token split, latency, cost)

## Telemetry

- **Prometheus metrics** at `/metrics`: request count, latency histogram, token counters (cached vs uncached), escalation rate, tool call success rate, circuit breaker state
- **OpenTelemetry traces**: Optional, configure via `SYNESIS_YARN_OTEL_ENDPOINT`

## Cost Analysis

See [YARN_COST_ANALYSIS.md](YARN_COST_ANALYSIS.md) for detailed per-request costs, caching impact, and API vs local GPU breakeven analysis.

---

Back to [README](../README.md)
