# LSP Intelligence

Synesis includes an optional **LSP Gateway** that provides deep type checking and symbol analysis beyond what basic linters (ruff, eslint, shellcheck) can catch. When generated code fails validation, the LSP Gateway runs language-specific diagnostic tools to identify type errors, undefined symbols, import resolution failures, and borrow checker violations — then feeds those structured diagnostics back to the Worker for a more informed revision.

> **Exception-flow design**: Like the sandbox, LSP analysis is not in the default pipeline. It fires on code validation failure or when explicitly requested, acting as a diagnostic tool for the Critic and Worker to use when code quality issues arise. See [docs/WORKFLOW.md](WORKFLOW.md) for routing details.

## Why LSP Matters

Standard linters catch syntax and style issues. But type-level errors — calling a function with the wrong argument types, using an undefined variable, importing a non-existent module — often pass linting yet fail at runtime. These are exactly the errors LLMs frequently produce. The LSP Gateway catches them before execution or enriches the error context when execution fails, dramatically reducing revision loops.

## How It Works

1. **On executor failure** (default `lsp_mode: "on_failure"`): The failed code is sent to the LSP Gateway for deep analysis. The structured diagnostics (type errors, undefined symbols, wrong argument counts) are injected into the Worker's next revision prompt alongside the sandbox execution errors.

2. **Always mode** (`lsp_mode: "always"`): Every code generation pass goes through LSP analysis before sandbox execution, catching type-level issues before they become runtime failures.

3. **Disabled mode** (`lsp_mode: "disabled"`): LSP analysis is skipped entirely.

```
Default (on_failure):
  Worker -> Executor -> [fail] -> LSP Analyzer -> Worker (with diagnostics)

Always mode:
  Worker -> LSP Analyzer -> Executor -> [fail] -> Worker (with diagnostics)
```

## Supported Languages and Engines

| Language | Engine | What It Catches |
|----------|--------|-----------------|
| Python | basedpyright | Undefined variables, wrong argument types, import resolution, type incompatibilities |
| Go | go vet + staticcheck | Module-aware analysis, vet issues, common Go pitfalls |
| TypeScript/JavaScript | tsc --noEmit | Type mismatches, missing properties, wrong generics, import errors |
| Bash/Shell | shellcheck (JSON) | SC-level categories with structured severity for richer feedback |
| Java | javac -Xlint:all | Compilation errors, type mismatches, deprecation, unchecked operations |
| Rust | cargo check | Full compiler diagnostics, borrow checker, lifetime issues, unused imports |

## Architecture

The LSP Gateway is a single FastAPI microservice deployed in its own namespace (`synesis-lsp`) that wraps all 6 language analysis engines. Each engine uses **CLI diagnostic mode** (not persistent LSP stdio connections), making it stateless and well-suited for analyzing isolated code snippets.

Per-language circuit breakers ensure a broken language toolchain (e.g., Go toolchain down) doesn't affect other languages. The gateway never blocks the pipeline — on timeout or circuit-breaker trip, analysis is skipped and the pipeline continues normally.

## Configuration

All LSP settings are environment variables (prefixed `SYNESIS_`):

| Setting | Default | Description |
|---------|---------|-------------|
| `LSP_ENABLED` | `true` | Enable/disable LSP analysis |
| `LSP_MODE` | `on_failure` | When to run: `on_failure`, `always`, or `disabled` |
| `LSP_GATEWAY_URL` | `http://lsp-gateway.synesis-lsp.svc:8000` | LSP Gateway service URL |
| `LSP_TIMEOUT_SECONDS` | `30` | Analysis timeout per request |

## Resource Requirements

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

## Observability

Four Perses panels track LSP health:

- **LSP Analysis Latency (p50/p95)**: Time series by language — identifies slow engines.
- **LSP Diagnostics by Severity**: Rate of errors vs warnings found by each language.
- **LSP Language Usage**: Pie chart showing which languages are most frequently analyzed.
- **LSP Circuit Breaker State**: Per-language circuit breaker status (CLOSED/HALF-OPEN/OPEN).

## Disabling LSP

To disable LSP entirely (saves ~2Gi RAM):

```bash
oc set env deployment/synesis-planner -n synesis-planner SYNESIS_LSP_MODE=disabled
```

Or remove `../../base/lsp` from the overlay's `kustomization.yaml` to avoid deploying the gateway pod entirely.

---

Back to [README](../README.md) | See also: [Sandbox](SANDBOX.md), [Workflow](WORKFLOW.md)
