# Bootstrap Data

Seed data for initializing the Synesis database.  These files are **never
mounted into running pods** — they exist for first-deploy seeding, re-seeding
after a DB wipe, and local development.

## Structure

```
bootstrap/
├── corpus/              Normalized ingestion items (one YAML per topic)
├── taxonomy/            Taxonomy seed config
└── README.md
```

### Corpus files (`corpus/`)

| File | Contents |
|------|-----------|
| `apispec.yaml`, `code.yaml`, `docs.yaml`, `license.yaml` | API specs, code repos, product docs, licenses |
| `cloud.yaml` | Well-Architected, Kubernetes, DevOps, cloud CLIs |
| `arxiv.yaml` | arXiv papers (RAG, agents, systems) |
| `llm.yaml` | Vendor LLM research (blogs, PDFs) + `llm_*` vertical doc links |
| `foundations.yaml` | Cross-domain reference (architecture, security, data, …) |
| `lifestyle.yaml` | Consumer / lifestyle verticals |
| `developer.yaml` | Language runtimes, web standards, package ecosystems |

Corpus YAML is maintained directly in git. Add or edit entries in `corpus/*.yaml` and re-import via the admin bootstrap API (dedupe by `uri`).

## Normalized Item Schema

Every file in `corpus/` uses the same schema that maps 1:1 to the
`ingestion_items` DB table:

```yaml
items:
  - uri: "https://..."          # UNIQUE — any addressable reference
    handler: html_document      # which handler processes this
    title: "Human-Readable"     # display name
    domain: architecture        # taxonomy domain
    authority: vetted           # vetted | community | external | canonical
    origin_type: curated        # curated | external | scraped | uploaded
    tags: [cloud, architecture] # optional labels
    priority: 0                 # higher = process first
    config: {}                  # optional handler-specific params
```

## Importing

Upload any `corpus/*.yaml` file via the admin UI (RAG Pipeline > Ingestion
Queue > Upload YAML) or call the API directly:

```bash
curl -X POST http://localhost:8080/api/v1/ingestion/bootstrap \
  -F file=@bootstrap/corpus/docs.yaml \
  -H "Authorization: Bearer $TOKEN"
```

Deduplication is automatic — existing URIs are skipped (`ON CONFLICT (uri) DO NOTHING`).

## Post-Migration Import (First Deploy)

After deploying the admin service (Alembic migrations run automatically on startup):

```bash
# 1. Import all bootstrap corpus files into the ingestion queue
for f in bootstrap/corpus/*.yaml; do
  curl -X POST http://synesis-admin.synesis-admin.svc:8080/api/v1/ingestion/bootstrap \
    -F "file=@$f" -H "Authorization: Bearer $TOKEN"
done

# 2. Deploy and trigger the indexer to process pending items
./scripts/deploy-indexer.sh --run

# 3. Monitor progress
oc logs -n synesis-rag -l synesis.io/indexer-group=queue -f
```

Items enter the queue as `pending`. The indexer claims and processes them, reporting
status back to the admin API. Track progress in the admin UI under
**RAG Pipeline > Ingestion Queue**.

