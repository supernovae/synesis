# Synesis RAG Content Packs

The admin dashboard can install hosted `.synpack` archives from a catalog URL.
Configure the catalog in **RAG Pipeline -> Content Packs**.

## Catalog Format

Host a JSON file, commonly named `synesis-pack-catalog.json`, at an HTTPS URL:

```json
{
  "name": "Synesis Content Packs",
  "version": "1",
  "packs": [
    {
      "pack_id": "go-1-26",
      "name": "Go 1.26",
      "description": "Curated Go standard library and toolchain reference pack.",
      "version": "1.0.0",
      "download_url": "https://example-bucket.s3.amazonaws.com/synpacks/go-1-26.synpack",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "size_bytes": 104857600,
      "domain": "go",
      "language": "go",
      "tags": ["language-pack", "stdlib"]
    }
  ]
}
```

Every pack entry must include `pack_id`, `download_url`, and `sha256`.
Both catalog and pack downloads must use HTTPS. The indexer validates the
checksum before loading the pack into NornicDB.

## Install Flow

Admin stores the catalog URL and creates install jobs. The Helm-managed
`synesis-indexer-content-packs` CronJob claims pending jobs, downloads the
archive, validates it with the existing SynPack loader, and writes the content
graph nodes and edges into NornicDB.
