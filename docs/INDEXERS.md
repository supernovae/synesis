# Synesis RAG Indexer

Synesis uses a **single queue-driven indexer** that claims work from a PostgreSQL-backed ingestion queue (the admin service's `ingestion_items` table). Content is added via the admin UI, the bootstrap API, or bulk YAML import. The indexer processes whatever is pending — no ConfigMaps or per-handler CronJobs required.

## Architecture

```
                     ┌─────────────────────────┐
                     │    Admin Service (DB)    │
                     │  ingestion_items table   │
                     │  ┌─────────────────────┐ │
                     │  │ pending → running →  │ │
 Admin UI / CLI ────▶│  │ indexed | failed     │ │◀──── bootstrap/corpus/*.yaml
                     │  └─────────────────────┘ │
                     └────────────┬────────────┘
                                  │ POST /claim
                                  │ PATCH /status
                                  ▼
                     ┌─────────────────────────┐
                     │   Indexer (CronJob)      │
                     │   --mode queue           │
                     │                          │
                     │  claim → fetch → chunk   │
                     │  → enrich → embed →      │
                     │  upsert → report         │
                     └────────────┬────────────┘
                                  │
                                  ▼
                     ┌─────────────────────────┐
                     │  Milvus (synesis_catalog)│
                     └─────────────────────────┘
```

One container image (`base/rag/indexer/`) with handler plugins for each document type. The queue runner (`queue_runner.py`) claims items one at a time via `SELECT ... FOR UPDATE SKIP LOCKED`, processes them through the existing pipeline, and reports status back to the admin API.

```
base/rag/indexer/
├── app/
│   ├── cli.py              # CLI entrypoint (--mode queue | --mode yaml)
│   ├── queue_runner.py     # Queue client: claim, process, report
│   ├── pipeline.py         # Orchestration: fetch → parse → chunk → enrich → embed → upsert
│   ├── schema.py           # Milvus collection schema (synesis_catalog)
│   ├── chunking.py         # Heading-aware split with overlap
│   ├── enrichment.py       # Keyword extraction, context_prefix, optional LLM summary
│   ├── embed_client.py     # Batch embedding via TEI
│   ├── milvus_writer.py    # Idempotent upsert with content-hash dedup
│   └── handlers/           # Handler plugins (auto-discovered)
│       ├── github_markdown.py
│       ├── github_code.py
│       ├── openapi_spec.py
│       ├── web_page.py
│       ├── pdf_document.py
│       ├── html_document.py
│       ├── seed_corpus.py
│       ├── arxiv_paper.py
│       ├── markdown_file.py
│       └── license_spdx.py
├── cronjob-queue.yaml      # Single CronJob manifest
├── Dockerfile
├── requirements.txt
└── kustomization.yaml
```

## Queue Mode vs Legacy YAML Mode

| Mode | Flag | Source of work | Use case |
|------|------|----------------|----------|
| **Queue** (primary) | `--mode queue` | Admin DB `ingestion_items` | Production — content managed via UI/API |
| **YAML** (legacy) | `--mode yaml --sources file.yaml` | Local YAML file | Local development, one-off imports |

Queue mode is the default for the deployed CronJob. YAML mode remains available for local development.

## Handler Types

### Code (tree-sitter AST — 25+ languages)

| Handler | Source Type | What It Does |
|---------|-----------|--------------|
| `github_code` | GitHub repos | Shallow-clones repos, AST-aware chunking via tree-sitter-language-pack. Also routes `.yaml`/`.json`/`.xml`/`.toml`/`.tf` files to structured_data handler. |

**Supported languages:** Python, Go, Rust, JavaScript, TypeScript, Java, C, C++, C#, Ruby, PHP, Bash/Shell, Lua, Kotlin, Scala, Swift, SQL, R, Elixir, Haskell, Perl, Dockerfile, Makefile, Protobuf, HCL/Terraform.

Each language has configured `top_level` and `nested` AST node types for semantic chunking (functions, classes, methods, structs, etc.).

### Structured Data (format-aware chunking)

| Handler | Source Type | What It Does |
|---------|-----------|--------------|
| `structured_data` | URLs / local | YAML, JSON, TOML, XML, HCL — splits at semantic boundaries |

Format-specific chunking:
- **YAML**: Splits on `---` document separators. Kubernetes manifests get `kind/name` as heading. Ansible playbooks split per task/play.
- **JSON**: Arrays split per element; objects split at top-level keys.
- **XML**: Element-tree split at child elements (Maven POMs, config files).
- **TOML**: Split per top-level table.
- **HCL/Terraform**: Split per `resource`/`data`/`module`/`variable`/`output` block.

### Documents

| Handler | Source Type | What It Does |
|---------|-----------|--------------|
| `github_markdown` | GitHub repos | Fetches .md files via GitHub API, heading-aware chunking with heading_path tracking |
| `html_document` | URLs | BeautifulSoup + Markdownify conversion, heading-aware chunking |
| `web_page` | URLs | Crawl4AI-based web crawling, HTML→Markdown conversion, heading-aware chunking |
| `pdf_document` | URLs | PyMuPDF text extraction plus structured table markdown, section-based splitting |
| `markdown_file` | Local paths | Reads local .md files, heading-aware chunking |
| `arxiv_paper` | arXiv IDs | Fetches PDFs from arXiv, extracts and chunks |

### Specialized

| Handler | Source Type | What It Does |
|---------|-----------|--------------|
| `openapi_spec` | URLs | Parses OpenAPI 3.x / Swagger 2.0 into endpoint-level chunks |
| `license_spdx` | SPDX sources | License data from three authoritative sources plus compatibility rules |
| `seed_corpus` | JSON files | Batch import from JSON URL lists (legacy format) |
| `generic_text` | URLs | Catch-all for unrecognized formats — paragraph-boundary chunking with overlap |

## Adding Content

### Via Admin UI (recommended)

Navigate to **RAG Pipeline > Ingestion Queue** in the admin dashboard:

- **Single item** — enter a URI, select handler and domain, submit
- **Bulk paste** — one URI per line
- **Upload YAML** — normalized bootstrap format (see below)

### Via Bootstrap API

```bash
curl -X POST http://synesis-admin:8000/api/v1/ingestion/bootstrap \
  -F "file=@bootstrap/corpus/docs.yaml" \
  -H "Authorization: Bearer $TOKEN"
```

Deduplication is automatic — existing URIs are skipped (`ON CONFLICT (uri) DO NOTHING`).

### Bootstrap YAML Format

All files in `bootstrap/corpus/` use a normalized schema that maps 1:1 to `ingestion_items` rows:

```yaml
items:
  - uri: "https://example.com/docs"
    handler: html_document
    title: "Example Documentation"
    domain: architecture
    authority: vetted
    origin_type: curated
    tags: [cloud, architecture]
    priority: 0
    config: {}
```

See [bootstrap/README.md](../bootstrap/README.md) for full schema details and the `convert.py` migration tool.

## Running the Indexer

### Deploy the CronJob

```bash
./scripts/deploy-indexer.sh            # Apply the CronJob manifest
./scripts/deploy-indexer.sh --run      # Also trigger a one-shot run now
```

### Monitor

```bash
oc logs -n synesis-rag -l synesis.io/indexer-group=queue -f
```

### Run Locally (development)

```bash
cd base/rag/indexer

# Queue mode (needs admin service running)
python -m app --mode queue --admin-url http://localhost:8000

# YAML mode (legacy, for local testing)
python -m app --mode yaml --sources sources-docs.yaml
python -m app --mode yaml --sources sources-code.yaml --enrich full
```

## Post-Migration Import

After deploying the admin service (Alembic migrations run automatically), import all bootstrap data:

```bash
# Import all bootstrap corpus files
for f in bootstrap/corpus/*.yaml; do
  curl -X POST http://synesis-admin:8000/api/v1/ingestion/bootstrap \
    -F "file=@$f" -H "Authorization: Bearer $TOKEN"
done

# Or use the admin UI: RAG Pipeline > Ingestion Queue > Upload YAML
```

Items enter the queue as `pending`. Run the indexer to process them:

```bash
./scripts/deploy-indexer.sh --run
```

## Schema (synesis_catalog)

Single Milvus collection with `authority` as partition key and HNSW index on embeddings.

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
| `scan_status` | VARCHAR(16) | Injection scan result: clean, flagged, vetted, rejected |
| `content_format` | VARCHAR(32) | Source format: python, yaml, json, hcl, xml, markdown, etc. |
| `symbol_type` | VARCHAR(64) | Semantic unit type: function, class, k8s_deployment, hcl_resource, etc. |
| `approval_status` | VARCHAR(16) | HITL status: auto_approved, pending, approved, rejected |
| `embedding` | FLOAT_VECTOR(384) | all-MiniLM-L6-v2 embedding |

## Enrichment Pipeline

Every chunk passes through a two-tier enrichment pipeline before embedding:

**Tier 1 (always, zero cost):**
- `context_prefix`: Template-based from document_name + heading_path
- `keywords`: KeyBERT extraction via keyword-service (up to 8 terms per chunk)

**Tier 2 (optional, uses synesis-general LLM):**
- `chunk_summary`: 1-2 sentence neutral description via LLM
- Enhanced `context_prefix`: LLM-generated contextual sentence

## Idempotency

The indexer uses **content-hash chunk IDs** and `existing_chunk_ids()` to skip re-embedding unchanged content. On re-run:

- **Same source data** → existing chunks skipped, only new/changed chunks embedded and upserted
- **Upsert by primary key** → same chunk_id overwrites in place (no duplicates)
- **Content hash tracking** → `ingestion_items.content_hash` detects when source content changes
- Use `--force` to re-embed everything (e.g., after embedding model change)

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `SYNESIS_ADMIN_URL` | `http://synesis-admin.synesis-admin.svc.cluster.local:8000` | Admin API for queue mode |
| `GITHUB_TOKEN` | (secret) | GitHub PAT for private repos and higher API rate limits |
| `SYNESIS_GENERAL_URL` | cluster-internal | LLM endpoint for Tier 2 enrichment (chunk_summary) |

---

Back to [README](../README.md) | See also: [RAG Pipeline](RAG.md), [Taxonomy Shaping](TAXONOMY_SHAPING.md), [Bootstrap Data](../bootstrap/README.md)
