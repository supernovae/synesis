# Unified RAG Indexer

Synesis uses a **single config-driven indexer container** with handler plugins that consolidates all RAG knowledge indexing. The indexer runs as Kubernetes CronJobs (automated refresh) or one-shot Jobs (manual trigger) and populates the `synesis_catalog` Milvus collection with enriched chunks.

## Architecture

One container image (`base/rag/indexer/`) replaces the previous 7 per-indexer containers. Each document type is handled by a **handler plugin** that implements fetch, parse, and chunk operations. Source configurations are YAML files mounted as ConfigMaps.

```
base/rag/indexer/
├── app/
│   ├── cli.py              # Unified CLI entrypoint
│   ├── pipeline.py          # Orchestration: fetch → parse → chunk → enrich → embed → upsert
│   ├── schema.py            # Milvus collection schema (synesis_catalog)
│   ├── chunking.py          # Heading-aware split with overlap
│   ├── enrichment.py        # KeyBERT keywords, context_prefix, optional LLM summary
│   ├── embed_client.py      # Batch embedding via TEI
│   ├── milvus_writer.py     # Idempotent upsert with content-hash dedup
│   └── handlers/            # Handler plugins (auto-discovered)
│       ├── github_markdown.py
│       ├── github_code.py
│       ├── openapi_spec.py
│       ├── web_page.py
│       ├── pdf_document.py
│       ├── html_document.py
│       ├── markdown_file.py
│       └── license_spdx.py
├── sources-docs.yaml        # Documentation sources (runbooks, architecture, web pages)
├── sources-code.yaml        # Code repository sources
├── sources-apispec.yaml     # API specification sources
├── sources-license.yaml     # License compliance sources
├── Dockerfile
├── requirements.txt
├── kustomization.yaml
├── cronjob-docs.yaml
├── cronjob-code.yaml
├── cronjob-apispec.yaml
└── cronjob-license.yaml
```

## Handler Types

| Handler | Source Type | What It Does |
|---------|-----------|--------------|
| `github_markdown` | GitHub repos | Fetches .md files via GitHub API, heading-aware chunking with heading_path tracking |
| `github_code` | GitHub repos | AST-aware chunking via tree-sitter (functions, classes as semantic units) |
| `openapi_spec` | URLs | Parses OpenAPI 3.x / Swagger 2.0 into endpoint-level chunks |
| `web_page` | URLs | Crawl4AI-based web crawling, HTML→Markdown conversion, heading-aware chunking |
| `pdf_document` | URLs | PyMuPDF text extraction, section-based splitting |
| `html_document` | URLs | BeautifulSoup + Markdownify conversion, heading-aware chunking |
| `markdown_file` | Local paths | Reads local .md files, heading-aware chunking |
| `license_spdx` | SPDX/Fedora/choosealicense | License data from three authoritative sources plus compatibility rules |

## Schema (synesis_catalog)

Single collection with `authority` as partition key and HNSW index on embeddings.

| Field | Type | Purpose |
|-------|------|---------|
| `chunk_id` | VARCHAR(64) | Primary key (SHA256 content hash) |
| `doc_id` | VARCHAR(128) | Document identifier for grouped operations |
| `chunk_index` | INT64 | Position within document |
| `text` | VARCHAR(8192) | Chunk content |
| `context_prefix` | VARCHAR(512) | Contextual sentence prepended before embedding (Contextual Retrieval) |
| `chunk_summary` | VARCHAR(1024) | 1-2 sentence neutral description (optional, LLM-generated) |
| `heading_path` | VARCHAR(512) | Document structure breadcrumb ("Arch > Retrieval > BM25") |
| `section` | VARCHAR(256) | Immediate section heading |
| `document_name` | VARCHAR(256) | Source document name (for citation) |
| `source_type` | VARCHAR(32) | Source category (github, web, local, spdx) |
| `handler` | VARCHAR(32) | Handler that produced this chunk |
| `domain` | VARCHAR(64) | Taxonomy domain ID |
| `tags` | VARCHAR(512) | Comma-separated tags |
| `keywords` | VARCHAR(512) | KeyBERT-extracted keywords |
| `origin_type` | VARCHAR(32) | Provenance: internal, external, curated |
| `authority` | VARCHAR(32) | Trust tier: canonical, vetted, community, external (partition key) |
| `source_url` | VARCHAR(512) | Citation URL |
| `embedding` | FLOAT_VECTOR(384) | all-MiniLM-L6-v2 embedding |

## Enrichment Pipeline

Every chunk passes through a two-tier enrichment pipeline before embedding:

**Tier 1 (always, zero cost):**
- `context_prefix`: Template-based from document_name + heading_path (e.g., "From 'vLLM Deployment Guide', section 'GPU Parallelism > Tensor Parallel'.")
- `keywords`: KeyBERT extraction (up to 8 terms per chunk)

**Tier 2 (optional, uses synesis-general LLM):**
- `chunk_summary`: 1-2 sentence neutral description via LLM
- Enhanced `context_prefix`: LLM-generated contextual sentence

Tier 1 alone captures most of the Contextual Retrieval benefit because heading_path and document_name are the primary context signals.

## Running the Indexer

```bash
# Deploy all CronJobs
./scripts/deploy-indexer.sh dev

# Trigger a one-shot indexing job
./scripts/deploy-indexer.sh dev --trigger docs
./scripts/deploy-indexer.sh dev --trigger code
./scripts/deploy-indexer.sh dev --trigger apispec
./scripts/deploy-indexer.sh dev --trigger license

# Run locally (for development)
cd base/rag/indexer
python -m app --sources sources-docs.yaml
python -m app --sources sources-code.yaml --enrich full  # with LLM enrichment
```

## Adding Sources

Edit the appropriate `sources-*.yaml` file in `base/rag/indexer/`:

```yaml
sources:
  - name: my-internal-docs
    handler: github_markdown
    repo: my-org/my-repo
    branch: main
    paths: ["docs/"]
    domain: engineering
    authority: canonical
    origin_type: internal
    tags: [internal, docs]
```

## CronJob Schedules

| Environment | Docs | Code | API Spec | License |
|------------|------|------|----------|---------|
| **Dev** | Suspended | Suspended | Suspended | Suspended |
| **Staging** | 1st & 15th | 1st & 15th | 1st & 15th | 1st & 15th |
| **Prod** | Weekly (Sun 3am) | Weekly (Sun 3am) | Weekly (Sun 4am) | Weekly (Sun 5am) |

## Idempotency

The indexer uses **content-hash chunk IDs** (`chunk_id_hash`) and `existing_chunk_ids()` to skip re-embedding unchanged content. On re-run:

- **Same source data** → existing chunks skipped, only new/changed chunks embedded and upserted
- **Upsert by primary key** → same chunk_id overwrites in place (no duplicates)
- Use `--force` to re-embed everything (e.g., after embedding model change)

## Resource Requirements

| Job | CPU Request | Memory | Typical Runtime |
|-----|-----------|--------|-----------------|
| Docs (all sources) | 500m | 2Gi | 10-30 minutes |
| Code (all repos) | 1 core | 4Gi | 2-6 hours |
| API Spec | 500m | 1Gi | 5-15 minutes |
| License | 250m | 512Mi | 5-10 minutes |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `GITHUB_TOKEN` | (secret) | GitHub PAT for private repos and higher API rate limits |
| `SYNESIS_GENERAL_URL` | cluster-internal | LLM endpoint for Tier 2 enrichment (chunk_summary) |
| `RAG_CRITIC_ARCH_ENABLED` | `true` | Give the Critic architecture context |
| `RAG_CRITIC_LICENSE_ENABLED` | `true` | Give the Critic license compliance context |

---

Back to [README](../README.md) | See also: [RAG Pipeline](RAG.md), [Taxonomy Shaping](TAXONOMY_SHAPING.md)
