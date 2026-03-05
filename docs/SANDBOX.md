# Code Execution Sandbox

Synesis validates generated code when quality concerns arise. Code snippets produced by the **Worker** can be sent to the **Sandbox** — an isolated execution environment that runs linting, security scanning, and actual execution. If any step fails, the code is routed back to the Worker with detailed error context for revision.

> **Exception-flow design**: The sandbox is not in the default pipeline. It fires when code validation is needed — triggered by the Critic or on explicit request. This keeps the happy path fast. See [docs/WORKFLOW.md](WORKFLOW.md) for routing details.

## How It Works

1. **Worker generates code** — the General or Coder LLM produces the snippet; target language is passed in state.
2. **Sandbox runs the code** — via warm pool (HTTP) or ephemeral K8s Job. The pod runs a pipeline: lint → security scan → execute.
3. **On success** (exit code 0, lint passed, security passed): the result moves forward to the Critic for analysis.
4. **On failure**: the error context (lint errors, security findings, runtime output) is injected into the state and the graph routes back to the Worker for a revision pass. This loops up to `max_iterations` (default 3).

## Sandbox Security

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

## Supported Languages and Tools

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

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `SANDBOX_ENABLED` | `true` | Enable/disable sandbox execution |
| `SANDBOX_NAMESPACE` | `synesis-sandbox` | Namespace for sandbox Jobs |
| `SANDBOX_IMAGE` | `synesis-sandbox:latest` | Sandbox container image |
| `SANDBOX_TIMEOUT_SECONDS` | `30` | Job active deadline |
| `SANDBOX_CPU_LIMIT` | `2` | CPU limit per sandbox pod |
| `SANDBOX_MEMORY_LIMIT` | `1Gi` | Memory limit per sandbox pod |

To disable the sandbox entirely, set `SYNESIS_SANDBOX_ENABLED=false` in the planner deployment.

## Warm Pool (Low-Latency Execution)

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

---

Back to [README](../README.md) | See also: [LSP Intelligence](LSP.md), [Workflow](WORKFLOW.md)
