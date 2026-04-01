# Go-First RAG Load Runbook

This runbook implements the Go-first phased ingestion loop:

1. Preflight checks
2. Go-only enqueue + queue processing
3. Retrieval hit validation in Yarn
4. Staged S3 decision gate
5. Controlled expansion to next packs

It is designed for fix-forward operations (no rollback choreography required).

## Prerequisites

- OpenShift access with `oc` logged into the target cluster.
- Admin PAT with:
  - `platform_admin` for default global bootstrap packs (including `lang-go.yaml`)
  - tenant content grants (content operator permissions)
- Optional Yarn test token for retrieval checks:
  - `SYNESIS_TEST_AUTH`

Export variables:

```bash
export SYNESIS_ADMIN_URL="https://synesis-admin.apps.openshiftdemo.dev"
export SYNESIS_ADMIN_TOKEN="syn-..."
export SYNESIS_YARN_URL="https://synesis-yarn.apps.openshiftdemo.dev"
export SYNESIS_TEST_AUTH="Bearer-or-PAT-token"
```

## One-command execution

```bash
./scripts/go-first-rag-load.sh
```

If your token is only `org_admin`, global bootstrap can fail with 403. Either:
- use a `platform_admin` PAT for global loads, or
- change ingestion entries to org/tenant visibility for org-scoped ingestion.

What it does:

- Validates cluster identity, namespaces, and Go corpus YAML.
- Verifies Admin token can call `/api/v1/ingestion/stats`.
- Enqueues only `bootstrap/corpus/lang-go.yaml`.
- Creates one manual queue job from `cronjob/synesis-indexer-queue`.
- Waits for completion and prints job logs + post-run ingestion stats.
- Runs an optional Yarn retrieval probe if Yarn is ready and `SYNESIS_TEST_AUTH` is set.

## Manual phase commands (if needed)

### Phase 1 — Preflight

```bash
oc whoami
oc get ns synesis-rag synesis-admin synesis-yarn
python3 scripts/validate-bootstrap-corpus.py bootstrap/corpus/lang-go.yaml
```

### Phase 2 — Enqueue Go-only + run queue

```bash
curl -sS -X POST \
  "${SYNESIS_ADMIN_URL}/api/v1/ingestion/bootstrap?status_override=pending&upsert=false" \
  -H "Authorization: Bearer ${SYNESIS_ADMIN_TOKEN}" \
  -F "file=@bootstrap/corpus/lang-go.yaml"

oc -n synesis-rag create job --from=cronjob/synesis-indexer-queue go-first-queue-$(date +%s)
```

### Phase 3 — Validate retrieval hits

Use coder prompts that should strongly hit Go sources:

- "Explain why Go map iteration order is randomized and where that is specified."
- "What does the Go memory model say about synchronization with channels?"
- "Difference between `defer` cost model before and after modern Go compiler optimizations."

Expectations:

- At least one authoritative Go source appears in evidence/citations.
- Answers are grounded (not generic language-model fallback).
- No sustained increase in latency or error rate.

## Phase 4 — Staged S3 decision gate

Adopt staged S3 only when one or more are true:

- frequent upstream fetch failures or rate-limit churn
- regular need to replay normalize/enrich without re-fetch
- expansion beyond Go causes fetch duration/cost to dominate

If gate is **not** met, stay on direct queue mode.

If gate is met:

1. Provision bucket and credentials.
2. Set `SYNESIS_INGESTION_S3_BUCKET`.
3. Deploy staged cronjobs:
   - `cronjob-staged-fetch`
   - `cronjob-staged-normalize`
   - `cronjob-staged-enrich`
4. Do not mix direct queue + staged for the same workload window.

## Phase 5 — Expansion cadence

Use this loop for each new language/domain pack:

1. Pick one pack only (small blast radius).
2. Enqueue and process.
3. Validate retrieval hit quality with 3-5 focused coder prompts.
4. Review failures by handler/domain and fix-forward.
5. Move to next pack only after stable queue drain and retrieval quality.

Recommended order after Go:

1. `lang-typescript.yaml`
2. `lang-python.yaml`
3. `lang-rust.yaml`

## Exit criteria per batch

- Queue drains without sustained `failed/dead_letter` growth.
- Retrieval checks show domain-grounded evidence.
- P95 latency remains within your accepted coder budget.
- Operators can rerun the same batch with predictable outcomes.
