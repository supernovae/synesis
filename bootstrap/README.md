# Bootstrap Data

Seed data for initializing the Synesis database.  These files are **never
mounted into running pods** — they exist for first-deploy seeding, re-seeding
after a DB wipe, and local development.

## Structure

```
bootstrap/
├── corpus/          Normalized ingestion items (one YAML per topic)
├── taxonomy/        Taxonomy seed config
├── convert.py       One-time migration from legacy sources-*.yaml
└── README.md
```

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
curl -X POST http://localhost:8000/api/v1/ingestion/bootstrap \
  -F file=@bootstrap/corpus/docs.yaml \
  -H "Authorization: Bearer $TOKEN"
```

Deduplication is automatic — existing URIs are skipped (`ON CONFLICT (uri) DO NOTHING`).

## Post-Migration Import (First Deploy)

After deploying the admin service (Alembic migrations run automatically on startup):

```bash
# 1. Import all bootstrap corpus files into the ingestion queue
for f in bootstrap/corpus/*.yaml; do
  curl -X POST http://synesis-admin:8000/api/v1/ingestion/bootstrap \
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

## Generating from Legacy Files

If you have old `sources-*.yaml` and `seed-corpus-*.json` files:

```bash
python bootstrap/convert.py
```

This reads from `base/rag/indexer/` and writes normalized YAML to
`bootstrap/corpus/`.
