# Synesis test suite — CI, local, and manual

This document is the **inventory** of how we validate Synesis: what runs automatically, what needs secrets or live APIs, and where to extend coverage. Use it when adding features or tuning CI.

**Related:** [OPENAI_COMPAT_PROBING.md](./OPENAI_COMPAT_PROBING.md) (HTTP probe + streaming `usage` semantics), [DEVELOPMENT_CHECKS.md](./DEVELOPMENT_CHECKS.md) (post-deploy intent validation, Makefile targets).

---

## 1. Continuous integration (GitHub Actions)

| Workflow | What it runs | Blocking on PR? |
|----------|----------------|-----------------|
| [`.github/workflows/lint.yml`](../.github/workflows/lint.yml) | Ruff (all `base/`), vulture, yamllint, kustomize build (matrix `dev`/`staging`/`prod`), ShellCheck, Hadolint, **`pytest` for `base/planner/tests/`** on Python **3.11** (required) and **3.13** (experimental, `continue-on-error`) | Yes (required jobs) |
| [`.github/workflows/security.yml`](../.github/workflows/security.yml) | CodeQL, Trivy, Bandit, npm audit (e.g. admin frontend), targeted static paths | Yes (per workflow config) |
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

Open WebUI (and similar clients) talk to **LiteLLM → planner** for the main chat UX. **IDE / coder** clients talk to **Yarn** (`synesis-yarn`). Below: minimum surface area, current status, and how we treat gaps.

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

### 4.2 General LLM (planner) — Open WebUI / LiteLLM path

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

Admin, indexer, RAG microservices, MCP, LSP gateway: tests run **per component** (see each `base/*/pytest.ini` or `tests/` if present). Security workflow may run scanners over shared paths; **not** all services have full pytest in CI — check the relevant `Containerfile` / README.

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

## 8. Changelog

| Date | Change |
|------|--------|
| 2026-03-23 | Initial inventory: CI vs manual, planner/Yarn/probe, OpenAI reference pointers. |
| 2026-03-23 | §4: Planner vs Yarn OpenAI surface — implemented vs not implemented, test backlog. |
