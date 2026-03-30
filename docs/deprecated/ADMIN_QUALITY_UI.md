# Admin Quality & RAG Feedback — Current System

This document is the **source of truth** for how corpus quality, retrieval gaps, and model/critic signals surface in the **Synesis admin SPA**. Legacy references to Jinja templates, `/admin/quality`, or `base/admin/app/quality.py` are **removed** — that stack is not in the repo.

**Related:** offline tooling and CI in [QUALITY_PIPELINE.md](QUALITY_PIPELINE.md); runtime context budgeting in [performance.md](performance.md).

---

## Product goal: closed feedback loops

| Signal | What it tells you | Primary admin surface |
|--------|-------------------|------------------------|
| **Corpus / domain health** | Indexed volume & coarse strength per taxonomy domain | **RAG → Quality** (`/rag/quality`) |
| **Retrieval benchmarks** | Hybrid search regression vs fixed queries | **RAG → Benchmarks** |
| **Runtime “we don’t know”** | Router/planner marked incomplete knowledge | **Feedback → Knowledge Gaps** (Postgres) |
| **Post-retrieval validation** | Re-query RAG for open gaps | **Observability → Retrieval Gaps** (`/observability/retrieval-gaps`) |
| **Evidence starvation / pack** | High-confidence chunks dropped from writer context | **Tracing → trace detail → Writer context budgeting** |
| **Critic / quality of answer** | Approvals, scores, failure modes over traces | **Pipeline → Critic** |
| **Proposed new sources** | Curator agent YAML (file-backed) | **Feedback → Curator** |

**Hallucinated URLs / unsupported citations** are tracked in **trace** `critic_scores` (e.g. `hallucinated_urls_count`) and Critic analytics — there is not yet a dedicated “hallucination inbox” page; use **Traces** + **Pipeline → Critic** as the front door.

---

## Architecture (data flow)

```mermaid
flowchart TB
  subgraph offline [Offline / scheduled]
    AUD[audit_corpus.py]
    CUR[curator_agent.py]
    BENCH[bench_hybrid.py / bench scripts]
    GH[GitHub workflow quality-pipeline.yml]
    CRON[quality-runner CronJob]
    AUD --> JSON[corpus_audit_report.json]
    CUR --> YAML[proposed_sources.yaml]
    BENCH --> BR[benchmark JSON / DB]
    GH --> AUD
    CRON --> AUD
    CRON --> CUR
  end

  subgraph env [Config]
    QRP[SYNESIS_QUALITY_REPORT_PATH]
    CPP[SYNESIS_CURATOR_PROPOSALS_PATH]
    QRP --> JSON
    CPP --> YAML
  end

  subgraph admin [Admin API + Postgres]
    RAG[routers/rag.py]
    FB[routers/feedback.py]
    OBS[routers/observability.py]
    PG[(synesis_admin DB)]
    RAG --> PG
    RAG --> MIL[Milvus synesis_catalog]
    FB --> PG
    FB --> YAML
    OBS --> PG
    OBS --> MIL
  end

  subgraph ui [Admin React SPA]
    QD[QualityDashboard /rag/quality]
    DH[DomainHealth /rag/quality/:key]
    BM[Benchmarks]
    KG[Knowledge Gaps]
    RG[Retrieval Gaps]
    TR[Traces + context_curation]
    CA[Critic analytics]
    CP[Curator proposals]
    QD --> RAG
    DH --> RAG
    BM --> RAG
    KG --> FB
    CP --> FB
    RG --> OBS
    TR --> PG
    CA --> PG
  end

  JSON -.->|optional mount| RAG
```

---

## Runtime feedback loop (requests)

```mermaid
sequenceDiagram
  participant U as User
  participant P as Planner/Router
  participant R as RAG
  participant W as Writer
  participant C as Critic
  participant DB as Admin Postgres

  U->>P: query
  P->>R: retrieve
  R-->>P: evidence_packets
  Note over P: knowledge gaps → backlog
  P->>DB: knowledge_gaps rows (Python direct SQL)
  P->>DB: knowledge_gaps via HTTP ingest (planner-ts)
  W->>W: context_curation rank pack
  W->>C: draft
  C-->>DB: trace + critic_scores (HTTP ingest)
  Note over DB: Traces UI, Critic dashboard
```

> **Runtime note:** Python planner writes `knowledge_gaps` via **direct SQL** (`SYNESIS_TRACE_DATABASE_URL`). Planner-ts has **no Postgres client** — traces and knowledge gaps are delivered via **HTTP ingest** to admin (`POST /api/v1/traces/ingest`, `POST /api/v1/feedback/knowledge-gaps/ingest`). See the parity table below for what each runtime emits today.

---

## Planner runtime: Python vs planner-ts

Traces reach admin via **HTTP ingest** for both runtimes. Knowledge gaps, hallucination metrics, and writer context curation differ in implementation maturity.

| Signal | Admin surface | Python planner | planner-ts |
|--------|---------------|----------------|------------|
| **Traces + spans + critic** | Traces, Pipeline > Critic | Full: `synesis_tracer` writes complete `TraceRecord` with critic scores, sensemaking, evidence. | Full: `emitPlannerTrace` in [`app.ts`](../base/planner-ts/src/app.ts) writes `TraceRecord` with spans, classification, critic, budget metadata. |
| **Hallucinated URLs** | `GET /traces?min_hallucinated_urls=1` | `critic_scores.hallucinated_urls_count` populated by URL-vs-evidence comparison in [`critic.py`](../base/planner/app/nodes/critic.py). | Populated: `hallucinated_urls_count` computed in `emitPlannerTrace` from cited URLs vs evidence URIs. |
| **Knowledge gaps** backlog | Feedback > Knowledge Gaps | [`publish_knowledge_gap`](../base/planner/app/knowledge_backlog.py) via direct Postgres SQL when `knowledge_backlog_enabled`. | Via HTTP: `POST /api/v1/feedback/knowledge-gaps/ingest` from router when `max_confidence < threshold`. |
| **Writer context curation** | Traces > `context_curation` | [`context_curation.py`](../base/planner/app/context_curation.py) ranks/packs evidence; report embedded in trace via `synesis_tracer.set_context_curation`. | Lightweight: `context_curation` blob emitted with budget/pack stats on trace. Full rank/exclude parity is future work. |
| **Quality wiring test** | `POST /traces/test` | Works. | Works (same `/v1/chat/completions` contract). |

### Database alignment caveat

Python planner connects to Postgres directly (`SYNESIS_TRACE_DATABASE_URL`) for knowledge gap inserts. Planner-ts **does not** use a Postgres client; it sends all data (traces, gaps) over HTTP to admin endpoints. The DSN table in the **Database alignment** section below applies only to the Python planner path. When planner-ts is the active runtime, `SYNESIS_TRACE_DATABASE_URL` is unused.

---

## Implemented UI routes (sidebar)

| Area | Route | Backend |
|------|-------|---------|
| Quality summary | `/rag/quality` | `GET /api/v1/rag/quality` |
| Quality refresh | button | `POST /api/v1/rag/quality/refresh` |
| Domain detail | `/rag/quality/:key` | `GET /api/v1/rag/quality/domains/{key}` |
| Benchmarks | `/rag/benchmarks` | `GET /api/v1/rag/benchmarks`, `POST .../benchmarks/run`, history |
| Corpus | `/rag/corpus` | `GET /api/v1/rag/corpus` |
| Review queue | `/rag/review` | `GET/POST /api/v1/rag/review*` ([`rag.py`](../base/admin/app/routers/rag.py)) |
| Ingestion queue | `/rag/ingestion` | `GET/POST /api/v1/ingestion/*` ([`ingestion.py`](../base/admin/app/routers/ingestion.py)) |
| User feedback | `/feedback` | `GET /api/v1/feedback` (planner + mirrored Open WebUI), `POST .../sync-openwebui`, `PATCH .../workspace` ([`feedback.py`](../base/admin/app/routers/feedback.py)) |
| Knowledge gaps (feedback) | `/feedback/knowledge-gaps` | `GET /api/v1/feedback/knowledge-gaps` |
| Curator proposals | `/feedback/curator` | `GET /api/v1/feedback/curator`, approve/reject |
| Retrieval gaps + validate | `/observability/retrieval-gaps` | `GET/POST .../observability/knowledge-gaps*` |
| Traces | `/traces`, `/traces/:id` | trace store + `context_curation` on record |
| Critic | `/pipeline/critic` | Postgres aggregates from traces |

All JSON is behind the same auth as the SPA (`/api/v1/...`). Suitable for **scripts** using an admin API token.

---

## How quality numbers are produced

1. **`GET /rag/quality`** — Reads **`quality_snapshots`** (latest rows per domain) when present; otherwise falls back to **`corpus_audit_report.json`** at `SYNESIS_QUALITY_REPORT_PATH`.
2. **`POST /rag/quality/refresh`** — Recomputes **heuristic** health from **Milvus** domain hierarchy (chunk counts per domain → strong/adequate/weak/empty). Does **not** run `audit_corpus.py` (no template queries, MRR, or dead-weight from audit).
3. **`GET /rag/quality/domains/{key}`** — Prefers **audit JSON** scorecard for that domain; if missing, returns the latest **`QualitySnapshot`** row shaped for the UI (inventory; MRR/hit rate from audit only when JSON exists).

So: **rich metrics** (hit rate, MRR, dead-weight samples) require the **offline audit** (or CI/CronJob) writing JSON **or** future work to persist full scorecards in Postgres.

---

## Offline / automation (keep using these)

- **Makefile / `benchmarks/` / `tools/curator/`** — See [QUALITY_PIPELINE.md](QUALITY_PIPELINE.md).
- **`.github/workflows/quality-pipeline.yml`** — Scheduled + `workflow_dispatch` (needs self-hosted runner or equivalent).
- **`base/quality-runner/`** — In-cluster CronJob pattern.

**Recommendation:** Periodically run **corpus audit** and sync the report into the cluster (ConfigMap/volume) **or** extend admin to **POST import** JSON into DB — not implemented today.

---

## CLI / local “front door”

1. **Authenticated HTTP** — Same endpoints as the SPA; use org API tokens from **Account → API Tokens** (if enabled in your deployment).
2. **Port-forward** Milvus + admin DB + admin service as in [QUALITY_PIPELINE.md](QUALITY_PIPELINE.md) prerequisites.
3. **Tests** — `base/admin/tests/test_quality_smoke.py` exercises every admin quality/feedback endpoint. `base/planner/tests/test_quality_gaps.py` exercises planner-side gap behavior.

---

## Integration runbook (end-to-end verification)

Use these steps to verify the feedback loops work end-to-end in a running cluster:

### 1. Traces flow: planner → admin

```bash
# Send a test chat and confirm a trace appears
curl -X POST $ADMIN_URL/api/v1/traces/test \
  -H "Authorization: Bearer $TOKEN"
# Should return {"status":"pass","trace_id":"..."}
```

### 2. Knowledge gaps flow: planner → feedback UI

```bash
# Trigger a request about a topic not in your corpus
# Then check for new open gaps:
curl "$ADMIN_URL/api/v1/feedback/knowledge-gaps?status=open" \
  -H "Authorization: Bearer $TOKEN"
```

### 3. Quality wiring health

```bash
curl "$ADMIN_URL/api/v1/dashboard/quality-wiring" \
  -H "Authorization: Bearer $TOKEN"
# Verify: milvus_ok=true, traces_total > 0, quality_snapshots > 0
```

### 4. Audit import via quality-runner

```bash
# Manual: run audit locally, import results
python benchmarks/corpus/audit_corpus.py --output /tmp/audit.json
curl -X POST "$ADMIN_URL/api/v1/rag/quality/import-report" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @/tmp/audit.json
# Confirm: domain detail at /rag/quality/:key now shows MRR/hit-rate
```

### 5. Hallucination filter

```bash
curl "$ADMIN_URL/api/v1/traces?min_hallucinated_urls=1" \
  -H "Authorization: Bearer $TOKEN"
# Returns only traces where critic flagged hallucinated URLs
```

---

## Implemented wiring

| Feature | Status |
|---------|--------|
| **Single source domain detail** — full audit scorecards persisted in `quality_snapshots.raw_scorecard` (JSONB column) via `POST /api/v1/rag/quality/import-report`. | Done |
| **Quality-runner CronJob** — `base/quality-runner/cronjob.yaml` runs `audit_corpus.py` nightly, POSTs results to admin import endpoint. | Done |
| **Hallucination filter** — trace list supports `?min_hallucinated_urls=1` API filter + UI toggle button. | Done |
| **Benchmark import** — `POST /api/v1/rag/benchmarks/import` accepts full regression results, separate from the inline lightweight probe. | Done |
| **Quality wiring health** — `GET /api/v1/dashboard/quality-wiring` shows Milvus, DB table counts, file presence, and last-trace age. | Done |
| **Latest-per-domain SQL** — uses `row_number()` window function instead of SQLAlchemy `distinct()`. | Done |
| **Smoke tests** — `base/admin/tests/test_quality_smoke.py` hits every quality/feedback endpoint. | Done |
| **planner-ts hallucination count** — `hallucinated_urls_count` emitted in `critic_scores` on traces via cited-vs-evidence URL comparison. | Done |
| **planner-ts knowledge gap ingest** — router emits gaps via `POST /api/v1/feedback/knowledge-gaps/ingest` when evidence confidence is below threshold. | Done |
| **planner-ts context curation (lightweight)** — `context_curation` blob on traces with budget/evidence-pack stats for `TraceDetail`. | Done |
| **Knowledge gap HTTP ingest endpoint** — `POST /api/v1/feedback/knowledge-gaps/ingest` in admin accepts service-token-auth gaps from any runtime. | Done |

## Roadmap (remaining)

| Priority | Item |
|----------|------|
| **P1** | planner-ts: full **context curation** parity — ranking/exclusion logic from [`context_curation.py`](../base/planner/app/context_curation.py) (currently lightweight budget/pack stats only). |
| **P2** | Trend charts from **historical** `quality_snapshots` + benchmark rows (schema already exists in migrations). |
| **P2** | Curator proposals: move from file-only to **DB queue** shared with ingestion for one approval pipeline. |

---

## Database alignment

The **Python planner** writes **traces** and **knowledge gaps** to the same Postgres instance the admin reads. The DSNs differ only in driver prefix. **Planner-ts** does not connect to Postgres directly; it uses HTTP ingest endpoints (see the parity table above).

| Service | Env var | Default |
|---------|---------|---------|
| Planner | `SYNESIS_TRACE_DATABASE_URL` | `postgresql://app:...@synesis-admin-db-rw.synesis-admin.svc:5432/synesis_admin` |
| Admin | `SYNESIS_ADMIN_DATABASE_URL` | `postgresql+asyncpg://app:...@synesis-admin-db-rw.synesis-admin.svc:5432/synesis_admin` |

Both target `synesis_admin` on the same cluster service. If you change one, change the other — otherwise traces, knowledge gaps, and quality snapshots will diverge and the feedback loops break silently.

---

## Design principles (updated)

1. **Admin SPA is the default UI** — React + TanStack Query; no parallel server-rendered quality app.
2. **Postgres for operational feedback** — traces, gaps, benchmarks, snapshots; files are bootstrap/CI only.
3. **DRY APIs** — Prefer one JSON shape for scorecards in DB and file import.
4. **No silent mismatch** — List vs detail both resolved (snapshot fallback added for domain detail when audit JSON absent).
