# GitHub Actions: validation URLs and tokens

Single reference for repository **Variables** and **Secrets** used by optional live workflows. These names are standardized across workflows; local scripts may accept the same names or older aliases (see each tool’s header comment).

## Two secrets (do not conflate)

| Name | Type | Value | Used for |
|------|------|--------|----------|
| **`SYNESIS_INTERNAL_SERVICE_TOKEN`** | **Secret** | Token from `synesis-internal-service-auth` (same as planner `SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN`) | **Service-to-service** routes — e.g. `POST /v1/knowledge/search` (RAG retrieval eval). **Not** a PAT. |
| **`SYNESIS_TEST_PAT_TOKEN`** | **Secret** | Personal access token (`syn-…`) with scopes for planner/Yarn **user-space** `/v1` (chat, models) | Prompt regression (live), OpenAI compat probe, Yarn live verify |
| **`SYNESIS_NORNIC_USER`** | **Secret** | NornicDB username (typically `neo4j`) | Weekly/manual corpus-quality audit |
| **`SYNESIS_NORNIC_PASSWORD`** | **Secret** | NornicDB password | Weekly/manual corpus-quality audit |

Use a GitHub **Environment** named `validation` with branch protection / optional reviewers when these workflows should not run without approval.

## Repository variables

| Name | Typical value | Used by |
|------|----------------|---------|
| `SYNESIS_PLANNER_EVAL_URL` | `https://api.kybern.dev` | RAG retrieval eval (URL only; token is internal), prompt regression (live), OpenAI probe (planner) |
| `SYNESIS_YARN_EVAL_URL` | `https://coder.kybern.dev` | OpenAI compat probe (Yarn), Yarn live verify |
| `SYNESIS_VALIDATION_ENABLED` | `true` / `false` | Workflows that gate on “validation enabled” (see individual workflow headers) |
| `SYNESIS_NORNIC_URI` | `bolt://synesis-nornicdb.synesis-rag.svc.cluster.local:7687` | Corpus-quality audit |
| `SYNESIS_NORNIC_DATABASE` | `nornic` | Corpus-quality audit |
| `SYNESIS_NORNIC_VECTOR_INDEX` | `embeddings` | Corpus-quality audit |

## Legacy names (do not use for new setup)

Older docs referred to `SYNESIS_VALIDATION_API_URL` and `SYNESIS_VALIDATION_API_KEY`. Replace with **`SYNESIS_PLANNER_EVAL_URL`** plus the appropriate secret above.

## Local equivalents

| CI (GitHub) | Local / ad-hoc |
|-------------|----------------|
| `SYNESIS_INTERNAL_SERVICE_TOKEN` | Same name, or `SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN` for RAG scripts |
| `SYNESIS_TEST_PAT_TOKEN` | Same name, or `SYNESIS_TEST_AUTH` / `SYNESIS_API_KEY` in `run_test_suite.py`, or `SYNESIS_PROBE_TOKEN` for the probe script |
| `SYNESIS_PLANNER_EVAL_URL` | Same name, or `SYNESIS_PROBE_PLANNER_URL` for the probe script |
| `SYNESIS_YARN_EVAL_URL` | Same name, or `SYNESIS_YARN_URL`, or `SYNESIS_PROBE_YARN_URL` for the probe script |

Yarn live scripts in `base/yarn-ts/scripts/` resolve PAT as **`SYNESIS_TEST_PAT_TOKEN`** → `SYNESIS_TEST_AUTH` → `SYNESIS_TEST_TOKEN` (not the internal service token).

## Related workflows

| Workflow file | URL variable(s) | Secret |
|---------------|-----------------|--------|
| `rag-retrieval-eval.yml` | `SYNESIS_PLANNER_EVAL_URL` | **`SYNESIS_INTERNAL_SERVICE_TOKEN`** only |
| `prompt-regression.yml` (live job) | `SYNESIS_PLANNER_EVAL_URL` | **`SYNESIS_TEST_PAT_TOKEN`** |
| `openai-compat-probe.yml` | `SYNESIS_PLANNER_EVAL_URL` and/or `SYNESIS_YARN_EVAL_URL` | **`SYNESIS_TEST_PAT_TOKEN`** |
| `yarn-live-verify.yml` | `SYNESIS_YARN_EVAL_URL` | **`SYNESIS_TEST_PAT_TOKEN`** |
| `quality-pipeline.yml` | `SYNESIS_NORNIC_URI` | **`SYNESIS_NORNIC_USER`**, **`SYNESIS_NORNIC_PASSWORD`** |
