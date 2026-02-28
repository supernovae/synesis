# Project Synesis

[![Build Images](https://github.com/supernovae/synesis/actions/workflows/build-images.yml/badge.svg)](https://github.com/supernovae/synesis/actions/workflows/build-images.yml)
[![Lint](https://github.com/supernovae/synesis/actions/workflows/lint.yml/badge.svg)](https://github.com/supernovae/synesis/actions/workflows/lint.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

> **Experimental** -- This project is under active development. APIs, manifests, and architecture may change without notice. Contributions and feedback are welcome.

A resilient, Safety-II aligned LLM code assistant built on [OpenShift AI (RHOAI)](https://www.redhat.com/en/technologies/cloud-computing/openshift/openshift-ai). Project Synesis provides a full-stack, self-hosted coding assistant with hybrid RAG, code execution sandboxing, LSP-powered diagnostics, and agentic workflows -- all deployed via GitOps on Kubernetes.

> **Synesis** (coined by Erik Hollnagel): The unification of productivity, quality, safety, and reliability. Safety and success are not separate goals, but emergent properties of the same adaptive processes.

**Repository:** [github.com/supernovae/synesis](https://github.com/supernovae/synesis)

## Architecture

Synesis uses a **multi-phase JCS (Joint Cognitive System)** pipeline: four LLMs with distinct roles, plus a sandbox for safe code execution. The system asks for clarification or plan approval instead of guessing, and the Executor LLM (Worker) can request more information before generating code.

```
[Cursor / Claude CLI / Dev Tools]
        |
        v
[OCP Route + TLS]
        |
        v
[LiteLLM Proxy Gateway]  ── /v1/chat/completions (OpenAI-compatible)
        |
        v
[FastAPI + LangGraph Planner]
        |
   ┌────┼────────────────────────────────────────────────────────────┐
   v    v         v           v            v          v              v
[Entry] [Supervisor] [Planner] [Worker]  [Sandbox] [LSP Analyzer] [Critic] [Respond]
  │      Qwen3-8B    Qwen3-8B   Coder     (runs     (Gateway)     Qwen3-8B
  │      [+Search]   (shared)   Next      code)                   (prefix cache)
  │         │          │         │         │          │              │
  │         │          │         └──fail──┼──[LSP]───┘              │
  │         └──────────┼──────────────────┼────────────────────────┘
  │                    │                  │
  └── pending_plan/needs_input ──► Worker (resume)
  │
  └── else ──► Supervisor
```

**Flow:** Entry → Supervisor → (Planner? | Worker) → Worker (Executor LLM) → Sandbox → Critic → Respond. Plan approval and needs_input surface questions via Respond; the next user message resumes at Worker. See [docs/WORKFLOW.md](docs/WORKFLOW.md) for the full graph and routing logic.

**Performance:** Prefix caching (Supervisor/Critic), guided JSON decoding, persistent HTTP client, and state refs+cache reduce latency and payload size between nodes. See [docs/WORKFLOW.md § Performance and State Payload Optimization](docs/WORKFLOW.md#performance-and-state-payload-optimization).

**Supporting services:**

| Component | Role |
|-----------|------|
| **Hybrid RAG** | Vector + BM25, RRF, re-ranker. Multi-collection (code, API specs, architecture, licenses). |
| **Sandbox** | Isolated pod (warm pool or Job). Lint → security → execute. Deny-all networking. |
| **LSP Gateway** | Deep type/symbol analysis (6 languages). On failure or pre-execution. |
| **Failure Knowledge** | Milvus failures_v1 + fail-fast cache. Inject past mistakes into Supervisor/Worker. |
| **SearXNG** | Live web context. Supervisor and Worker query by profile (web/code). |

### Core Principles

1. **Joint Cognitive System (JCS):** The LLM is a teammate, not a replacement. The Critic enriches understanding through "What-If" analysis instead of binary pass/fail. Clarification and plan approval reduce guesswork.
2. **Erlang/OTP Supervision:** Every node returns a typed response or crashes and gets caught. Circuit breakers, timeouts, and dead-letter queues ensure graceful degradation.
3. **Observability:** Every node outputs its reasoning, assumptions, and confidence level. Prometheus metrics and Grafana dashboards track system health.

### Models

| Role | Model | Quantization | Runtime | Prefix Cache |
|------|-------|-------------|---------|--------------|
| Supervisor | Qwen3-8B-FP8-dynamic (Red Hat catalog) | FP8 | vLLM on GPU (1×8Gi) | ✓ synesis-supervisor-critic |
| Planner | Qwen3-8B-FP8-dynamic (shared with Supervisor) | — | Same as Supervisor | ✓ |
| Executor (Worker) | Qwen3-Coder-Next-FP8 | FP8 | vLLM on GPU (~48GB) | ✗ synesis-executor (MoE) |
| Critic | Qwen3-8B-FP8-dynamic (Red Hat catalog) | FP8 | vLLM on GPU (1×8Gi) | ✓ synesis-supervisor-critic |

Supervisor and Critic use a dedicated **synesis-supervisor-critic** ServingRuntime with `--enable-prefix-caching` for shared system-prompt reuse. Executor uses **synesis-executor** (MoE, no prefix cache). Guided JSON decoding (SupervisorOut, CriticOut) via LangChain `with_structured_output` reduces parse failures.

## Quick Start

### Prerequisites

- **OpenShift AI 3.x** (fast or stable channel)
- NVIDIA GPU Operator (for code generation model)
- `oc`, `kubectl`, `kustomize`, `helm` CLI tools

### 1. Bootstrap

```bash
./scripts/bootstrap.sh                    # Basic bootstrap
./scripts/bootstrap.sh --ghcr-creds       # Also configure GHCR pull secrets + synesis-github-token (RAG indexer)
./scripts/bootstrap.sh --hf-token         # HuggingFace token for model downloads (avoids throttling)
./scripts/bootstrap.sh --github-token    # Only create synesis-github-token in synesis-rag (RAG indexer jobs)
```

This creates namespaces and verifies prerequisites. For **private GHCR images**, use `--ghcr-creds` (also creates `synesis-github-token` for RAG indexer jobs). For **model deployments from HuggingFace** (hf://), use `--hf-token`. For **RAG indexer jobs** (code/apispec/architecture/license), use `--github-token` or `--ghcr-creds` (same token works).

### 2. Deploy Models (OpenShift AI 3)

Models are deployed via the **OpenShift AI dashboard**, not pre-downloaded or S3. Use the **Deploy model** wizard in your Data Science Project:

1. Create or select the `synesis-models` project.
2. Click **Deploy model**.
3. **Three JCS model deployments**: Supervisor+Planner+Critic use Red Hat catalog Qwen3-8B-FP8-dynamic (1 GPU each); Executor uses Qwen3-Coder-Next-FP8. See `models.yaml`.

Model sources: **Model Hub**, HuggingFace (`hf://`), or OCI. No local download or S3 upload needed. See `base/model-serving/README.md` for details and example InferenceService YAML.

### 3. Build and Push Images

Synesis has 10 custom container images that must be built and pushed to a registry
before deploying. The build script auto-detects `podman` or `docker`.

```bash
# Login to GHCR (one-time)
echo $GITHUB_TOKEN | docker login ghcr.io -u <github-user> --password-stdin

# Build all images and push to GHCR
./scripts/build-images.sh --push

# Build with a version tag
./scripts/build-images.sh --push --tag v0.1.0

# Build a subset
./scripts/build-images.sh --only planner,admin --push

# List all images without building
./scripts/build-images.sh --list
```

**Registry override:** Set `SYNESIS_REGISTRY` to use a different registry:

```bash
export SYNESIS_REGISTRY=quay.io/myorg/synesis
./scripts/build-images.sh --push
```

Then update the `images:` block in `overlays/<env>/kustomization.yaml` to match.

**GitHub Actions:** A workflow at `.github/workflows/build-images.yml` automatically
builds and pushes all images on push to `main`. Trigger manually via workflow_dispatch
for custom tags.

**Private repos:** If your GHCR packages are private, run `./scripts/bootstrap.sh --ghcr-creds`
(prompts for GitHub username/token) or set `GITHUB_USERNAME` and `GITHUB_TOKEN` before bootstrap.
The token must be a GitHub PAT with `read:packages` scope. Re-run bootstrap after deploy if you add creds later.
Alternatively, create the pull secret manually in each namespace:

```bash
for ns in synesis-gateway synesis-planner synesis-rag synesis-sandbox synesis-search synesis-lsp synesis-webui; do
  oc create secret docker-registry ghcr-pull-secret \
    --docker-server=ghcr.io \
    --docker-username=<github-user> \
    --docker-password=<ghcr-token> \
    -n "$ns"
  oc secrets link default ghcr-pull-secret --for=pull -n "$ns"
done
```

| Image | Dockerfile | Description |
|---|---|---|
| `synesis/planner` | `base/planner/Dockerfile` | LangGraph agent (entry, supervisor, planner, worker, sandbox, critic) |
| `synesis/admin` | `base/admin/Dockerfile` | Failure pattern admin dashboard |
| `synesis/lsp-gateway` | `base/lsp/gateway/Dockerfile` | LSP diagnostics gateway (6 languages) |
| `synesis/sandbox` | `base/sandbox/image/Dockerfile` | Code execution sandbox with linters |
| `synesis/bge-reranker` | `base/planner/bge-reranker/Dockerfile` | BGE cross-encoder re-ranker |
| `synesis/ingestor` | `base/rag/ingestion/Dockerfile` | RAG document ingestion |
| `synesis/indexer-code` | `base/rag/indexers/code/Dockerfile` | Code repository indexer (tree-sitter) |
| `synesis/indexer-apispec` | `base/rag/indexers/apispec/Dockerfile` | OpenAPI/Swagger spec indexer |
| `synesis/indexer-architecture` | `base/rag/indexers/architecture/Dockerfile` | Architecture whitepaper indexer |
| `synesis/indexer-license` | `base/rag/indexers/license/Dockerfile` | License compliance indexer |

### 5. Configure

**Model endpoints:** If you deployed models with different names than `synesis-supervisor`, `synesis-planner`, `synesis-executor`, `synesis-critic`, patch the planner env vars and supervisor config. See `base/model-serving/README.md`.

**LiteLLM API key:** Auto-generated on first deploy. The deploy script creates a
random key, stores it in a cluster Secret, and prints it at the end. LiteLLM OSS
is free -- this key is just a passphrase you use to authenticate to your own proxy.

**Route domain:** Defaults to `*.apps.openshiftdemo.dev`. To change it, edit
`base/gateway/litellm-route.yaml` and the overlay `kustomization.yaml` files.

### 6. Deploy

```bash
./scripts/deploy.sh dev      # Development
./scripts/deploy.sh staging  # Staging
./scripts/deploy.sh prod     # Production
```

**Avoid model restarts during debugging:** Use `overlays/dev-services` (excludes model-serving) for day-to-day deploys. Models stay running; only planner, webui, gateway, etc. are updated:

```bash
# Day-to-day: planner, webui, etc. (no 30min model restarts)
kustomize build overlays/dev-services | oc apply -f -

# Models only (when InferenceService/ServingRuntime changes)
kustomize build overlays/dev-models | oc apply -f -
```

### 7. Load RAG Corpus

The RAG stack (Milvus + embedder + indexers) is deployed by `deploy.sh`. Optional: install it standalone with `./scripts/install-rag-stack.sh --wait`.

```bash
./scripts/load-language-pack.sh bash
```

### 8. Connect Your Tools

Point any OpenAI-compatible client to the Route URL:

| Route | Base URL | Use Case |
|-------|----------|----------|
| **synesis-api** (LiteLLM) | `https://synesis-api.<cluster-domain>/v1` | Multi-model routing: synesis-agent, synesis-executor, synesis-supervisor, synesis-critic |
| **synesis-executor-api** (vLLM) | `https://synesis-executor.<cluster-domain>/v1` | Direct vLLM executor only — Cursor/Claude Code for raw code model |
| **synesis-planner-api** | `https://synesis-planner.<cluster-domain>/v1` | Full agent pipeline (planning → sandbox → critic) without LiteLLM |
| **synesis-admin** | `https://synesis-admin.<cluster-domain>/` | Failure dashboard (stats, gaps, failure details) |

Default host suffix is `apps.openshiftdemo.dev`. If your cluster uses a different ingress domain, patch the Route `spec.host` in an overlay.

```bash
# Cursor: Settings > Models > Custom API
# Base URL: https://synesis-api.apps.openshiftdemo.dev/v1

# LiteLLM (multi-model):
curl -X POST https://synesis-api.apps.openshiftdemo.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GENERATED_KEY" \
  -d '{
    "model": "synesis-agent",
    "messages": [{"role": "user", "content": "Write a bash script to safely rename files matching a pattern"}]
  }'

# Direct vLLM executor (Cursor/Claude Code — raw code model, no auth by default):
curl -X POST https://synesis-executor.apps.openshiftdemo.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "synesis-executor", "messages": [{"role": "user", "content": "Hello"}]}'
```

## Project Structure

```
synesis/
├── models.yaml                # SINGLE SOURCE OF TRUTH for all model definitions
├── docs/                      # Architecture and workflow documentation
│   ├── WORKFLOW.md            # Full graph flow, plan approval, needs_input (read this for routing)
│   ├── MODEL_ARCHITECTURE_PROPOSAL.md
│   └── PLAN_REMAINING_WORK.md
├── base/
│   ├── model-serving/         # Namespace + RHOAI 3 deployment + route-executor.yaml (direct vLLM)
│   ├── gateway/               # LiteLLM proxy (OpenAI-compatible API)
│   ├── planner/               # FastAPI + LangGraph orchestrator + route.yaml (synesis-planner-api)
│   │   ├── app/
│   │   │   ├── graph.py       # Entry → Supervisor → Planner/Worker → Sandbox → Critic
│   │   │   ├── state.py       # Pydantic state model (GraphState, context_cache, rag_context_refs)
│   │   │   ├── context_resolver.py  # get_resolved_rag_context (refs+cache)
│   │   │   ├── rag_client.py  # Hybrid retrieval + re-ranking pipeline
│   │   │   ├── failure_store.py  # Milvus failure knowledge base client
│   │   │   ├── failfast_cache.py # In-memory success/failure LRU cache
│   │   │   ├── conversation_memory.py # L1 memory + pending_plan, pending_needs_input
│   │   │   ├── web_search.py    # Async SearXNG client (web + code profiles)
│   │   │   └── nodes/
│   │   │       ├── supervisor.py    # Intent routing, clarification, planning suggestion
│   │   │       ├── planner_node.py  # Task breakdown, execution_plan
│   │   │       ├── worker.py        # Executor LLM: code generation, needs_input
│   │   │       ├── executor.py      # Sandbox node: Job creation, result parsing
│   │   │       ├── lsp_analyzer.py  # LSP Gateway client for deep diagnostics
│   │   │       └── critic.py        # Safety-II "What-If" analysis
│   │   └── bge-reranker/      # Optional BGE re-ranker service
│   ├── sandbox/               # Code execution sandbox (isolated namespace)
│   │   ├── namespace.yaml     # synesis-sandbox with restricted PSA
│   │   ├── network-policy.yaml # Deny all ingress + egress
│   │   ├── warm-pool-network-policy.yaml  # Allow planner → warm pool ingress
│   │   ├── warm-pool-deployment.yaml      # Pre-warmed sandbox pod pool
│   │   ├── warm-pool-service.yaml         # ClusterIP Service for warm pool
│   │   ├── rbac.yaml          # Planner SA permissions for Job management
│   │   └── image/             # Universal sandbox container
│   │       ├── Dockerfile
│   │       ├── run.sh          # lint → security → execute → JSON output
│   │       ├── warm_server.py  # HTTP server for warm pool pods
│   │       └── semgrep-rules/  # Custom SAST rules
│   ├── admin/                 # Failure dashboard web service
│   │   ├── app/main.py        # FastAPI endpoints + Jinja2 templates
│   │   ├── Dockerfile
│   │   └── deployment.yaml
│   ├── lsp/                   # LSP Intelligence Gateway
│   │   ├── namespace.yaml     # synesis-lsp with restricted PSA
│   │   ├── network-policy.yaml # Planner-only ingress, no egress
│   │   └── gateway/           # FastAPI + 6 language analyzers
│   │       ├── app/analyzers/ # basedpyright, gopls, tsc, shellcheck, javac, cargo
│   │       ├── Dockerfile     # Multi-runtime container image
│   │       └── deployment.yaml
│   ├── rag/                   # Milvus + embedder + ingestion pipeline
│   │   ├── ingestion/         # Base ingestor + shared indexer utilities
│   │   ├── indexers/          # Knowledge indexer containers (Job/CronJob)
│   │   │   ├── code/          # AST-chunked OSS code (tree-sitter) + PR patterns
│   │   │   ├── apispec/       # OpenAPI/Swagger endpoint chunking
│   │   │   ├── architecture/  # Whitepapers + cloud design patterns (PDF/HTML/MD)
│   │   │   └── license/       # OSS license compliance (SPDX, Fedora, compatibility)
│   │   └── language-packs/
│   │       ├── bash/          # Shell scripting corpus
│   │       └── _template/     # Template for new languages
│   ├── search/                # SearXNG meta-search engine
│   │   ├── namespace.yaml     # synesis-search with baseline PSA
│   │   ├── configmap-settings.yaml # SearXNG engine configuration
│   │   ├── deployment.yaml    # searxng/searxng:latest container
│   │   ├── service.yaml       # ClusterIP on port 8080
│   │   ├── network-policy.yaml # Planner ingress + external egress
│   │   └── kustomization.yaml
│   ├── webui/                 # Open WebUI chat frontend
│   │   ├── namespace.yaml     # synesis-webui with restricted PSA
│   │   ├── deployment.yaml    # ghcr.io/open-webui/open-webui:main
│   │   ├── service.yaml       # ClusterIP on port 8080
│   │   ├── route.yaml         # synesis.apps.openshiftdemo.dev
│   │   ├── pvc.yaml           # 5Gi for user data + chat history
│   │   └── network-policy.yaml # WebUI -> LiteLLM only
│   ├── supervisor/            # Erlang-style health monitoring
│   └── observability/         # Prometheus + Grafana
├── overlays/
│   ├── dev/                   # Reduced resources, debug logging
│   ├── staging/               # Mirrors prod topology
│   └── prod/                  # HA, NetworkPolicies, PDBs
├── .github/workflows/
│   └── build-images.yml       # GitHub Actions CI for container images
├── scripts/
│   ├── bootstrap.sh           # Cluster preparation
│   ├── build-images.sh        # Build + push all 10 custom container images
│   ├── deploy.sh              # Kustomize apply
│   ├── install-rag-stack.sh   # Milvus + embedder + indexers (standalone or pre-deploy)
│   ├── load-language-pack.sh  # RAG ingestion trigger
│   ├── index-code.sh          # Code repository indexer trigger
│   ├── index-apispec.sh       # API spec indexer trigger
│   ├── index-architecture.sh  # Architecture whitepaper indexer trigger
│   └── index-license.sh       # License compliance indexer trigger
└── .cursor/rules/
    └── model-alignment.mdc    # Cursor rule: keeps model refs in sync
```

## Changing Models

All model definitions live in `models.yaml`. When you want to swap a model (e.g., upgrade Qwen 32B to a newer version):

1. Edit `models.yaml` with the new HuggingFace repo, name, and vLLM args
2. Update all files listed in `models.yaml` under `references:` (the Cursor rule will remind you)
3. Deploy via OpenShift AI dashboard — use Model Hub or `hf://org/model-name` as the model location
4. Redeploy Synesis if config changed: `./scripts/deploy.sh dev`

## Hybrid RAG Pipeline

Synesis uses a hybrid retrieval pipeline that combines semantic vector search with keyword-based BM25 search, merged via Reciprocal Rank Fusion (RRF), and refined by a cross-encoder re-ranker. This approach significantly improves retrieval quality -- semantic search catches paraphrases and conceptual matches, while BM25 catches exact syntax and keyword matches (critical for code, where `set -euo pipefail` won't match semantically with "error handling").

### How It Works

1. **Ensemble Retrieval**: The user query is sent to both retrievers in parallel:
   - **Vector search** (Milvus): Embeds the query and finds semantically similar chunks via cosine similarity.
   - **BM25 search** (in-memory): Keyword matching using BM25Okapi, built from chunks cached from Milvus at startup and refreshed every 10 minutes.

2. **Reciprocal Rank Fusion**: Results from both retrievers are merged using RRF (`score = sum(1/(k + rank))`). Each result is tagged with its source ("vector", "bm25", or "both").

3. **Cross-Encoder Re-ranking**: The merged candidates are re-scored by a cross-encoder that evaluates the (query, document) pair jointly -- unlike the retrievers which score documents independently.

### Re-ranker Options

| Re-ranker | Size | Latency | Accuracy | Infrastructure |
|-----------|------|---------|----------|----------------|
| **FlashRank** (default) | ~34MB | ~4ms | Good | None -- runs inline in the planner |
| **BGE-reranker-v2-m3** | ~1.1GB | ~50-200ms | Best | Separate service in planner namespace |

### Resilience

If Milvus or the embedder service goes down, the pipeline automatically degrades to **BM25-only** from cached chunks. No external dependency is needed for BM25 -- it runs entirely in the planner's memory. This means retrieval continues even during vector service outages, and the Grafana dashboard tracks fallback events so you can monitor service health.

### Per-Request Control

Pass an optional `retrieval` object in the chat completion request to override strategy and re-ranker:

```bash
curl -X POST https://synesis-api.apps.openshiftdemo.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "synesis-agent",
    "messages": [{"role": "user", "content": "Write a bash trap handler"}],
    "retrieval": {
      "strategy": "hybrid",
      "reranker": "flashrank",
      "top_k": 5
    }
  }'
```

| Parameter | Values | Default | Description |
|-----------|--------|---------|-------------|
| `strategy` | `hybrid`, `vector`, `bm25` | `hybrid` | Which retrievers to use |
| `reranker` | `flashrank`, `bge`, `none` | `flashrank` | Cross-encoder re-ranker |
| `top_k` | integer | `5` | Number of results to return |

### Configuration

All retrieval settings are environment variables (prefixed `SYNESIS_`):

| Setting | Default | Description |
|---------|---------|-------------|
| `RAG_RETRIEVAL_STRATEGY` | `hybrid` | Default retrieval strategy |
| `RAG_RERANKER` | `flashrank` | Default cross-encoder re-ranker |
| `RAG_RERANKER_MODEL` | `ms-marco-MiniLM-L-12-v2` | FlashRank model variant |
| `RAG_BM25_REFRESH_INTERVAL_SECONDS` | `600` | BM25 index rebuild interval |
| `RAG_RRF_K` | `60` | RRF fusion constant |
| `RAG_BGE_RERANKER_URL` | (empty) | BGE service URL (enable accuracy mode) |

### Observability

Three Prometheus metrics and Grafana panels track retrieval health:

- **Retrieval Source Distribution**: Pie chart showing proportion of results from vector, BM25, or both retrievers -- useful for understanding which retriever is winning and whether your RAG corpus works better with semantic or keyword search.
- **Re-ranker Latency (p50/p95)**: Time series of cross-encoder re-ranking latency by re-ranker type.
- **BM25 Fallback Rate**: Tracks how often the pipeline falls back to BM25-only due to vector service failures. A sustained non-zero rate indicates Milvus/embedder health issues.

### Deploying BGE Reranker (Optional)

The BGE reranker service is only needed if you want the higher-accuracy mode. It's not deployed by default.

```bash
# Deploy the BGE reranker service
oc apply -k base/planner/bge-reranker/

# Point the planner to it
oc set env deployment/synesis-planner -n synesis-planner \
  SYNESIS_RAG_BGE_RERANKER_URL=http://bge-reranker.synesis-planner.svc.cluster.local:8000
```

## Code Execution Sandbox

Synesis validates generated code before presenting it to the user. Every code snippet produced by the **Worker** (Executor LLM) is sent to the **Sandbox** node -- an isolated execution environment -- which runs linting, security scanning, and actual execution. If any step fails, the code is routed back to the Worker with detailed error context for revision.

### How It Works

1. **Worker generates code** -- the Executor LLM (Qwen3-Coder-Next-FP8) produces the snippet; target language is passed in state.
2. **Sandbox runs the code** -- via warm pool (HTTP) or ephemeral K8s Job. The pod runs a pipeline: lint → security scan → execute.
3. **On success** (exit code 0, lint passed, security passed): the result moves forward to the Critic for Safety-II "What-If" analysis.
4. **On failure**: the error context (lint errors, security findings, runtime output) is injected into the state and the graph routes back to the Worker for a revision pass. This loops up to `max_iterations` (default 3).

### Sandbox Security

The sandbox is hardened for safe code execution on a shared cluster:

| Control | Implementation |
|---------|---------------|
| **Network isolation** | `NetworkPolicy` denies all ingress and egress. Sandbox pods cannot reach any service, DNS, or external network. |
| **No privilege escalation** | `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]` |
| **Read-only root filesystem** | `readOnlyRootFilesystem: true` (writable `/tmp` via `emptyDir`) |
| **Non-root execution** | `runAsNonRoot: true` enforced by `restricted` PSA |
| **Resource limits** | CPU: 2 cores, Memory: 1Gi, Ephemeral storage: 100Mi |
| **Timeout** | `activeDeadlineSeconds: 30` on the Job, plus hard `timeout 10s` on code execution |
| **Auto-cleanup** | `ttlSecondsAfterFinished: 300` plus active cleanup by the executor |

### Supported Languages and Tools

One universal container image (`synesis-sandbox:latest`) supports all languages:

| Language | Linter | Security Scanner |
|----------|--------|------------------|
| Bash/Shell | shellcheck, shfmt | semgrep |
| Python | ruff | bandit, semgrep |
| JavaScript/TypeScript | eslint, prettier | semgrep |
| C/C++ | cppcheck, clang-tidy | semgrep |
| Java | javac -Xlint:all | semgrep |
| Go | go vet | semgrep |

Semgrep is the universal SAST scanner across all languages with custom rules in `base/sandbox/image/semgrep-rules/`.

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `SANDBOX_ENABLED` | `true` | Enable/disable sandbox execution |
| `SANDBOX_NAMESPACE` | `synesis-sandbox` | Namespace for sandbox Jobs |
| `SANDBOX_IMAGE` | `synesis-sandbox:latest` | Sandbox container image |
| `SANDBOX_TIMEOUT_SECONDS` | `30` | Job active deadline |
| `SANDBOX_CPU_LIMIT` | `2` | CPU limit per sandbox pod |
| `SANDBOX_MEMORY_LIMIT` | `1Gi` | Memory limit per sandbox pod |

To disable the sandbox (e.g., for lightweight queries), set `SYNESIS_SANDBOX_ENABLED=false` in the planner deployment or pass it per-request.

### Warm Pool (Low-Latency Execution)

By default, the sandbox creates a new Kubernetes Job per code execution. Job scheduling, image pulling, and container startup add 5-15 seconds of cold-start latency. The **warm pool** eliminates this by keeping pre-warmed sandbox pods running via a Deployment. The executor sends code directly via HTTP, bypassing Job scheduling entirely.

**How it works:**

1. N idle sandbox pods run a lightweight Python HTTP server (`warm_server.py`).
2. When the executor needs to run code, it sends a `POST /execute` to the warm pool Service.
3. K8s routes to an idle pod (pods mark themselves not-ready via readiness probe while busy).
4. The pod invokes the same `run.sh` pipeline (lint, security scan, execute) and returns JSON.
5. If all warm pods are busy or the warm pool is unreachable, the executor falls back to the Job-based path automatically.

**Expected latency:** Sub-second for small snippets, 1-5 seconds for full lint+security+execute pipelines (vs 7-20 seconds with cold Job creation).

**Pod recycling:** Each warm pod auto-restarts after 100 executions (configurable via `WARM_MAX_EXECUTIONS`) to limit long-running process risk. The Deployment immediately replaces it.

**Warm Pool Configuration:**

| Setting | Default | Description |
|---------|---------|-------------|
| `SANDBOX_WARM_POOL_ENABLED` | `true` | Enable/disable warm pool (falls back to Jobs when disabled) |
| `SANDBOX_WARM_POOL_URL` | `http://synesis-warm-pool.synesis-sandbox.svc.cluster.local:8080` | Warm pool Service URL |

**Replica Tuning by Environment:**

| Environment | Replicas | Rationale |
|------------|----------|-----------|
| Dev | 1 | Minimal resource usage |
| Staging | 2 (base default) | Matches production topology |
| Prod | 4 | Handles concurrent requests from multiple users |

Scale replicas by patching the `synesis-warm-pool` Deployment in the environment overlay. Each warm pod uses ~256Mi RAM and 100m CPU when idle.

**Observability:** The Prometheus counter `synesis_sandbox_warm_pool_total` tracks warm pool hits vs Job fallbacks, labeled by `result` (`hit` or `fallback`). A sustained high fallback rate suggests the warm pool needs more replicas.

## Failure Knowledge Base

Synesis learns from its mistakes. Every failed code execution is stored in a **failure vector store** (Milvus `failures_v1` collection), and an **in-memory fail-fast cache** provides instant pattern matching for recent attempts.

### Components

1. **Failure Vector Store** (`failures_v1` in Milvus): Stores the failed code, error output, error classification (lint/security/runtime/timeout), language, task description, and an embedding of the code+error pair. When the Supervisor routes a new task to the Worker, it queries this store for similar past failures and injects them as context.

2. **Fail-Fast Cache** (in-memory LRU, 1000 entries, 24h TTL): A fast in-memory cache keyed by `hash(task_description + language)`. On cache hit:
   - **Past success**: inject the successful code pattern as a hint
   - **Past failure**: inject the failure context to avoid repeating the same mistake

3. **Resolution Tracking**: When a failed task eventually succeeds on a subsequent iteration, the successful code is stored as a `resolution` on the original failure entry. Over time, the failure store builds a knowledge base of "problem -> solution" pairs.

### Admin Dashboard

An internal-only FastAPI service (`synesis-admin`) provides a web dashboard for browsing failure patterns:

- `/admin/failures` -- paginated list of failures with language/type filters
- `/admin/failures/stats` -- aggregate stats: failure rate by language, most common error types, resolution rate
- `/admin/failures/gaps` -- identifies RAG corpus gaps: unresolved failures suggest missing documentation in the language packs
- `/admin/failures/{id}` -- detail view with code, error output, and resolution

The admin service is deployed in the planner namespace with a `ClusterIP` Service (no external Route). Access it via port-forward:

```bash
oc port-forward svc/synesis-admin 8080:8080 -n synesis-planner
# Open http://localhost:8080/admin/failures/stats
```

### Observability

Three new Grafana panels track sandbox health:

- **Sandbox Execution Success/Failure**: Rate of successful vs failed sandbox executions over time.
- **Sandbox Latency by Language (p95)**: Execution time distribution per language -- helps identify languages with slow linters or large runtimes.
- **Sandbox Failure Types**: Pie chart of failure categories (lint, security, runtime, timeout) -- reveals whether failures are mostly code quality issues or actual bugs.

## Conversation Memory

Synesis maintains per-user conversation history so the system can understand references across chat sessions ("fix that script", "add error handling to it", "the previous one"). It also stores **pending plan** and **pending needs_input** context so the next user message can resume at the right node. See [docs/WORKFLOW.md](docs/WORKFLOW.md) for plan approval and needs_input flows.

### How It Works

1. **User identification**: Each request is associated with a user via a fallback chain:
   - The `user` field in the request body (OpenAI standard parameter) -- preferred
   - A SHA256 hash of the `Authorization: Bearer <key>` header (auto-derived)
   - `"anonymous"` if neither is available

2. **L1 in-memory store**: The last 20 turns (configurable) per user are stored in-memory in the planner process. When a new request arrives, the user's conversation history is retrieved and injected into the supervisor prompt so it can resolve references and maintain continuity.

3. **Turn storage**: After each request completes, both the user's message and the assistant's response are stored as turns in the memory.

4. **Pending plan / needs_input**: When the Planner surfaces a plan for approval or the Worker asks a question (`needs_input`), the context is stored. On the user's next message, it is restored and the Entry node routes directly to the Worker (skipping Supervisor/Planner).

5. **Eviction**: Users are tracked in LRU order. Inactive users (default 4h TTL) are cleaned up lazily. When the max user limit (default 5000) is reached, the least recently active user is evicted.

### Passing the `user` Field

Any OpenAI-compatible client can pass the `user` field:

```bash
curl -X POST https://synesis-api.apps.openshiftdemo.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "synesis-agent",
    "user": "byron",
    "messages": [{"role": "user", "content": "Add compression to that script"}]
  }'
```

If you don't pass `user`, the system derives an ID from your API key -- so each unique key gets its own conversation history automatically.

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `MEMORY_ENABLED` | `true` | Enable/disable conversation memory |
| `MEMORY_MAX_TURNS_PER_USER` | `20` | Max turns stored per user |
| `MEMORY_MAX_USERS` | `5000` | Max concurrent users in memory |
| `MEMORY_TTL_SECONDS` | `14400` | User inactivity timeout (4 hours) |

### Limitations and Future L2

L1 memory is purely in-memory -- it does not survive pod restarts. This is intentional for simplicity and speed. The architecture includes an explicit eviction hook (`_on_evict`) in the `ConversationMemory` class that can be wired to a Milvus-backed L2 store in the future. When L2 is added, evicted turns would be summarized and persisted, providing long-term memory across pod restarts without changing any graph nodes or API contracts.

## LSP Intelligence

Synesis includes an optional **LSP Gateway** that provides deep type checking and symbol analysis beyond what basic linters (ruff, eslint, shellcheck) can catch. When generated code fails the sandbox execution, the LSP Gateway runs language-specific diagnostic tools to identify type errors, undefined symbols, import resolution failures, and borrow checker violations -- then feeds those structured diagnostics back to the Worker for a more informed revision.

### Why LSP Matters

Standard linters catch syntax and style issues. But type-level errors -- calling a function with the wrong argument types, using an undefined variable, importing a non-existent module -- often pass linting yet fail at runtime. These are exactly the errors LLMs frequently produce. The LSP Gateway catches them before execution or enriches the error context when execution fails, dramatically reducing revision loops.

### How It Works

1. **On executor failure** (default `lsp_mode: "on_failure"`): The failed code is sent to the LSP Gateway for deep analysis. The structured diagnostics (type errors, undefined symbols, wrong argument counts) are injected into the Worker's next revision prompt alongside the sandbox execution errors.

2. **Always mode** (`lsp_mode: "always"`): Every code generation pass goes through LSP analysis before sandbox execution, catching type-level issues before they become runtime failures.

3. **Disabled mode** (`lsp_mode: "disabled"`): LSP analysis is skipped entirely. The pipeline behaves as before.

```
Default (on_failure):
  Worker -> Executor -> [fail] -> LSP Analyzer -> Worker (with diagnostics)

Always mode:
  Worker -> LSP Analyzer -> Executor -> [fail] -> Worker (with diagnostics)
```

### Supported Languages and Engines

| Language | Engine | What It Catches |
|----------|--------|-----------------|
| Python | basedpyright | Undefined variables, wrong argument types, import resolution, type incompatibilities |
| Go | go vet + staticcheck | Module-aware analysis, vet issues, common Go pitfalls |
| TypeScript/JavaScript | tsc --noEmit | Type mismatches, missing properties, wrong generics, import errors |
| Bash/Shell | shellcheck (JSON) | SC-level categories with structured severity for richer feedback |
| Java | javac -Xlint:all | Compilation errors, type mismatches, deprecation, unchecked operations |
| Rust | cargo check | Full compiler diagnostics, borrow checker, lifetime issues, unused imports |

### Architecture

The LSP Gateway is a single FastAPI microservice deployed in its own namespace (`synesis-lsp`) that wraps all 6 language analysis engines. Each engine uses **CLI diagnostic mode** (not persistent LSP stdio connections), making it stateless and well-suited for analyzing isolated code snippets.

Per-language circuit breakers ensure a broken language toolchain (e.g., Go toolchain down) doesn't affect other languages. The gateway never blocks the pipeline -- on timeout or circuit-breaker trip, analysis is skipped and the pipeline continues normally.

### Configuration

All LSP settings are environment variables (prefixed `SYNESIS_`):

| Setting | Default | Description |
|---------|---------|-------------|
| `LSP_ENABLED` | `true` | Enable/disable LSP analysis |
| `LSP_MODE` | `on_failure` | When to run: `on_failure`, `always`, or `disabled` |
| `LSP_GATEWAY_URL` | `http://lsp-gateway.synesis-lsp.svc:8000` | LSP Gateway service URL |
| `LSP_TIMEOUT_SECONDS` | `30` | Analysis timeout per request |

### Resource Requirements

The LSP Gateway container is larger than most Synesis services because it includes all 6 language runtimes:

| Component | RAM | Notes |
|-----------|-----|-------|
| basedpyright (Python) | ~200MB | PyPI install |
| Go toolchain + staticcheck | ~300MB | Go 1.22 |
| Node.js + TypeScript | ~200MB | npm global |
| shellcheck (Bash) | ~50MB | apt install |
| JDK (Java) | ~500MB | headless JDK |
| Rust toolchain (cargo) | ~500MB | minimal profile |
| **Total pod** | **2Gi request / 3Gi limit** | **Dev overlay: 1Gi / 2Gi** |

### Observability

Four Grafana panels track LSP health:

- **LSP Analysis Latency (p50/p95)**: Time series by language -- identifies slow engines.
- **LSP Diagnostics by Severity**: Rate of errors vs warnings found by each language.
- **LSP Language Usage**: Pie chart showing which languages are most frequently analyzed.
- **LSP Circuit Breaker State**: Per-language circuit breaker status (CLOSED/HALF-OPEN/OPEN).

### Disabling LSP

To disable LSP entirely (saves ~2Gi RAM):

```bash
oc set env deployment/synesis-planner -n synesis-planner SYNESIS_LSP_MODE=disabled
```

Or remove `../../base/lsp` from the overlay's `kustomization.yaml` to avoid deploying the gateway pod entirely.

## Knowledge Indexers

Synesis includes three classes of **RAG knowledge indexers** that go beyond the basic language pack corpus. These indexers run as Kubernetes Jobs (manual trigger) or CronJobs (automated weekly refresh) and populate dedicated Milvus collections. The planner automatically queries the relevant collections based on task context, and the Critic uses architecture knowledge for its Safety-II analysis.

### Indexer 1: Code Repository Indexer

Clones 50 high-quality open-source repositories across Python, Go, Rust, TypeScript, and Java, parses source files using **tree-sitter** for AST-aware chunking (functions, classes, methods as self-contained semantic units), and optionally extracts merged PR descriptions and commit messages via the GitHub API.

**Why this matters:** Line-count-based chunking breaks functions mid-body, producing garbled embeddings. Tree-sitter extracts complete semantic units -- a function with its docstring, a class with its methods -- that embedding models can reason about meaningfully. PR/commit patterns capture the "why" behind code changes, aligned with Safety-II resilience thinking.

**Collections created:**

| Collection | Contents |
|------------|----------|
| `code_{lang}_v1` | AST-chunked functions, classes, methods with `symbol_name` and `symbol_type` metadata |
| `patterns_{lang}_v1` | PR descriptions and merge commit messages with author, date, changed files |

**Repositories indexed** (configurable via `base/rag/indexers/code/sources.yaml`):

| Language | Projects |
|----------|----------|
| Python | FastAPI, Django, Requests, Pytest, SQLAlchemy, Airflow, Celery, Pydantic, Black, Home Assistant |
| Go | Kubernetes, Prometheus, Etcd, Traefik, Hugo, Terraform, Gin, GORM, Docker, Go-ethereum |
| Rust | Tokio, rust-analyzer, Actix-web, Rocket, Diesel, Ripgrep, Cargo, Polars, Firecracker, Tauri |
| TypeScript | VS Code, Next.js, NestJS, Redux, Prisma, Axios, Tailwind CSS, D3.js, Express, Electron |
| Java | Spring Boot, JUnit 5, Guava, Elasticsearch, Kafka, Jenkins, Maven, Mockito, Spark, Hadoop |

**Running the indexer:**

```bash
# Index all languages and repos
./scripts/index-code.sh

# Index only Python
./scripts/index-code.sh --language python

# Index a single repo
./scripts/index-code.sh --language python --repo tiangolo/fastapi
```

**GitHub PR extraction:** If you provide a GitHub PAT, the indexer uses the GitHub API to fetch merged PR descriptions with titles, labels, changed files, and merge commit messages. Without a PAT, it falls back to `git log --merges`:

```bash
# Create synesis-github-token (RAG indexer jobs expect key "token")
oc create secret generic synesis-github-token \
  --from-literal=token=ghp_YOUR_TOKEN_HERE \
  -n synesis-rag
```

Or run `./scripts/bootstrap.sh --github-token` (prompts) or `./scripts/bootstrap.sh --ghcr-creds` (same token for GHCR + RAG).

### Indexer 2: API Spec Indexer

Fetches OpenAPI 3.x / Swagger 2.0 specs from URLs, parses them into **endpoint-level chunks** (one chunk per path+method with parameters, request body, response schema, and description), and stores in Milvus. This gives the Worker accurate API knowledge when generating code that interacts with Kubernetes, OpenShift, or cloud APIs.

**Collections created:**

| Collection | Specs Included |
|------------|----------------|
| `apispec_kubernetes_v1` | Core v1, Apps v1, Batch v1, Networking v1 APIs |
| `apispec_openshift_v1` | OpenShift Route API |

**Running the indexer:**

```bash
# Index all specs
./scripts/index-apispec.sh

# Index only Kubernetes specs
./scripts/index-apispec.sh --spec kubernetes-core-v1
```

**Adding custom API specs:** Edit `base/rag/indexers/apispec/sources.yaml`:

```yaml
specs:
  - name: "my-internal-api"
    url: "https://my-api.example.com/openapi.json"
    description: "My internal service API"
    collection: "apispec_myapi_v1"
```

### Indexer 3: Architecture Whitepaper Indexer

Downloads whitepapers and design pattern documentation (PDFs, HTML, Markdown), converts to text, and chunks by section. This gives the **Critic** node access to architectural best practices for its Safety-II "What-If" analysis.

**Collections created:**

| Collection | Documents |
|------------|-----------|
| `arch_well_architected_v1` | AWS Well-Architected Framework, Reliability Pillar, Security Pillar, Operational Excellence Pillar |
| `arch_cloud_patterns_v1` | Microsoft Cloud Design Patterns (Circuit Breaker, Retry, Bulkhead, CQRS, Event Sourcing, Sidecar), Twelve-Factor App |

**Running the indexer:**

```bash
./scripts/index-architecture.sh
```

**Adding documents:** Edit `base/rag/indexers/architecture/sources.yaml`:

```yaml
documents:
  - name: "My Architecture Guide"
    url: "https://example.com/guide.pdf"
    type: pdf                    # pdf, html, or markdown
    collection: "arch_my_guide_v1"
    tags: ["custom", "internal"]
```

### Indexer 4: License Compliance Indexer

Indexes open source license data from three authoritative sources plus a built-in compatibility matrix, then makes this knowledge available to the Critic for compliance checking. The code indexer is also enhanced to detect and tag every code chunk with its source repository's SPDX license identifier.

**Why this matters:** LLMs confidently hallucinate license terms. When Synesis retrieves code patterns from OSS repos via RAG, the license metadata travels with the code. The Critic can then flag compatibility issues -- for example, warning that a pattern came from a GPL-3.0 project when the user's project is Apache-2.0.

**Data sources:**

| Source | What It Provides |
|--------|-----------------|
| [SPDX License List](https://spdx.org/licenses/) | 500+ licenses with SPDX ID, name, full text, OSI approval status |
| [Fedora License Data](https://docs.fedoraproject.org/en-US/legal/) | Red Hat / Fedora approval status (`allowed`, `allowed-content`, `not-allowed`) |
| [choosealicense.com](https://choosealicense.com/) | Structured permissions, conditions, and limitations per license |
| Built-in compatibility matrix | Pairwise license compatibility rules (e.g., "MIT -> Apache-2.0: compatible") |

**Milvus collection:** `licenses_v1` -- one summary chunk per license (structured metadata + description), additional chunks for long license full texts (GPL, AGPL, LGPL, MPL), and compatibility rule chunks for common license pairs.

**Code indexer enhancement:** Every code chunk and PR pattern chunk now carries a `repo_license` metadata field (e.g., `"Apache-2.0"`, `"MIT"`) detected from the repo's LICENSE file. The Critic extracts these during analysis.

**How the Critic uses license data:**

```
## License Compliance
The generated code draws on patterns from these licensed sources:
- fastapi (MIT) -- Red Hat: allowed
- kubernetes (Apache-2.0) -- Red Hat: allowed
If the user's project license is known, flag any compatibility concerns.
```

**Running the indexer:**

```bash
./scripts/index-license.sh                     # Index all licenses
./scripts/index-license.sh --license MIT        # Index a single license
./scripts/index-license.sh --force              # Re-index everything
```

**Customizing compatibility rules:** Edit `base/rag/indexers/license/compatibility.yaml` to add or modify pairwise compatibility rules:

```yaml
rules:
  - from: "MyLicense-1.0"
    to: "Apache-2.0"
    compatible: true
    note: "MyLicense-1.0 is permissive and compatible with Apache-2.0."
```

### How the Planner Uses Indexed Knowledge

The Supervisor node automatically selects which collections to query based on the task context:

| Task Type | Collections Queried |
|-----------|-------------------|
| Code generation (Python) | `python_v1` (style guide) + `code_python_v1` (code examples) + `patterns_python_v1` (PR context) |
| Task mentioning "kubernetes" | Above + `apispec_kubernetes_v1` |
| Task mentioning "license", "GPL", "copyright" | Above + `licenses_v1` |
| All tasks (Critic phase) | `arch_well_architected_v1` + `arch_cloud_patterns_v1` (architecture context) + license compliance check (if code chunks carry `repo_license` metadata) |

The Critic receives architecture and design pattern context as part of its prompt:

```
## Architecture Best Practices
The following design patterns and well-architected principles are relevant:
- [Retry Pattern]: Applications should handle transient faults by transparently retrying...
- [Reliability Pillar: Design for failure]: Workloads should be designed to...
Use these to evaluate the safety implications of the generated code.
```

### CronJob Schedules

| Environment | Code Indexer | API Spec Indexer | Architecture Indexer | License Indexer |
|------------|-------------|-----------------|---------------------|-----------------|
| **Dev** | Suspended (manual only) | Suspended (manual only) | Suspended (manual only) | Suspended (manual only) |
| **Staging** | 1st & 15th of month | 1st & 15th of month | 1st & 15th of month | 1st & 15th of month |
| **Prod** | Weekly (Sunday 3am) | Weekly (Sunday 4am) | Weekly (Sunday 5am) | Weekly (Sunday 6am) |

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `RAG_CODE_COLLECTIONS_ENABLED` | `true` | Include code/pattern collections in multi-collection queries |
| `RAG_MULTI_COLLECTION_MAX` | `3` | Max collections queried per request |
| `RAG_CRITIC_ARCH_ENABLED` | `true` | Give the Critic architecture context |
| `RAG_LICENSE_COLLECTION_ENABLED` | `true` | Include `licenses_v1` when task mentions license-related keywords |
| `RAG_CRITIC_LICENSE_ENABLED` | `true` | Give the Critic license compliance context from code chunk metadata |

### Resource Requirements

| Indexer | CPU Request | Memory | Disk | Typical Runtime |
|---------|------------|--------|------|-----------------|
| Code (all 50 repos) | 1 core | 2-8Gi | 50Gi (clone cache) | 2-6 hours |
| API Spec | 500m | 1-2Gi | minimal | 5-15 minutes |
| Architecture | 500m | 1-2Gi | minimal | 5-15 minutes |
| License | 250m | 512Mi | minimal | 5-10 minutes |

## Web Search (SearXNG)

Synesis includes a self-hosted **SearXNG** meta-search engine that gives LangGraph nodes live web context. This grounds the AI's responses in current information -- catching deprecated APIs, newly disclosed CVEs, and community-known error resolutions that aren't in the static RAG corpus.

### How It Works

SearXNG is an open-source, privacy-respecting meta-search engine that aggregates results from multiple upstream search engines. Synesis deploys it as an internal service -- no API keys, no external accounts, no tracking. The planner nodes query it via a simple JSON API.

### Search Profiles

Two query profiles are available, selected per-call based on the node's intent:

| Profile | Upstream Engines | Used For |
|---------|-----------------|----------|
| **web** | Google, Bing, DuckDuckGo | Latest docs, best practices, vulnerability checks, API grounding |
| **code** | GitHub, StackOverflow | Error resolution, code examples, known issues, community fixes |

### Smart Auto-Trigger Logic

Each LangGraph node independently decides whether to search. There is no blanket "search every request."

**Supervisor (Context Discovery + Grounding):**
- Triggered when the task mentions specific libraries/APIs, version numbers, or words like "latest"/"current"/"deprecated"
- Triggered when classification confidence is below 0.7 (uncertain tasks benefit from external grounding)
- Max 1 search per supervisor pass; simple/trivial tasks never trigger a search
- Profile: `web` for general knowledge, `code` for API-specific tasks

**Worker (Error Resolution):**
- Triggered **only on revision passes** (iteration > 0 with execution failure)
- First-pass code generation never searches
- Extracts the primary error message from sandbox output and searches the `code` profile
- Results are injected as a `## Web Search Context` block alongside RAG and failure hints

**Critic (Fact-Checking -- default disabled):**
- Parses import statements from the generated code to extract third-party package names
- Searches the `web` profile for `"CVE vulnerability {package} {year}"` for each non-stdlib import
- Results are injected as `## External Verification` in the critic prompt
- Default **off** because it adds latency to every successful path; enable via `SYNESIS_WEB_SEARCH_CRITIC_ENABLED=true`

### Network Requirements

SearXNG is the **only** Synesis service that requires outbound internet access (to reach Google, Bing, DuckDuckGo, GitHub, StackOverflow). The network policy for `synesis-search` allows:
- **Ingress**: Only from `synesis-planner` namespace on port 8080
- **Egress**: External IPs on port 443/80 (for upstream search engines) + DNS

All other Synesis namespaces remain fully internal with deny-all egress.

### Configuration

All web search settings are environment variables (prefixed `SYNESIS_`):

| Setting | Default | Description |
|---------|---------|-------------|
| `WEB_SEARCH_ENABLED` | `true` | Master switch for all web search |
| `WEB_SEARCH_URL` | `http://searxng.synesis-search.svc.cluster.local:8080` | SearXNG service URL |
| `WEB_SEARCH_TIMEOUT_SECONDS` | `5` | HTTP timeout per search call |
| `WEB_SEARCH_MAX_RESULTS` | `5` | Max results returned per query |
| `WEB_SEARCH_SUPERVISOR_ENABLED` | `true` | Enable supervisor context discovery searches |
| `WEB_SEARCH_WORKER_ERROR_ENABLED` | `true` | Enable worker error resolution searches |
| `WEB_SEARCH_CRITIC_ENABLED` | `false` | Enable critic vulnerability fact-checking |

### Resilience

The web search client includes a **circuit breaker** (3 failures -> 30-second open state). When SearXNG is down or slow, the circuit breaker opens and all search calls return empty results immediately -- no node is ever blocked waiting for a search. The pipeline continues normally with RAG and failure store context.

### Adding Custom Search Engines

Edit `base/search/configmap-settings.yaml` to add or remove upstream engines. SearXNG supports 100+ engines. For example, to add Wikipedia:

```yaml
engines:
  - name: wikipedia
    engine: wikipedia
    shortcut: wp
    disabled: false
```

### Replica Tuning

| Environment | Replicas | Resources |
|------------|----------|-----------|
| Dev | 1 | 100m-500m CPU, 128-256Mi RAM |
| Staging | 1 (base default) | 250m-1 CPU, 256-512Mi RAM |
| Prod | 2 (HA) | 250m-1 CPU, 256-512Mi RAM |

### Observability

Two Prometheus metrics track web search health:

- **`synesis_web_search_total`**: Counter by `profile` and `outcome` (success/error). Tracks search volume and failure rates.
- **`synesis_web_search_duration_seconds`**: Histogram by `profile`. Tracks latency distribution.

### Disabling Web Search

To disable all web search:

```bash
oc set env deployment/synesis-planner -n synesis-planner SYNESIS_WEB_SEARCH_ENABLED=false
```

Or remove `../../base/search` from the overlay's `kustomization.yaml` to avoid deploying SearXNG entirely.

## Web UI (Open WebUI)

Synesis includes a built-in **Open WebUI** instance that provides a polished chat interface for interacting with the AI assistant. It is pre-configured to connect to the LiteLLM gateway -- no manual API URL or key setup required.

### Zero-Configuration Setup

The deploy script automatically:

1. Generates the LiteLLM API key (or reuses an existing one)
2. Copies the key into the `synesis-webui` namespace as a Secret
3. Deploys Open WebUI with the API URL and key pre-injected as environment variables
4. Creates an OpenShift Route at `synesis.apps.openshiftdemo.dev`

On first visit, create an admin account. The `synesis-agent` model is available immediately.

### Routes by Environment

| Environment | Web UI URL | API URL |
|-------------|-----------|---------|
| **Dev** | `https://synesis.apps.openshiftdemo.dev` | `https://synesis-api.apps.openshiftdemo.dev` |
| **Staging** | `https://synesis-staging.apps.openshiftdemo.dev` | `https://synesis-api-staging.apps.openshiftdemo.dev` |
| **Prod** | `https://synesis.apps.openshiftdemo.dev` | `https://synesis-api.apps.openshiftdemo.dev` |

### Code Formatting

Open WebUI renders code blocks with syntax highlighting out of the box. When Synesis returns code in fenced markdown blocks (which the planner's response formatter produces), the UI displays them with:

- Language-specific syntax highlighting
- Copy-to-clipboard button
- Line numbers for longer snippets

The `synesis-agent` model routes through the full LangGraph pipeline (Entry → Supervisor → Planner/Worker → Sandbox → Critic), so code responses have already been linted, security-scanned, and critic-reviewed before reaching the UI.

**Phase/status display (Thinking, Validating, Testing):** The planner emits SSE status events during graph execution. See [docs/OPENWEBUI_PHASES.md](docs/OPENWEBUI_PHASES.md) for implementation details and troubleshooting if phases don't appear.

### Available Models in the UI

| Model Name | What It Does |
|------------|-------------|
| `synesis-agent` | Full pipeline: Supervisor → Planner → Executor → Critic → sandbox |
| `synesis-supervisor` | Direct access to Qwen3-14B (routing, critic) |
| `synesis-planner` | Direct access to Qwen3-14B planning (shares Supervisor) |
| `synesis-executor` | Direct access to Qwen3-Coder-Next-FP8 (code generation) |
| `synesis-critic` | Direct access to Qwen3-14B (safety review) |

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `WEBUI_AUTH` | `true` | Require login (first user becomes admin) |
| `ENABLE_SIGNUP` | `true` | Allow new user registration |
| `DEFAULT_MODELS` | `synesis-agent` | Pre-selected model for new conversations |
| `ENABLE_OLLAMA_API` | `false` | Disabled -- all inference goes through LiteLLM |

### Resource Requirements

| Environment | CPU Request | Memory | Storage |
|-------------|-----------|--------|---------|
| Dev | 100m | 256Mi | 5Gi PVC |
| Staging/Prod | 250m | 512Mi | 5Gi PVC |

Prod scales to 2 replicas. The PVC stores user accounts, chat history, and settings.

### Network Policy

Open WebUI can only reach the LiteLLM gateway (`synesis-gateway:4000`) and DNS. It has no access to the planner, Milvus, sandbox, or external internet. All model inference goes through the LiteLLM proxy.

### Troubleshooting: "500: Open WebUI: Server Connection Error"

**Cause:** (a) Open WebUI cannot reach its backend, (b) bad URL persisted in Admin → Settings, or (c) planner's graph execution failed (models down, timeout, etc.).

**If /v1/models works but chat fails:** The planner is reachable; the failure is during graph execution. Check:

```bash
# Planner logs show the actual exception
oc logs -n synesis-planner -l app.kubernetes.io/name=synesis-planner --tail=100

# Admin status page: are models healthy?
# Visit https://synesis-admin.<cluster>/admin/status — executor/supervisor/critic should show OK
```

**Quick fixes:**

1. **Reset persisted config** — dev-webui overlay sets `RESET_CONFIG_ON_START=true` so env vars override DB. Re-apply and restart:
   ```bash
   kustomize build overlays/dev-webui | oc apply -f -
   oc rollout restart deployment/open-webui -n synesis-webui
   ```

2. **Verify planner is reachable** (when using direct-planner):
   ```bash
   oc get pods -n synesis-planner -l app.kubernetes.io/name=synesis-planner
   oc run -it --rm debug --image=curlimages/curl --restart=Never -n synesis-webui -- \
     curl -s http://synesis-planner.synesis-planner.svc.cluster.local:8000/v1/models
   ```
   If the curl fails, the planner is down or unreachable.

3. **Switch to LiteLLM** — if planner path is broken, point Open WebUI at LiteLLM instead: remove the direct-planner patch from your overlay and set `OPENAI_API_BASE_URL` to `http://litellm-proxy.synesis-gateway.svc.cluster.local:4000/v1`.

### Troubleshooting: "Connection error" / "OpenAIException" for synesis-agent

**Quick fix: bypass LiteLLM.** The dev overlay includes `openwebui-direct-planner.yaml`, which points Open WebUI directly at the planner. Redeploy and Open WebUI will talk to the planner without LiteLLM (synesis-agent only; individual models won't appear in the UI).

**To revert to LiteLLM:** Remove the `openwebui-direct-planner.yaml` patch from `overlays/dev/kustomization.yaml` and redeploy.

**Debug LiteLLM** (if you need multi-model routing):

```bash
# 1. Planner running and updated?
oc get pods -n synesis-planner -l app.kubernetes.io/name=synesis-planner
oc rollout status deployment/synesis-planner -n synesis-planner

# 2. Connectivity from gateway namespace
oc run -it --rm debug --image=curlimages/curl --restart=Never -n synesis-gateway -- \
  curl -sv http://synesis-planner.synesis-planner.svc.cluster.local:8000/v1/models

# 3. Planner logs (400? stream=true rejection before SSE fix?)
oc logs -n synesis-planner -l app.kubernetes.io/name=synesis-planner --tail=50

# 4. LiteLLM verbose
oc set env deployment/litellm-proxy -n synesis-gateway LITELLM_LOG=DEBUG
# ... reproduce error, check logs ...
oc set env deployment/litellm-proxy -n synesis-gateway LITELLM_LOG-
```

**Architecture note:** synesis-agent is the planner (LangGraph), not a vLLM model. Cursor and Claude Code can use the **synesis-executor-api** route for direct vLLM (raw code model) or **synesis-planner-api** for the full agentic pipeline (planning → sandbox → critic).

## Hardware Sizing

### GPU (Qwen3-Coder-Next-FP8 / Executor -- Code Generation)

The executor model requires a dedicated GPU. Memory bandwidth is the primary driver of token generation speed (decode is memory-bound). With `--max-model-len=65536` and `--gpu-memory-utilization=0.90`:

- Model weights (FP8): ~40 GB
- KV cache (64K context, single request): ~8-10 GB
- Total active VRAM: ~48-50 GB

| GPU | VRAM | Bandwidth | Est. tok/s (single user) | Notes |
|-----|------|-----------|--------------------------|-------|
| **NVIDIA A100 80GB SXM** | 80 GB | 2.0 TB/s | ~30-40 | **Recommended default.** Headroom for concurrent requests and future context length increases. |
| NVIDIA H100 80GB SXM | 80 GB | 3.35 TB/s | ~50-60 | Fastest option. ~1.7x faster decode than A100. Use if budget allows. |
| NVIDIA L40S | 48 GB | 864 GB/s | ~15-25 | Cost-effective alternative. VRAM fits but decode speed is notably slower. |
| NVIDIA A100 40GB | 40 GB | 1.5 TB/s | ~25-35 | Tight fit. Requires `--max-model-len=8192` or lower `--gpu-memory-utilization`. Not recommended for production. |

One GPU node is sufficient. `--tensor-parallel-size` is not set (TP=1), so multi-GPU is not required. To scale throughput for many concurrent users, add a second GPU node and scale the InferenceService replicas rather than adding TP.

**Verify GPU usage:** Run `./scripts/verify-gpu-usage.sh` to confirm supervisor, critic, and executor pods have `nvidia.com/gpu=1` and show VRAM usage. See `docs/WORKFLOW.md` § GPU Verification.

### CPU (Qwen3-8B-FP8 -- Supervisor, Planner, Critic)

Supervisor, Planner, and Critic run on GPU (1×8Gi each) with vLLM. They use the **synesis-supervisor-critic** ServingRuntime with prefix caching enabled for shared system-prompt reuse across requests.

| Model | Deployment | Context | Notes |
|-------|-------------|---------|-------|
| Qwen3-8B-FP8 | synesis-supervisor | 32K | Prefix cache enabled |
| Qwen3-8B-FP8 | synesis-planner | 32K | Shares Supervisor model |
| Qwen3-8B-FP8 | synesis-critic | 32K | Prefix cache enabled |

| Setting | Base / Prod | Dev |
|---------|-------------|-----|
| CPU request | 8 cores | 4 cores |
| CPU limit | 16 cores | 8 cores |
| Memory request | 16 Gi | 12 Gi |
| Memory limit | 24 Gi | 18 Gi |

For lowest latency, schedule CPU model pods on dedicated nodes with 16+ physical cores.

### Cluster Summary (Production)

| Component | Node Type | Count | Minimum Spec |
|-----------|-----------|-------|--------------|
| **GPU models** | | | |
| synesis-executor (Qwen3-Coder-Next-FP8) | GPU node | 1 | 1x L40S 48GB, 8 vCPU, 64 GB RAM |
| **GPU models (8B)** | | | |
| synesis-supervisor (Qwen3-8B-FP8) | GPU node | 1 | 1×8Gi GPU, prefix cache |
| synesis-planner (shared) | — | Shares Supervisor |
| synesis-critic (Qwen3-8B-FP8) | GPU node | 1 | 1×8Gi GPU, prefix cache |
| **Services** | | | |
| Planner + RAG + Services | Worker node | 2 | 8 vCPU, 16 GB RAM each |
| Milvus + Infra | Worker node | 1 | 4 vCPU, 16 GB RAM |

## Adding a New Language Pack

1. Copy the template:
   ```bash
   cp -r base/rag/language-packs/_template base/rag/language-packs/python
   ```

2. Edit `manifest.yaml` with language metadata and `sources.yaml` with document URLs.

3. Load it:
   ```bash
   ./scripts/load-language-pack.sh python
   ```

## Adding a New Critic/Evaluator Node

1. Create `base/planner/app/nodes/your_node.py` following the same interface (takes state dict, returns state updates).
2. Register in `graph.py`: `graph_builder.add_node("your_node", your_node_func)`
3. Wire edges: add conditional or direct edges from/to existing nodes.
4. Optionally add a ConfigMap with prompts for your new node.

## Operator Vision

The long-term goal is an OpenShift Operator (`SynesisAssistant` CRD) that can be published to OperatorHub, enabling one-click deployment of the full stack on any OpenShift AI cluster. v1 uses Kustomize + shell scripts as the "operator."

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on submitting issues, pull requests, and code standards.

## License

Apache License 2.0. See [LICENSE](LICENSE) for the full text.
