# Retained source preparation code

The supported entry point here is the optional [saved-HTML converter](../../../docs/SOURCE_PACKS.md#prepare-saved-html-without-a-service):

```bash
uv run --script base/rag/indexer/app/extract.py --help
```

It runs independently with two declared Python dependencies. It does not need the full requirements file, a browser, model endpoint or service.

The remaining handlers and text helpers are candidates for bounded local source preparation. Tests preserve static crawl/redirect/robots/size limits, HTML extraction, Markdown selection, structured text splitting and document normalization. The full optional development environment is locked for Python 3.12 with a Linux CI target. Network acquisition and PDF/code parsing are not exposed through the local CLI or MCP tools. These handlers do not yet share the explicit-root and publication contract of the saved-HTML command; do not treat their presence as shipped connector support.

Planner/Yarn/Admin integration, queue workers, staged S3 jobs, embeddings, inference enrichment, NornicDB writers, old graph/vector pack builders and deployment files have been removed. The source-pack format lives only in [the Node core](../../../packages/synesis-mcp/).

Before retaining another handler in the product, identify a real source-preparation need and preserve original locators, hashes, licensing and reviewable derived text. Add a bounded command only if existing client/file tools cannot adequately satisfy that need. Otherwise remove the unused handler; this directory is not a second ingestion platform.
