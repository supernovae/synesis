"""Unified CLI for the Synesis RAG Indexer.

Usage (YAML mode — existing behavior):
    python -m app.cli --sources /data/sources.yaml
    python -m app.cli --sources /data/sources.yaml --handler github_markdown
    python -m app.cli --sources /data/sources.yaml --source "OpenShift Runbooks"
    python -m app.cli --sources /data/sources.yaml --enrich full --llm-url http://...
    python -m app.cli --sources /data/sources.yaml --dry-run

Usage (queue mode — DB-driven):
    python -m app.cli --mode queue
    python -m app.cli --mode queue --admin-url http://synesis-admin:8080

Utilities:
    python -m app.cli --list-handlers
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml
from synesis_telemetry import configure_logging, get_logger

configure_logging(service="synesis-indexer")
logger = get_logger("synesis.indexer")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Synesis Unified RAG Indexer",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python -m app.cli --sources /data/sources.yaml\n"
            "  python -m app.cli --mode queue --admin-url http://synesis-admin:8080\n"
            "  python -m app.cli --list-handlers\n"
        ),
    )
    parser.add_argument(
        "--mode",
        choices=["yaml", "queue", "staged-fetch", "staged-normalize", "staged-enrich", "synpack", "content-packs"],
        default="yaml",
        help=(
            "yaml: read sources from file (default). queue: direct NornicDB path via admin API. "
            "staged-*: S3 staged pipeline (see docs/INDEXERS.md). synpack: build/load managed doc packs. "
            "content-packs: install admin-queued SynPack downloads."
        ),
    )
    parser.add_argument("--sources", help="Path to unified sources.yaml (yaml mode only)")
    parser.add_argument("--admin-url", default="", help="Admin API base URL (queue mode)")
    parser.add_argument("--trigger", default="cron", help="Run trigger label (queue mode)")
    parser.add_argument("--handler", default=None, help="Only run sources with this handler type")
    parser.add_argument("--source", default=None, help="Only run this source by name")
    parser.add_argument("--force", action="store_true", help="Re-embed all chunks (ignore existing)")
    parser.add_argument("--dry-run", action="store_true", help="Validate config, no NornicDB/embedder")
    parser.add_argument(
        "--enrich",
        choices=["basic", "full"],
        default="basic",
        help="Enrichment level: basic (template context_prefix) or full (+ LLM summary)",
    )
    parser.add_argument("--llm-url", default="", help="LLM endpoint URL for full enrichment")
    parser.add_argument("--nornic-uri", default="", help="Override NornicDB URI")
    parser.add_argument("--embedder-url", default="", help="Override embedder URL")
    parser.add_argument(
        "--embedder-batch-size",
        type=int,
        default=8,
        help="Max texts per embedder request for SynPack build/finalize",
    )
    parser.add_argument(
        "--embedder-timeout",
        type=float,
        default=300.0,
        help="HTTP timeout per embedder request for SynPack build/finalize",
    )
    parser.add_argument(
        "--staged-batch-limit",
        type=int,
        default=8,
        help="staged-normalize / staged-enrich: max documents or jobs per claim batch",
    )
    parser.add_argument("--staged-worker-id", default="", help="staged-enrich: worker id for claim lease")
    parser.add_argument("--norm-version", default="v1", help="staged-normalize: normalized/<version>/ prefix")
    parser.add_argument("--enrich-version", default="v1", help="staged-normalize: enrich queue version label")
    parser.add_argument("--list-handlers", action="store_true", help="List available handler types")
    parser.add_argument(
        "--synpack-command",
        choices=[
            "validate",
            "load",
            "bulk-load",
            "list",
            "search",
            "build-go",
            "build-rust",
            "build-quarkus",
            "build-python",
            "build-godot",
            "build-terraform",
            "build-ecma",
            "build-bash",
            "build-language",
            "prepare-language",
            "enrich-language",
            "finalize-language",
            "build-platform",
            "prepare-platform",
            "enrich-platform",
            "finalize-platform",
        ],
        default="validate",
        help="SynPack command when --mode synpack",
    )
    parser.add_argument("--synpack", default="", help="Path to .synpack for validate/load")
    parser.add_argument("--output", default="", help="SynPack output path for build commands")
    parser.add_argument("--work-dir", default="", help="Durable work directory for staged SynPack builds")
    parser.add_argument("--pack-id", default="", help="SynPack id, e.g. go-1.26")
    parser.add_argument("--pack-version", default="1.0.0", help="SynPack artifact version")
    parser.add_argument("--source-version", default="", help="Upstream documentation/source version")
    parser.add_argument("--language", default="", help="Language for build-language, e.g. go")
    parser.add_argument("--platform", default="", help="Platform for build-platform, e.g. openshift")
    parser.add_argument("--doc-language", default="", help="Source document language/locale for SynPack builds")
    parser.add_argument("--pack-config", default="", help="Language pack config path")
    parser.add_argument("--enrichment-url", default="", help="OpenAI-compatible enrichment base URL")
    parser.add_argument("--enrichment-model", default="deepseek-v4-pro", help="Enrichment model name")
    parser.add_argument(
        "--enrichment-provider",
        default="deepseek",
        choices=["deepseek", "openai", "openai-compatible", "custom", "custom-openai"],
        help="Enrichment provider payload mode; deepseek is the default",
    )
    parser.add_argument(
        "--enrichment-token",
        "--enrichment-api-key",
        dest="enrichment_api_key",
        default="",
        help="Bearer token for the enrichment endpoint",
    )
    parser.add_argument("--enrichment-concurrency", type=int, default=6, help="Max enrichment requests in flight")
    parser.add_argument("--enrichment-max-tokens", type=int, default=8192, help="Max output tokens per enrichment call")
    parser.add_argument("--enrichment-timeout", type=float, default=180.0, help="HTTP timeout per enrichment call")
    parser.add_argument(
        "--enrichment-input-price-per-mtok",
        type=float,
        default=0.0,
        help="Optional input price per million tokens for cost estimates",
    )
    parser.add_argument(
        "--enrichment-output-price-per-mtok",
        type=float,
        default=0.0,
        help="Optional output price per million tokens for cost estimates",
    )
    parser.add_argument(
        "--estimate-cost-only",
        action="store_true",
        help="Extract chunks and print enrichment token/cost estimate without model calls or embedding",
    )
    parser.add_argument("--skip-enrichment", action="store_true", help="Use deterministic fallback enrichment")
    parser.add_argument(
        "--enrich-zero-quality",
        action="store_true",
        help="Force LLM enrichment for source_quality_score=0.0 chunks; default uses deterministic fallback",
    )
    parser.add_argument("--latest-tag", default="", help="Resolved upstream tag override, e.g. go1.26.2")
    parser.add_argument(
        "--source-dir", default="", help="Existing source checkout for language-pack build tests/debugging"
    )
    parser.add_argument(
        "--provider-schema", default="", help="Terraform providers schema JSON path for Terraform pack builds"
    )
    parser.add_argument("--query", default="", help="Query for synpack search")
    parser.add_argument("--top-k", type=int, default=5, help="Top-k for synpack search")
    parser.add_argument("--replace", action="store_true", help="Replace existing rows for pack_id when loading")
    parser.add_argument("--max-chunks", type=int, default=0, help="Build only the first N chunks (debug)")
    parser.add_argument("--batch-size", type=int, default=100, help="Staged enrichment batch size")
    parser.add_argument("--request-limit", type=int, default=0, help="Max enrichment requests to submit in this run")
    args = parser.parse_args()

    if args.list_handlers:
        from .handlers import list_handlers

        print("Available handlers:")
        for h in list_handlers():
            print(f"  - {h}")
        return

    if args.mode == "queue":
        _run_queue_mode(args)
    elif args.mode == "staged-fetch":
        _run_staged_fetch(args)
    elif args.mode == "staged-normalize":
        _run_staged_normalize(args)
    elif args.mode == "staged-enrich":
        _run_staged_enrich(args)
    elif args.mode == "synpack":
        _run_synpack(args)
    elif args.mode == "content-packs":
        _run_content_pack_mode(args)
    else:
        _run_yaml_mode(args)


def _run_staged_fetch(args: argparse.Namespace) -> None:
    from .staged_runners import run_staged_fetch

    logger.info("indexer_mode_staged_fetch", extra={"admin_url": args.admin_url or "(default)"})
    run_staged_fetch(admin_url=args.admin_url, dry_run=args.dry_run)


def _run_staged_normalize(args: argparse.Namespace) -> None:
    from .staged_runners import run_staged_normalize

    logger.info("indexer_mode_staged_normalize", extra={"admin_url": args.admin_url or "(default)"})
    run_staged_normalize(
        admin_url=args.admin_url,
        dry_run=args.dry_run,
        batch_limit=max(1, args.staged_batch_limit),
        norm_version=args.norm_version,
        enrich_version=args.enrich_version,
    )


def _run_staged_enrich(args: argparse.Namespace) -> None:
    from .staged_runners import run_staged_enrich

    logger.info("indexer_mode_staged_enrich", extra={"admin_url": args.admin_url or "(default)"})
    run_staged_enrich(
        admin_url=args.admin_url,
        dry_run=args.dry_run,
        batch_limit=max(1, args.staged_batch_limit),
        worker_id=args.staged_worker_id,
        enrich_full=args.enrich == "full",
        llm_url=args.llm_url,
        nornic_uri=args.nornic_uri,
        embedder_url=args.embedder_url,
        force=args.force,
    )


def _run_queue_mode(args: argparse.Namespace) -> None:
    """Claim items from the admin API work queue and process them."""
    from .queue_runner import run_queue

    logger.info("indexer_mode_queue", extra={"admin_url": args.admin_url or "(default)"})

    run_queue(
        admin_url=args.admin_url,
        force=args.force,
        enrich_full=args.enrich == "full",
        llm_url=args.llm_url,
        dry_run=args.dry_run,
        nornic_uri=args.nornic_uri,
        embedder_url=args.embedder_url,
        trigger=args.trigger,
    )


def _run_content_pack_mode(args: argparse.Namespace) -> None:
    """Claim admin-queued SynPack install jobs and load them into NornicDB."""
    from .content_pack_runner import run_content_pack_installs

    logger.info("indexer_mode_content_packs", extra={"admin_url": args.admin_url or "(default)"})
    run_content_pack_installs(
        admin_url=args.admin_url,
        nornic_uri=args.nornic_uri,
        dry_run=args.dry_run,
    )


def _run_yaml_mode(args: argparse.Namespace) -> None:
    """Original YAML-driven pipeline mode."""
    if not args.sources:
        logger.error("indexer_sources_required")
        sys.exit(1)

    sources_path = Path(args.sources)
    if not sources_path.exists():
        logger.error("indexer_sources_not_found", extra={"path": str(sources_path)})
        sys.exit(1)

    with open(sources_path) as f:
        config = yaml.safe_load(f)

    sources = config.get("sources", [])
    if not sources:
        logger.error("indexer_sources_empty", extra={"path": str(sources_path)})
        sys.exit(1)

    logger.info(
        "indexer_sources_loaded",
        extra={"count": len(sources), "path": str(sources_path)},
    )

    from .pipeline import run_pipeline

    run_pipeline(
        sources,
        force=args.force,
        enrich_full=args.enrich == "full",
        llm_url=args.llm_url,
        dry_run=args.dry_run,
        handler_filter=args.handler,
        source_filter=args.source,
        nornic_uri=args.nornic_uri,
        embedder_url=args.embedder_url,
    )


def _run_synpack(args: argparse.Namespace) -> None:
    from .nornic_bulk_importer import bulk_load_synpack
    from .synpack import list_packs, search_pack, validate_synpack

    if args.synpack_command == "validate":
        if not args.synpack:
            logger.error("synpack_path_required")
            sys.exit(1)
        manifest = validate_synpack(args.synpack)
        print(json_dump({"ok": True, "manifest": manifest}))
        return

    if args.synpack_command == "load":
        if not args.synpack:
            logger.error("synpack_path_required")
            sys.exit(1)
        print(json_dump(bulk_load_synpack(args.synpack, nornic_uri=args.nornic_uri or "", replace=args.replace)))
        return

    if args.synpack_command == "bulk-load":
        if not args.synpack:
            logger.error("synpack_path_required")
            sys.exit(1)
        print(json_dump(bulk_load_synpack(args.synpack, nornic_uri=args.nornic_uri or "", replace=args.replace)))
        return

    if args.synpack_command == "list":
        print(json_dump({"packs": list_packs(nornic_uri=args.nornic_uri or "")}))
        return

    if args.synpack_command == "search":
        if not args.query or not args.pack_id:
            logger.error("synpack_search_requires_query_and_pack_id")
            sys.exit(1)
        print(
            json_dump(
                {
                    "results": search_pack(
                        args.query,
                        pack_id=args.pack_id,
                        top_k=args.top_k,
                        nornic_uri=args.nornic_uri or "",
                        embedder_url=args.embedder_url or "",
                    )
                }
            )
        )
        return

    if args.synpack_command == "prepare-language":
        from .language_pack import prepare_staged_language_pack

        language = (args.language or "go").lower()
        pack_id = args.pack_id or f"{language}-latest"
        work_dir = args.work_dir or f".work/synpacks/{pack_id}"
        print(
            json_dump(
                prepare_staged_language_pack(
                    language=language,
                    work_dir=work_dir,
                    pack_config=args.pack_config,
                    pack_id=pack_id,
                    pack_version=args.pack_version,
                    source_version=args.source_version,
                    latest_tag=args.latest_tag,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_api_key=args.enrichment_api_key,
                    skip_zero_quality=not args.enrich_zero_quality,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    enrichment_input_price_per_mtok=args.enrichment_input_price_per_mtok,
                    enrichment_output_price_per_mtok=args.enrichment_output_price_per_mtok,
                    max_chunks=max(0, args.max_chunks),
                    source_dir=args.source_dir,
                    provider_schema=args.provider_schema,
                    doc_language=args.doc_language,
                )
            )
        )
        return

    if args.synpack_command == "prepare-platform":
        from .platform_pack import prepare_staged_platform_pack

        platform = (args.platform or "openshift").lower()
        pack_id = args.pack_id or f"{platform}-latest"
        work_dir = args.work_dir or f".work/synpacks/{pack_id}"
        print(
            json_dump(
                prepare_staged_platform_pack(
                    platform=platform,
                    work_dir=work_dir,
                    pack_config=args.pack_config,
                    pack_id=pack_id,
                    pack_version=args.pack_version,
                    source_version=args.source_version,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    max_chunks=max(0, args.max_chunks),
                    source_dir=args.source_dir,
                )
            )
        )
        return

    if args.synpack_command == "enrich-platform":
        from .platform_pack import enrich_staged_platform_pack

        if not args.work_dir:
            logger.error("synpack_work_dir_required")
            sys.exit(1)
        print(
            json_dump(
                enrich_staged_platform_pack(
                    work_dir=args.work_dir,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_api_key=args.enrichment_api_key,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    enrichment_timeout=args.enrichment_timeout,
                    request_limit=max(0, args.request_limit),
                    batch_size=max(1, args.batch_size),
                    skip_enrichment=args.skip_enrichment,
                )
            )
        )
        return

    if args.synpack_command == "finalize-platform":
        from .platform_pack import finalize_staged_platform_pack

        if not args.work_dir:
            logger.error("synpack_work_dir_required")
            sys.exit(1)
        manifest_path = Path(args.work_dir) / "run_manifest.json"
        pack_id = args.pack_id
        if not pack_id and manifest_path.exists():
            import json

            pack_id = str(json.loads(manifest_path.read_text(encoding="utf-8")).get("pack_id") or "synpack")
        output = args.output or f"dist/synpacks/{pack_id or 'synpack'}.synpack"
        print(
            json_dump(
                finalize_staged_platform_pack(
                    work_dir=args.work_dir,
                    output_path=output,
                    embedder_url=args.embedder_url,
                    embedder_batch_size=args.embedder_batch_size,
                    embedder_timeout=args.embedder_timeout,
                )
            )
        )
        return

    if args.synpack_command == "build-platform":
        from .platform_pack import build_platform_pack

        platform = (args.platform or "openshift").lower()
        pack_id = args.pack_id or f"{platform}-latest"
        output = args.output or f"dist/synpacks/{pack_id}.synpack"
        print(
            json_dump(
                build_platform_pack(
                    platform=platform,
                    pack_config=args.pack_config,
                    output_path=output,
                    pack_id=pack_id,
                    pack_version=args.pack_version,
                    source_version=args.source_version,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_api_key=args.enrichment_api_key,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    enrichment_timeout=args.enrichment_timeout,
                    estimate_cost_only=args.estimate_cost_only,
                    skip_enrichment=args.skip_enrichment,
                    embedder_url=args.embedder_url,
                    embedder_batch_size=args.embedder_batch_size,
                    embedder_timeout=args.embedder_timeout,
                    max_chunks=max(0, args.max_chunks),
                    source_dir=args.source_dir,
                )
            )
        )
        return

    if args.synpack_command == "enrich-language":
        from .language_pack import enrich_staged_language_pack

        if not args.work_dir:
            logger.error("synpack_work_dir_required")
            sys.exit(1)
        print(
            json_dump(
                enrich_staged_language_pack(
                    work_dir=args.work_dir,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_api_key=args.enrichment_api_key,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    enrichment_timeout=args.enrichment_timeout,
                    request_limit=max(0, args.request_limit),
                    batch_size=max(1, args.batch_size),
                    skip_enrichment=args.skip_enrichment,
                    skip_zero_quality=not args.enrich_zero_quality,
                )
            )
        )
        return

    if args.synpack_command == "finalize-language":
        from .language_pack import finalize_staged_language_pack

        if not args.work_dir:
            logger.error("synpack_work_dir_required")
            sys.exit(1)
        manifest_path = Path(args.work_dir) / "run_manifest.json"
        pack_id = args.pack_id
        if not pack_id and manifest_path.exists():
            import json

            pack_id = str(json.loads(manifest_path.read_text(encoding="utf-8")).get("pack_id") or "synpack")
        output = args.output or f"dist/synpacks/{pack_id or 'synpack'}.synpack"
        print(
            json_dump(
                finalize_staged_language_pack(
                    work_dir=args.work_dir,
                    output_path=output,
                    embedder_url=args.embedder_url,
                    embedder_batch_size=args.embedder_batch_size,
                    embedder_timeout=args.embedder_timeout,
                )
            )
        )
        return

    if args.synpack_command == "build-go":
        from .language_pack import build_language_pack

        pack_id = args.pack_id or "go-latest"
        output = args.output or f"dist/synpacks/{pack_id}.synpack"
        print(
            json_dump(
                build_language_pack(
                    language="go",
                    pack_config=args.pack_config,
                    output_path=output,
                    pack_id=pack_id,
                    pack_version=args.pack_version,
                    source_version=args.source_version,
                    latest_tag=args.latest_tag,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_api_key=args.enrichment_api_key,
                    skip_zero_quality=not args.enrich_zero_quality,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    enrichment_timeout=args.enrichment_timeout,
                    enrichment_input_price_per_mtok=args.enrichment_input_price_per_mtok,
                    enrichment_output_price_per_mtok=args.enrichment_output_price_per_mtok,
                    estimate_cost_only=args.estimate_cost_only,
                    skip_enrichment=args.skip_enrichment,
                    embedder_url=args.embedder_url,
                    embedder_batch_size=args.embedder_batch_size,
                    embedder_timeout=args.embedder_timeout,
                    max_chunks=max(0, args.max_chunks),
                    source_dir=args.source_dir,
                    doc_language=args.doc_language,
                )
            )
        )
        return

    if args.synpack_command == "build-rust":
        from .language_pack import build_language_pack

        pack_id = args.pack_id or "rust-latest"
        output = args.output or f"dist/synpacks/{pack_id}.synpack"
        print(
            json_dump(
                build_language_pack(
                    language="rust",
                    pack_config=args.pack_config,
                    output_path=output,
                    pack_id=pack_id,
                    pack_version=args.pack_version,
                    source_version=args.source_version,
                    latest_tag=args.latest_tag,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_api_key=args.enrichment_api_key,
                    skip_zero_quality=not args.enrich_zero_quality,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    enrichment_timeout=args.enrichment_timeout,
                    enrichment_input_price_per_mtok=args.enrichment_input_price_per_mtok,
                    enrichment_output_price_per_mtok=args.enrichment_output_price_per_mtok,
                    estimate_cost_only=args.estimate_cost_only,
                    skip_enrichment=args.skip_enrichment,
                    embedder_url=args.embedder_url,
                    embedder_batch_size=args.embedder_batch_size,
                    embedder_timeout=args.embedder_timeout,
                    max_chunks=max(0, args.max_chunks),
                    source_dir=args.source_dir,
                    doc_language=args.doc_language,
                )
            )
        )
        return

    if args.synpack_command == "build-quarkus":
        from .language_pack import build_language_pack

        pack_id = args.pack_id or "quarkus-latest"
        output = args.output or f"dist/synpacks/{pack_id}.synpack"
        print(
            json_dump(
                build_language_pack(
                    language="quarkus",
                    pack_config=args.pack_config,
                    output_path=output,
                    pack_id=pack_id,
                    pack_version=args.pack_version,
                    source_version=args.source_version,
                    latest_tag=args.latest_tag,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_api_key=args.enrichment_api_key,
                    skip_zero_quality=not args.enrich_zero_quality,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    enrichment_timeout=args.enrichment_timeout,
                    enrichment_input_price_per_mtok=args.enrichment_input_price_per_mtok,
                    enrichment_output_price_per_mtok=args.enrichment_output_price_per_mtok,
                    estimate_cost_only=args.estimate_cost_only,
                    skip_enrichment=args.skip_enrichment,
                    embedder_url=args.embedder_url,
                    embedder_batch_size=args.embedder_batch_size,
                    embedder_timeout=args.embedder_timeout,
                    max_chunks=max(0, args.max_chunks),
                    source_dir=args.source_dir,
                    doc_language=args.doc_language,
                )
            )
        )
        return

    if args.synpack_command == "build-python":
        from .language_pack import build_language_pack

        pack_id = args.pack_id or "python-latest"
        output = args.output or f"dist/synpacks/{pack_id}.synpack"
        print(
            json_dump(
                build_language_pack(
                    language="python",
                    pack_config=args.pack_config,
                    output_path=output,
                    pack_id=pack_id,
                    pack_version=args.pack_version,
                    source_version=args.source_version,
                    latest_tag=args.latest_tag,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_api_key=args.enrichment_api_key,
                    skip_zero_quality=not args.enrich_zero_quality,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    enrichment_timeout=args.enrichment_timeout,
                    enrichment_input_price_per_mtok=args.enrichment_input_price_per_mtok,
                    enrichment_output_price_per_mtok=args.enrichment_output_price_per_mtok,
                    estimate_cost_only=args.estimate_cost_only,
                    skip_enrichment=args.skip_enrichment,
                    embedder_url=args.embedder_url,
                    embedder_batch_size=args.embedder_batch_size,
                    embedder_timeout=args.embedder_timeout,
                    max_chunks=max(0, args.max_chunks),
                    source_dir=args.source_dir,
                    doc_language=args.doc_language,
                )
            )
        )
        return

    if args.synpack_command == "build-godot":
        from .language_pack import build_language_pack

        pack_id = args.pack_id or "godot-latest"
        output = args.output or f"dist/synpacks/{pack_id}.synpack"
        print(
            json_dump(
                build_language_pack(
                    language="godot",
                    pack_config=args.pack_config,
                    output_path=output,
                    pack_id=pack_id,
                    pack_version=args.pack_version,
                    source_version=args.source_version,
                    latest_tag=args.latest_tag,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_api_key=args.enrichment_api_key,
                    skip_zero_quality=not args.enrich_zero_quality,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    enrichment_timeout=args.enrichment_timeout,
                    enrichment_input_price_per_mtok=args.enrichment_input_price_per_mtok,
                    enrichment_output_price_per_mtok=args.enrichment_output_price_per_mtok,
                    estimate_cost_only=args.estimate_cost_only,
                    skip_enrichment=args.skip_enrichment,
                    embedder_url=args.embedder_url,
                    embedder_batch_size=args.embedder_batch_size,
                    embedder_timeout=args.embedder_timeout,
                    max_chunks=max(0, args.max_chunks),
                    source_dir=args.source_dir,
                    doc_language=args.doc_language,
                )
            )
        )
        return

    if args.synpack_command == "build-terraform":
        from .language_pack import build_language_pack

        pack_id = args.pack_id or "terraform-latest"
        output = args.output or f"dist/synpacks/{pack_id}.synpack"
        print(
            json_dump(
                build_language_pack(
                    language="terraform",
                    pack_config=args.pack_config,
                    output_path=output,
                    pack_id=pack_id,
                    pack_version=args.pack_version,
                    source_version=args.source_version,
                    latest_tag=args.latest_tag,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_api_key=args.enrichment_api_key,
                    skip_zero_quality=not args.enrich_zero_quality,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    enrichment_timeout=args.enrichment_timeout,
                    enrichment_input_price_per_mtok=args.enrichment_input_price_per_mtok,
                    enrichment_output_price_per_mtok=args.enrichment_output_price_per_mtok,
                    estimate_cost_only=args.estimate_cost_only,
                    skip_enrichment=args.skip_enrichment,
                    embedder_url=args.embedder_url,
                    embedder_batch_size=args.embedder_batch_size,
                    embedder_timeout=args.embedder_timeout,
                    max_chunks=max(0, args.max_chunks),
                    source_dir=args.source_dir,
                    provider_schema=args.provider_schema,
                    doc_language=args.doc_language,
                )
            )
        )
        return

    if args.synpack_command == "build-ecma":
        from .language_pack import build_language_pack

        pack_id = args.pack_id or "ecma-latest"
        output = args.output or f"dist/synpacks/{pack_id}.synpack"
        print(
            json_dump(
                build_language_pack(
                    language="ecma",
                    pack_config=args.pack_config,
                    output_path=output,
                    pack_id=pack_id,
                    pack_version=args.pack_version,
                    source_version=args.source_version,
                    latest_tag=args.latest_tag,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_api_key=args.enrichment_api_key,
                    skip_zero_quality=not args.enrich_zero_quality,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    enrichment_timeout=args.enrichment_timeout,
                    enrichment_input_price_per_mtok=args.enrichment_input_price_per_mtok,
                    enrichment_output_price_per_mtok=args.enrichment_output_price_per_mtok,
                    estimate_cost_only=args.estimate_cost_only,
                    skip_enrichment=args.skip_enrichment,
                    embedder_url=args.embedder_url,
                    embedder_batch_size=args.embedder_batch_size,
                    embedder_timeout=args.embedder_timeout,
                    max_chunks=max(0, args.max_chunks),
                    source_dir=args.source_dir,
                    provider_schema=args.provider_schema,
                    doc_language=args.doc_language,
                )
            )
        )
        return

    if args.synpack_command == "build-bash":
        from .language_pack import build_language_pack

        pack_id = args.pack_id or "bash-latest"
        output = args.output or f"dist/synpacks/{pack_id}.synpack"
        print(
            json_dump(
                build_language_pack(
                    language="bash",
                    pack_config=args.pack_config,
                    output_path=output,
                    pack_id=pack_id,
                    pack_version=args.pack_version,
                    source_version=args.source_version,
                    latest_tag=args.latest_tag,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_api_key=args.enrichment_api_key,
                    skip_zero_quality=not args.enrich_zero_quality,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    enrichment_timeout=args.enrichment_timeout,
                    enrichment_input_price_per_mtok=args.enrichment_input_price_per_mtok,
                    enrichment_output_price_per_mtok=args.enrichment_output_price_per_mtok,
                    estimate_cost_only=args.estimate_cost_only,
                    skip_enrichment=args.skip_enrichment,
                    embedder_url=args.embedder_url,
                    embedder_batch_size=args.embedder_batch_size,
                    embedder_timeout=args.embedder_timeout,
                    max_chunks=max(0, args.max_chunks),
                    source_dir=args.source_dir,
                    doc_language=args.doc_language,
                )
            )
        )
        return

    if args.synpack_command == "build-language":
        from .language_pack import build_language_pack

        language = (args.language or "go").lower()
        pack_id = args.pack_id or f"{language}-latest"
        output = args.output or f"dist/synpacks/{pack_id}.synpack"
        print(
            json_dump(
                build_language_pack(
                    language=language,
                    pack_config=args.pack_config,
                    output_path=output,
                    pack_id=pack_id,
                    pack_version=args.pack_version,
                    source_version=args.source_version,
                    latest_tag=args.latest_tag,
                    enrichment_url=args.enrichment_url or args.llm_url,
                    enrichment_model=args.enrichment_model,
                    enrichment_provider=args.enrichment_provider,
                    enrichment_api_key=args.enrichment_api_key,
                    skip_zero_quality=not args.enrich_zero_quality,
                    enrichment_concurrency=max(1, min(args.enrichment_concurrency, 8)),
                    enrichment_max_tokens=args.enrichment_max_tokens,
                    enrichment_timeout=args.enrichment_timeout,
                    enrichment_input_price_per_mtok=args.enrichment_input_price_per_mtok,
                    enrichment_output_price_per_mtok=args.enrichment_output_price_per_mtok,
                    estimate_cost_only=args.estimate_cost_only,
                    skip_enrichment=args.skip_enrichment,
                    embedder_url=args.embedder_url,
                    embedder_batch_size=args.embedder_batch_size,
                    embedder_timeout=args.embedder_timeout,
                    source_dir=args.source_dir,
                    max_chunks=max(0, args.max_chunks),
                    provider_schema=args.provider_schema,
                    doc_language=args.doc_language,
                )
            )
        )


def json_dump(value: object) -> str:
    import json

    return json.dumps(value, indent=2, sort_keys=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("indexer_crashed")
        sys.exit(1)
