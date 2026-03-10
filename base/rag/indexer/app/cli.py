"""Unified CLI for the Synesis RAG Indexer.

Usage:
    python -m app.cli --sources /data/sources.yaml
    python -m app.cli --sources /data/sources.yaml --handler github_markdown
    python -m app.cli --sources /data/sources.yaml --source "OpenShift Runbooks"
    python -m app.cli --sources /data/sources.yaml --enrich full --llm-url http://...
    python -m app.cli --sources /data/sources.yaml --dry-run
    python -m app.cli --list-handlers
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import yaml

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("synesis.indexer")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Synesis Unified RAG Indexer",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python -m app.cli --sources /data/sources.yaml\n"
            "  python -m app.cli --sources /data/sources.yaml --handler github_markdown\n"
            "  python -m app.cli --sources /data/sources.yaml --force --enrich full\n"
            "  python -m app.cli --list-handlers\n"
        ),
    )
    parser.add_argument("--sources", help="Path to unified sources.yaml")
    parser.add_argument("--handler", default=None, help="Only run sources with this handler type")
    parser.add_argument("--source", default=None, help="Only run this source by name")
    parser.add_argument("--force", action="store_true", help="Re-embed all chunks (ignore existing)")
    parser.add_argument("--dry-run", action="store_true", help="Validate config, no Milvus/embedder")
    parser.add_argument(
        "--enrich",
        choices=["basic", "full"],
        default="basic",
        help="Enrichment level: basic (template context_prefix + KeyBERT) or full (+ LLM summary)",
    )
    parser.add_argument("--llm-url", default="", help="LLM endpoint URL for full enrichment")
    parser.add_argument("--milvus-uri", default="", help="Override Milvus URI")
    parser.add_argument("--embedder-url", default="", help="Override embedder URL")
    parser.add_argument("--list-handlers", action="store_true", help="List available handler types")
    args = parser.parse_args()

    if args.list_handlers:
        from .handlers import list_handlers

        print("Available handlers:")
        for h in list_handlers():
            print(f"  - {h}")
        return

    if not args.sources:
        parser.error("--sources is required (or use --list-handlers)")

    sources_path = Path(args.sources)
    if not sources_path.exists():
        logger.error("Sources file not found: %s", sources_path)
        sys.exit(1)

    with open(sources_path) as f:
        config = yaml.safe_load(f)

    sources = config.get("sources", [])
    if not sources:
        logger.error("No 'sources' list found in %s", sources_path)
        sys.exit(1)

    logger.info("Loaded %d sources from %s", len(sources), sources_path)

    from .pipeline import run_pipeline

    run_pipeline(
        sources,
        force=args.force,
        enrich_full=args.enrich == "full",
        llm_url=args.llm_url,
        dry_run=args.dry_run,
        handler_filter=args.handler,
        source_filter=args.source,
        milvus_uri=args.milvus_uri,
        embedder_url=args.embedder_url,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("Synesis Unified Indexer crashed")
        sys.exit(1)
