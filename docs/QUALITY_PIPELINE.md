# Synesis Quality Pipeline

End-to-end corpus quality management: audit, benchmark, curate, and verify.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Quality Feedback Loop                            │
│                                                                         │
│  ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐  │
│  │  Corpus     │───▶│  Gap       │───▶│  Curator   │───▶│  Indexer   │  │
│  │  Audit      │    │  Analysis  │    │  Agent     │    │  Ingest    │  │
│  └────────────┘    └────────────┘    └────────────┘    └────────────┘  │
│        │                                                       │        │
│        │                                                       │        │
│        ▼                                                       ▼        │
│  ┌────────────┐                                        ┌────────────┐  │
│  │  LLM Judge │                                        │  Re-Audit  │  │
│  │  Labels    │                                        │  (verify)  │  │
│  └────────────┘                                        └────────────┘  │
│                                                                         │
│  ┌────────────┐    ┌────────────┐                                      │
│  │  Chunking  │    │  Retrieval │   One-time diagnostics               │
│  │  Benchmark │    │  Benchmark │   (run when tuning parameters)       │
│  └────────────┘    └────────────┘                                      │
└──────────────────────────────────────────────────────────────────────────┘
```

## Components

| Tool | Location | Purpose | Output |
|------|----------|---------|--------|
| **Corpus Audit** | `benchmarks/corpus/audit_corpus.py` | Per-domain coverage scoring, dead-weight detection, gap analysis | `corpus_audit_report.json` |
| **LLM Judge** | `benchmarks/corpus/llm_judge.py` | LLM-rated relevance labels (0-3 scale) for retrieval benchmarks | `relevance_labels_llm.json` |
| **Chunking Benchmark** | `benchmarks/corpus/bench_chunking.py` | Chunk size/overlap parameter sweep to find optimal settings | `results_chunking.json` |
| **Retrieval Benchmark** | `benchmarks/retrieval/bench_hybrid.py` | Hybrid retrieval regression test (dense + BM25 via Milvus) | `results_hybrid.json` |
| **Enrichment Benchmark** | `benchmarks/retrieval/bench_enrichment.py` | A/B test for context_prefix impact on dense retrieval | `results_enrichment.json` |
| **Curator Agent** | `tools/curator/curator_agent.py` | Auto-discover sources for weak domains via SearXNG + LLM | `proposed_sources.yaml` |
| **Admin Quality UI** | `base/admin/app/quality.py` | Web dashboard for reviewing audit results, approving sources | Live at `/admin/quality` |
| **Quality CronJob** | `base/quality-runner/` | K8s CronJob that runs audit + curator on schedule | ConfigMap with results |

## Feedback Loop

The pipeline forms a closed loop:

1. **Audit** — Run `audit_corpus.py` to score every taxonomy domain against `synesis_catalog`. Produces domain-level scorecards with hit rate, MRR, source diversity, and dead-weight detection.

2. **Identify gaps** — Weak and empty domains are highlighted in the audit report. The admin UI shows a sortable, color-coded dashboard.

3. **Curate** — Run `curator_agent.py` to automatically discover high-quality sources for weak domains. Uses SearXNG for web search and an LLM to evaluate source quality (1-5 scale). Outputs `proposed_sources.yaml` for human review.

4. **Review** — In the admin UI (`/admin/quality/curator`), review proposed sources. Approve or reject each entry. Approved sources are copied into the appropriate `sources-*.yaml` file.

5. **Ingest** — The indexer picks up new sources and processes them through the standard pipeline (chunking, enrichment, embedding, Milvus upsert).

6. **Verify** — Re-run the audit to confirm that weak domains have improved. Compare before/after metrics in the admin dashboard.

## Prerequisites

All quality tools need access to in-cluster services via port-forward:

```bash
# Always needed
oc port-forward svc/synesis-milvus 19530:19530 -n synesis-rag
oc port-forward svc/embedder 8082:8080 -n synesis-rag

# For LLM-powered features (audit with LLM queries, LLM judge, curator)
oc port-forward svc/litellm-proxy 4000:4000 -n synesis-gateway

# For curator agent
oc port-forward svc/searxng 8888:8080 -n synesis-search
```

## Running Locally

All tools have corresponding Makefile targets. Run from the project root:

### Corpus Audit

```bash
# Template-based queries (fast, no LLM needed)
make bench-corpus-audit

# With LLM-generated queries (richer coverage, costs tokens)
make bench-corpus-audit-llm

# Audit specific domains only
python benchmarks/corpus/audit_corpus.py --domains openshift,kubernetes,ansible

# View summary
make curator-report
```

**Output**: `benchmarks/corpus/corpus_audit_report.json`

Each domain gets a scorecard:
- **strong** — hit_rate >= 70%, source_diversity >= 3
- **adequate** — hit_rate >= 40%
- **weak** — content exists but retrieval quality is poor
- **empty** — no indexed content for this domain

### LLM Judge

```bash
make bench-llm-judge
```

**Output**: `benchmarks/corpus/relevance_labels_llm.json` + `judgments_cache.json`

For each query in `benchmarks/bm25/queries.yaml`, pools top-30 candidates via hybrid search and asks the LLM to rate each chunk's relevance (0-3). Results are cached — subsequent runs only judge new query-chunk pairs.

### Retrieval Benchmark

```bash
# With overlap-based heuristic labels
make bench-retrieval

# With LLM-judged labels (run bench-llm-judge first)
make bench-retrieval-llm
```

**Output**: `benchmarks/retrieval/results_hybrid.json`

Regression test that fails if quality drops >5% from baseline. Measures Recall@K, MRR@K, NDCG@K at multiple K values.

### Chunking Benchmark

```bash
make bench-chunking
```

**Output**: `benchmarks/corpus/results_chunking.json`

Sweeps chunk size (300-1000 words) and overlap (40-120 words) combinations. One-time diagnostic — run when tuning `DEFAULT_MAX_WORDS` / `DEFAULT_OVERLAP_WORDS` in the indexer.

### Curator Agent

```bash
# Discover sources for weak domains
make curator-discover

# With custom parameters
python tools/curator/curator_agent.py \
  --max-domains 5 \
  --min-quality 4 \
  --model synesis-general
```

**Output**: `tools/curator/proposed_sources.yaml`

For each weak/empty domain:
1. Builds search queries from taxonomy metadata (hints, required_elements)
2. Searches SearXNG for candidate URLs
3. Asks LLM to suggest additional authoritative sources
4. Evaluates each candidate's quality (1-5 scale)
5. Outputs approved sources (>= min-quality threshold)

After review, copy approved entries to the appropriate `sources-*.yaml` and re-run the indexer.

## CI/CD Automation

### GitHub Actions

The quality pipeline can run as a scheduled or manual GitHub Actions workflow:

```bash
# Trigger manually
gh workflow run quality-pipeline.yml -f audit=true -f curator=true

# View latest run
gh run list --workflow=quality-pipeline.yml --limit 3
```

See `.github/workflows/quality-pipeline.yml` for the full workflow definition.

**Requirements**: Self-hosted runner with `oc` CLI access to the cluster, OR configure the workflow to create Kubernetes Jobs.

### Kubernetes CronJob

For fully in-cluster automation without GitHub Actions:

```bash
# Apply the CronJob
oc apply -k base/quality-runner/

# Trigger a manual run
oc create job --from=cronjob/quality-audit quality-audit-manual -n synesis-rag

# Check results
oc logs job/quality-audit-manual -n synesis-rag
```

The CronJob runs weekly (Sunday 02:00 UTC by default) and stores results in a ConfigMap (`quality-report`) that the admin service reads.

## Admin UI

The admin service provides a web interface for reviewing quality data:

| Page | Path | Description |
|------|------|-------------|
| Quality Dashboard | `/admin/quality` | Overview: domain health summary, sortable table, trend indicators |
| Domain Detail | `/admin/quality/domain/{key}` | Deep dive: inventory, coverage metrics, dead-weight list |
| Curator Review | `/admin/quality/curator` | Review proposed sources, approve/reject |

### JSON APIs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/api/quality/summary` | Domain health summary and counts |
| GET | `/admin/api/quality/domains` | All domain scorecards |
| GET | `/admin/api/quality/domain/{key}` | Single domain scorecard |
| GET | `/admin/api/quality/curator` | Curator proposals |
| POST | `/admin/api/quality/audit` | Trigger a lightweight audit |

## File Layout

```
synesis/
├── benchmarks/
│   ├── bm25/
│   │   └── queries.yaml            # Benchmark query set (45 queries)
│   ├── corpus/
│   │   ├── audit_corpus.py         # Corpus audit tool
│   │   ├── bench_chunking.py       # Chunking parameter sweep
│   │   ├── llm_judge.py            # LLM relevance labeling
│   │   ├── requirements.txt        # Dependencies
│   │   ├── corpus_audit_report.json      # (generated) Audit results
│   │   ├── relevance_labels_llm.json     # (generated) LLM labels
│   │   ├── judgments_cache.json          # (generated) LLM judgment cache
│   │   └── results_chunking.json         # (generated) Chunking results
│   └── retrieval/
│       ├── bench_hybrid.py         # Retrieval regression test
│       ├── bench_enrichment.py     # Enrichment A/B test
│       └── requirements.txt
├── tools/
│   └── curator/
│       ├── curator_agent.py        # Auto-curation agent
│       ├── requirements.txt
│       └── proposed_sources.yaml   # (generated) Proposed sources
├── base/
│   ├── admin/
│   │   └── app/
│   │       ├── quality.py          # Quality dashboard routes + helpers
│   │       └── templates/
│   │           ├── quality.html            # Dashboard overview
│   │           ├── quality_domain.html     # Domain detail
│   │           └── quality_curator.html    # Curator review
│   └── quality-runner/
│       ├── Dockerfile              # Image for in-cluster quality runs
│       ├── cronjob.yaml            # Weekly CronJob
│       ├── configmap.yaml          # Config (endpoints, schedule)
│       └── kustomization.yaml
├── .github/workflows/
│   └── quality-pipeline.yml       # GitHub Actions quality pipeline
└── docs/
    ├── QUALITY_PIPELINE.md        # This document
    └── ADMIN_QUALITY_UI.md        # Admin UI design and future plans
```

## Configuration

### Environment Variables

| Variable | Default | Used By | Description |
|----------|---------|---------|-------------|
| `SYNESIS_MILVUS_HOST` | `synesis-milvus.synesis-rag.svc.cluster.local` | Admin, Quality Runner | Milvus hostname |
| `SYNESIS_MILVUS_PORT` | `19530` | Admin, Quality Runner | Milvus port |
| `SYNESIS_EMBEDDER_URL` | `http://embedder.synesis-rag.svc.cluster.local:8080/v1` | Quality Runner | TEI embedder URL |
| `SYNESIS_LLM_URL` | `http://litellm-proxy.synesis-gateway.svc.cluster.local:4000/v1` | Quality Runner, Curator | LLM gateway URL |
| `SYNESIS_SEARXNG_URL` | `http://searxng.synesis-search.svc.cluster.local:8080` | Curator | SearXNG URL |
| `SYNESIS_QUALITY_REPORT_PATH` | `/data/quality/corpus_audit_report.json` | Admin, Quality Runner | Shared audit report path |
| `SYNESIS_CURATOR_PROPOSALS_PATH` | `/data/quality/proposed_sources.yaml` | Admin, Quality Runner | Shared curator proposals path |

### Taxonomy

Quality tools use `base/planner/taxonomy_prompt_config.yaml` as the authoritative source for domain definitions. Each domain entry provides:

- `path` — Human-readable taxonomy path (e.g., "DevOps > Kubernetes > Helm")
- `query_expansion_hints` — Keywords used to generate audit queries
- `required_elements` — Concepts that should be covered
- `preferred_web_scopes` — URL patterns for curator source discovery

## Metrics Reference

### Corpus Audit Metrics

| Metric | Formula | Interpretation |
|--------|---------|---------------|
| **Hit Rate** | queries_with_domain_results / total_queries | Fraction of queries that return at least one domain-relevant result |
| **Mean MRR** | avg(1/rank_of_first_relevant) | How high domain content ranks across queries |
| **Source Diversity** | count(distinct document_names retrieved) | Number of unique sources contributing to results |
| **Dead Weight** | chunks_never_retrieved / total_chunks | Content that exists but never surfaces |

### Health Classification

| Level | Criteria | Action |
|-------|----------|--------|
| **Strong** | hit_rate >= 70%, diversity >= 3 | Monitor only |
| **Adequate** | hit_rate >= 40% | Consider adding 1-2 more sources |
| **Weak** | hit_rate < 40%, content exists | Priority curation target |
| **Empty** | No indexed content | Highest priority — needs new sources |

### LLM Judge Scale

| Score | Label | Definition |
|-------|-------|------------|
| 0 | Irrelevant | Unrelated topic |
| 1 | Marginal | Related but does not answer |
| 2 | Relevant | Partially answers or provides useful context |
| 3 | Highly Relevant | Directly and substantively answers |

## Troubleshooting

### Audit returns all "empty" domains
- Verify Milvus is running and the `synesis_catalog` collection exists
- Check port-forward is active: `curl http://localhost:19530/v1/vector/collections`
- Verify the indexer has populated the collection

### LLM judge returns all zeros
- Confirm LiteLLM proxy is reachable: `curl http://localhost:4000/health`
- Check the model is deployed: LLM judge defaults to `synesis-general`
- For OpenRouter, ensure `OPENROUTER_API_KEY` is set in the LiteLLM config

### Curator finds no sources
- Verify SearXNG is running: `curl http://localhost:8888/search?q=test&format=json`
- Check the audit report exists and contains weak/empty domains
- Lower `--min-quality` threshold if filtering is too aggressive

### Admin quality pages show "No data"
- Ensure the quality-runner CronJob has run at least once, or trigger manually
- Check the shared PVC/ConfigMap is mounted correctly
- Verify `SYNESIS_QUALITY_REPORT_PATH` points to the correct file
