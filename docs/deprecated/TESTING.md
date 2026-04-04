# Synesis test suite — CI, local, and manual

This document is the **inventory** of how we validate Synesis: what runs automatically, what needs secrets or live APIs, and where to extend coverage. Use it when adding features or tuning CI.

**Related:** [OPENAI_COMPAT_PROBING.md](./OPENAI_COMPAT_PROBING.md) (HTTP probe + streaming `usage` semantics), [DEVELOPMENT_CHECKS.md](./DEVELOPMENT_CHECKS.md) (post-deploy intent validation, Makefile targets).

---

## 1. Continuous integration (GitHub Actions)

| Workflow | What it runs | Blocking on PR? |
|----------|----------------|-----------------|
| [`.github/workflows/lint.yml`](../.github/workflows/lint.yml) | Ruff (all `base/`), vulture, yamllint, kustomize build (matrix `dev`/`staging`/`prod`), ShellCheck, Hadolint, **`pytest` for `base/planner/tests/`** on Python **3.11** (required) and **3.13** (experimental, `continue-on-error`) | Yes (required jobs) |
| [`.github/workflows/security.yml`](../.github/workflows/security.yml) | CodeQL, Checkov, Grype, Bandit, Semgrep, pip-audit, npm audit | Yes (per workflow config) |
| [`.github/workflows/openai-compat-probe.yml`](../.github/workflows/openai-compat-probe.yml) | Optional `scripts/synesis_openai_capability_probe.py` when secrets are set; **`continue-on-error: true`** | **No** (never blocks merge) |
| [`.github/workflows/quality-pipeline.yml`](../.github/workflows/quality-pipeline.yml) | Quality runner / scheduled jobs (not planner `pytest` by default) | Per workflow |
| [`.github/workflows/retrieval-regression.yml`](../.github/workflows/retrieval-regression.yml) | RAG/regression against cluster inputs | Manual / scheduled |

**Important:** Default CI **does not** run `base/yarn` pytest today. Run Yarn tests locally (see §3) until a CI job is added.

---

## 2. Planner (`base/planner`)

### 2.1 Automated unit / contract tests (CI + local)

- **Command:** `cd base/planner && uv run pytest tests/ -v` (or `python -m pytest tests/` with `requirements-test.txt` as in CI).
- **Scope:** Full `tests/` tree, including OpenAI-shaped checks in `tests/test_api.py` (`/v1/models`, `/v1/chat/completions`, streaming + `stream_options.include_usage`, usage keys on non-stream responses).
- **Integration-marked tests:** `tests/test_integration_live.py` uses `pytest.mark.integration` and **`pytest.mark.skipif(not SYNESIS_TEST_AUTH)`** — in CI they **skip** unless a token is injected (normally they do not run in GitHub).

### 2.2 Manual / optional live HTTP (planner)

| Env | Purpose |
|-----|--------|
| `SYNESIS_TEST_AUTH` | Bearer value (PAT `syn-…` or service token) — **required** to run integration module |
| `SYNESIS_PLANNER_BASE_URL` | Default `http://127.0.0.1:8000` |
| `SYNESIS_LIVE_CHAT=1` | Enables one real `POST /v1/chat/completions` (uses quota) |

```bash
export SYNESIS_TEST_AUTH='…'
export SYNESIS_PLANNER_BASE_URL='https://…'
uv run pytest base/planner/tests/test_integration_live.py -m integration -v
```

### 2.3 OpenAI-compat probe (manual / optional workflow)

```bash
export SYNESIS_PROBE_PLANNER_URL=http://127.0.0.1:8000
export SYNESIS_PROBE_TOKEN='…'   # optional; enables chat probe
python3 scripts/synesis_openai_capability_probe.py
# Strict exit code for automation:
python3 scripts/synesis_openai_capability_probe.py --strict
```

---

## 3. Yarn (`base/yarn`)

- **Command:** `cd base/yarn && uv run pytest tests/ -v` (install deps per Yarn `README` / Container image).
- **Markers:** `pytest.ini` defines `integration` for live HTTP tests (`SYNESIS_TEST_AUTH`, `SYNESIS_YARN_BASE_URL`, optional `SYNESIS_LIVE_CHAT=1`).
- **CI:** Not part of default `lint.yml` matrix (see §1).

---

## 4. OpenAI-shaped API — what the **general LLM** and **Yarn coder** fronts need

Open WebUI (and similar clients) talk to **planner-ts** for the main chat UX (default `OPENAI_API_BASE_URL`). **IDE / coder** clients talk to **Yarn** (`synesis-yarn`). Below: minimum surface area, current status, and how we treat gaps.

Legend: **Yes** = implemented and should have contract tests; **Partial** = subset or quirks documented; **No** = not implemented — clients must not rely on it (return **404** for unknown routes; use **501** only if we add an explicit stub endpoint).

### 4.1 Shared expectations (both surfaces)

| Capability | Planner | Yarn | Tests / notes |
|------------|---------|------|----------------|
| `GET /v1/models` | Yes — OpenAI Model core fields + optional `description` | Yes — `synesis-yarn` model | `test_api.py` (planner), `test_api_integration.py` (Yarn); probe checks shape |
| `POST /v1/chat/completions` non-stream | Yes | Yes | Planner: `test_api.py`, live optional; Yarn: integration + executor tests |
| `POST /v1/chat/completions` stream (SSE) | Yes — Synesis status events in-stream; final chunk `usage` only if `stream_options.include_usage` | Yes — tool streaming via SSE chunks | Planner streaming tests (fallback path + `include_usage`); Yarn stream handler tests |
| Response `usage` (non-stream) | Yes — `prompt_tokens`, `completion_tokens`, `total_tokens`, `cached_prompt_tokens` | Yes — aggregated usage dict on final non-stream | Assert keys in planner `test_api.py`; live chat in `test_integration_live.py` |
| `model` id aliases | Yes — `Synesis`, `Synesis Thinking`, `synesis-agent`, etc. | Yes — `synesis-yarn` | Normalization tests (planner) |
| Auth | Bearer + PAT `syn-…` + trusted gateway headers | Bearer: PAT or Keycloak JWT (see Yarn middleware) | PAT tests planner; Yarn auth tests |

### 4.2 General LLM (planner) — Open WebUI → planner-ts path

| Capability | Status | Action if missing |
|------------|--------|-------------------|
| Chat + streaming + usage (above) | Implemented | Extend `test_api.py` / live tests when behavior changes |
| `extras` / unknown JSON fields | Ignored (`extra: ignore` on request models) | Safe for OWUI to send noise |
| Images, audio, embeddings, assistants, batch, files, fine-tunes | **No** | **404** on unknown paths (FastAPI default); do not advertise in `/v1/models` |
| Tool calls (OpenAI `tools` in chat) | Pipeline-internal / router — not necessarily same as OpenAI tool schema to OWUI | Document in planner docs when OWUI sends tools; add tests when product commits to a stable contract |

### 4.3 Yarn (coder) — IDE / agent clients

| Capability | Status | Action if missing |
|------------|--------|-------------------|
| `POST /v1/chat/completions` with tools / streaming | Core product path | Covered by Yarn unit + integration tests; extend when tool schema changes |
| `GET/POST /v1/mcp/tools` (+ `/call`) | **Synesis extension** (not OpenAI core) | Document for Cursor-style clients; test `test_api_integration` / MCP tests |
| `GET /v1/diagnostics/{id}`, `GET /metrics` | Operational — not OpenAI | Auth-gated; not required for generic OpenAI SDK |
| Images, embeddings, assistants, … | **No** | **404** unless we add explicit **501** stubs for clearer SDK errors |

### 4.4 Test backlog (prioritized)

1. **CI:** Add `base/yarn` `pytest` job mirroring planner in `lint.yml` (same Python matrix or single 3.11).
2. **Planner:** Optional pytest using **`openai` Python client** against localhost (dev-only) for wire-format parity.
3. **Yarn:** Contract test matrix for **tool_calls** round-trip and **stream** final chunk shape (align with OpenAI client expectations).
4. **Explicit 501 (optional):** For `POST /v1/images/generations` etc., return structured JSON `{"error": {"message": "Not implemented", "type": "not_implemented"}}` if we want friendlier SDK errors than 404.

---

## 5. Other Python services

Admin, indexer, RAG microservices, MCP: tests run **per component** (see each `base/*/pytest.ini` or `tests/` if present). Security workflow may run scanners over shared paths; **not** all services have full pytest in CI — check the relevant `Containerfile` / README.

---

## 6. Industry patterns — OpenAI docs, cookbooks, SDKs

We do **not** clone or run OpenAI’s full upstream suites against Synesis in CI (they target OpenAI’s API or the SDK’s mock server). They are still useful **references** for shapes and client behavior:

| Source | Use for Synesis |
|--------|------------------|
| [OpenAI API reference — Chat](https://platform.openai.com/docs/api-reference/chat) | Request/response fields (`stream_options`, `usage`, model object). |
| [OpenAI API reference — Models](https://platform.openai.com/docs/api-reference/models) | `GET /v1/models` object shape (`id`, `object`, `created`, `owned_by`). |
| [OpenAI Cookbook](https://cookbook.openai.com/) | Patterns for streaming, tool calls, retries — pick recipes that map to endpoints we implement; translate to pytest + `httpx`/`TestClient` against planner/Yarn. |
| [openai-python](https://github.com/openai/openai-python) | SDK tests run against a **mock server** (Prism / OpenAPI) and custom harnesses — good ideas for **transport** (SSE, timeouts), not copy-paste of all 800+ tests. |
| [OpenAI Node/JS SDK](https://github.com/openai/openai-node) | If we add Node-based contract tests later, same idea: small subset focused on chat + models. |

**Practical next steps (backlog):**

1. Maintain a short checklist in this doc (or in `docs/OPENAI_COMPAT_PROBING.md`) mapping **cookbook recipes** → **implemented?** → **test file**.
2. Optional dev dependency: run a **minimal** subset of `openai` Python client calls against a **local** planner in a non-CI script (similar to the probe, but using the official client for serialization parity).
3. Keep **CI** bounded: mocked `TestClient` tests + ruff; live and SDK-heavy checks stay manual or optional workflows.

---

## 7. Quick local commands (summary)

```bash
# Planner (matches CI intent)
cd base/planner && uv pip install -r requirements-test.txt && uv run pytest tests/ -v --tb=short

# Yarn
cd base/yarn && uv run pytest tests/ -v --tb=short

# Repo-wide ruff (matches CI)
uvx ruff check base/
```

---

## 8. Validation Ring (CI-to-Cluster Security)

### Architecture

CI regression tests that need a running Synesis cluster execute inside an isolated **validation ring** namespace (`synesis-validation`). This prevents credential leakage and keeps CI jobs from touching production data.

```
┌─────────────────────────────────────────────────────────────────────┐
│  GitHub Actions                                                     │
│  ┌──────────────┐  ┌─────────────────────┐  ┌──────────────────┐  │
│  │  lint.yml     │  │ prompt-regression   │  │ retrieval-       │  │
│  │  (always)     │  │ .yml (on PR)        │  │ regression.yml   │  │
│  └──────────────┘  └────────┬────────────┘  └────────┬─────────┘  │
│                              │                        │             │
│              ┌───────────────┴────────────────────────┘             │
│              │ self-hosted runner / in-cluster Job                  │
│              ▼                                                      │
│  ┌──────────────────────────────────────────────────┐              │
│  │  synesis-validation namespace                     │              │
│  │  • deny-all network policy                        │              │
│  │  • egress only to planner + admin                 │              │
│  │  • validation-runner ServiceAccount               │              │
│  │  • synesis-internal-service-auth secret            │              │
│  │  • synthetic/non-prod data only                   │              │
│  └──────────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

### Security Principles

- **No static kubeconfig** in repo or PR context
- **Environment-scoped secrets**: `validation` GitHub environment with branch protections
- **In-cluster execution preferred**: self-hosted runner or K8s Job with namespace-scoped SA token
- **Validation ring data only**: never customer PII in CI replay
- **Artifact scrubbing**: no tokens or sensitive prompts in uploaded artifacts
- **Secret redaction**: workflows disable `set-output` for sensitive values

### Manifests

- `base/validation-ring/namespace.yaml` — namespace with deny-all default
- `base/validation-ring/network-policy.yaml` — egress to planner (8000) + admin (8080) + DNS
- `base/validation-ring/serviceaccount.yaml` — `validation-runner` SA
- `base/validation-ring/replay-job.yaml` — K8s Job template for Testing Labs replays

### Setup

```bash
# Apply validation ring
oc apply -k base/validation-ring/

# Sync auth secret to validation namespace (automatic via deploy.sh)
./scripts/deploy.sh api
```

---

## 9. Quality Regression Workflows

### 9.1 Three activation modes

Live validation tests (prompt regression, retrieval regression) support three modes so you can control cost during heavy development and still guarantee coverage at release time.

| Mode | Trigger | When to use | Cost | How to activate |
|------|---------|-------------|------|-----------------|
| **PR-gated (default off)** | `pull_request` → planner paths | Continuous development — off by default to avoid token burn on every push | Per-PR (when enabled) | Set `SYNESIS_VALIDATION_ENABLED=true` as a GitHub **Variable** on the repo |
| **Manual dispatch** | `workflow_dispatch` via Actions UI or `gh` CLI | Ad-hoc testing after a big change, before a release, or local debugging | On-demand | Trigger manually (see §9.3) |
| **Release ring** | `release: published` | Tag/release pipeline — runs automatically when you cut a release | Per-release | Create a GitHub release or tag |

**PR-gated mode** is intentionally off by default. Offline validation (YAML structure, router governance unit tests) always runs on PR. The live suite only fires when the repo variable is set, so daily pushes don't burn tokens.

**Manual dispatch** is the primary mode during active development. Run it when you want to validate changes against the live cluster without waiting for a PR merge.

**Release ring** fires automatically on `release: published`. When you're down to fewer pushes and cutting releases, every release gets a full regression pass.

### 9.2 Lane A: Merge-Blocking CI Gates

| Workflow | Trigger | What It Checks | Blocking? |
|----------|---------|---------------|-----------|
| `prompt-regression.yml` — Router Governance | PR touching `base/planner/app/nodes/**`, `graph/**`, `prompts/**`, `state.py`, etc. | `test_router_governance.py`: role boundaries, evidence schema, retrieval bounds, anti-oscillation | Yes (required job) |
| `prompt-regression.yml` — Prompt Suite Offline | Same trigger | YAML validation, required categories present (adversarial, retrieval_quality, node_routing, grounding) | Yes |
| `prompt-regression.yml` — Prompt Suite Live | PR (when `SYNESIS_VALIDATION_ENABLED=true`), manual dispatch, or release | Run adversarial/retrieval/routing/grounding suite against cluster, fail on regression | Yes (when triggered) |
| `retrieval-regression.yml` | PR (when enabled), manual dispatch, or release | Retrieval quality metrics vs baseline (recall@k, mrr@k, ndcg@k within tolerance) | Yes (when triggered) |
| `guardrails-tests.yml` | PR touching `base/security/**`, `injection_scanner.py`, `nodes/**`, `graph/**`, `state.py` | Guardrails core + scanner integration tests | Yes |

### 9.3 Running live tests manually

**From GitHub Actions UI:**

Go to Actions > select workflow > "Run workflow". For `prompt-regression.yml` you can override `categories` (space-separated) and `model`.

**From the CLI (`gh`):**

```bash
# Prompt regression — all default categories
gh workflow run prompt-regression.yml

# Prompt regression — specific categories only
gh workflow run prompt-regression.yml -f categories="grounding adversarial"

# Prompt regression — different model
gh workflow run prompt-regression.yml -f model="synesis-agent" -f categories="grounding"

# Retrieval regression — custom tolerance
gh workflow run retrieval-regression.yml -f tolerance=0.03

# Retrieval regression — custom Milvus host (port-forwarded)
gh workflow run retrieval-regression.yml -f milvus_host=localhost:19530
```

**Locally (no GitHub required):**

```bash
# Prompt regression suite against local or remote planner
python tests/prompts/run_test_suite.py \
  --api-url http://127.0.0.1:8000 \
  --api-key "$SYNESIS_API_KEY" \
  --category grounding adversarial \
  --verbose

# Dry run — validate YAML and show execution plan without sending requests
python tests/prompts/run_test_suite.py --dry-run

# Run a single prompt by ID
python tests/prompts/run_test_suite.py \
  --api-url http://127.0.0.1:8000 \
  --api-key "$SYNESIS_API_KEY" \
  --ids ground-01

# Save full response outputs for review
python tests/prompts/run_test_suite.py \
  --api-url http://127.0.0.1:8000 \
  --api-key "$SYNESIS_API_KEY" \
  --category grounding \
  --save-outputs
```

### 9.4 GitHub secrets and variables

Canonical list: **[CI_GITHUB_VALIDATION.md](../CI_GITHUB_VALIDATION.md)**.

| Name | Type | Where | Purpose |
|------|------|-------|---------|
| `SYNESIS_VALIDATION_ENABLED` | **Variable** | Repo settings > Variables | Set to `true` to enable workflows that consult it; remove or set `false` to disable |
| `SYNESIS_PLANNER_EVAL_URL` | **Variable** | `validation` environment or repo | Planner API base URL (e.g. `https://api.kybern.dev`) |
| `SYNESIS_YARN_EVAL_URL` | **Variable** | `validation` environment or repo | Yarn OpenAI base URL (e.g. `https://coder.kybern.dev`) |
| `SYNESIS_INTERNAL_SERVICE_TOKEN` | **Secret** | `validation` environment | Internal application token (`synesis-internal-service-auth`) — **RAG / knowledge/search** |
| `SYNESIS_TEST_PAT_TOKEN` | **Secret** | `validation` environment | PAT for user-space planner/Yarn `/v1` (prompt regression, probes, Yarn live verify) |

The `validation` GitHub **Environment** provides branch protections and reviewer gates. Secrets are scoped to this environment and not visible to other workflows.

**Deprecated:** `SYNESIS_VALIDATION_API_URL` / `SYNESIS_VALIDATION_API_KEY` — use `SYNESIS_PLANNER_EVAL_URL` plus **`SYNESIS_INTERNAL_SERVICE_TOKEN`** (RAG) and **`SYNESIS_TEST_PAT_TOKEN`** (live chat suites).

### 9.5 Lane B: Testing Labs (Admin-Facing)

Admin UI under **RAG Pipeline > Testing Labs** for customer validation:

- **Create replay runs** from selected trace sets or prompt suite categories
- **Compare baseline vs candidate** model/corpus with per-prompt metrics
- **Score**: citation rate, latency, token count, pass/fail verdicts
- **HITL review queue**: approve/reject individual results
- **Execution**: K8s Jobs in `synesis-validation` namespace, optional Tekton pipeline for governed promotions

### 9.6 Baseline Management

- `benchmarks/retrieval/baseline.json` — seed file, auto-overwritten on first benchmark run
- To update baseline after a deliberate quality change:

```bash
python benchmarks/retrieval/bench_hybrid.py \
  --milvus-uri http://localhost:19530 \
  --embedder-url http://localhost:8082/v1 \
  --output benchmarks/retrieval/baseline.json
```

---

## 10. Yarn-TS Live Verification (Reducers)

See [LIVE_VERIFICATION_M9.md](./LIVE_VERIFICATION_M9.md) for the full runbook.

### Quick reference

```bash
cd base/yarn-ts

# CI-style: SYNESIS_YARN_EVAL_URL + SYNESIS_TEST_PAT_TOKEN (see CI_GITHUB_VALIDATION.md)
SYNESIS_YARN_EVAL_URL=https://coder.kybern.dev SYNESIS_TEST_PAT_TOKEN=syn-… npm run verify:live

# Full mode (adds Claude API path)
SYNESIS_YARN_EVAL_URL=https://… npm run verify:live:full

# A-B reducer savings comparison
SYNESIS_YARN_EVAL_URL=https://… npm run verify:ab
```

Scenarios send deterministic tool-result payloads for each reducer family (`pytest`, `tsc`, `lint`, `git`, `search`) and assert telemetry counter movement. Reports emit structured JSON for archival. See the M9 doc for regression interpretation and CI integration plans.

---

## 11. Changelog

| Date | Change |
|------|--------|
| 2026-03-23 | Initial inventory: CI vs manual, planner/Yarn/probe, OpenAI reference pointers. |
| 2026-03-23 | §4: Planner vs Yarn OpenAI surface — implemented vs not implemented, test backlog. |
| 2026-03-24 | §8: Validation ring (CI-to-cluster security). §9: H2 quality regression workflows + Testing Labs. |
| 2026-03-24 | §9: Three-mode activation (PR-gated, dispatch, release). Local/CLI usage. Secrets reference. |
| 2026-03-25 | §10: Yarn-TS live verification suite (M9) — reducer smoke tests, telemetry assertions, A-B comparison. |
