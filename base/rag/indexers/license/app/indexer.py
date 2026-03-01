"""License Compliance Indexer.

Fetches license data from SPDX, Fedora, and choosealicense.com,
merges into unified license records, chunks and embeds into synesis_catalog
with indexer_source=license. Full license text stored for verbatim recall
when creating LICENSE files. Also loads the built-in compatibility matrix.

Usage:
    python -m app.indexer --sources /data/sources.yaml --compat /data/compatibility.yaml
    python -m app.indexer --sources /data/sources.yaml --compat /data/compatibility.yaml --license MIT
"""

from __future__ import annotations

import logging
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.indexer.license")
logger.info("License Compliance Indexer starting (pid %d)", __import__("os").getpid())

import argparse
from pathlib import Path

import yaml

from .catalog_schema import SYNESIS_CATALOG, catalog_entity, ensure_synesis_catalog
from .choosealicense_parser import ChoosealicenseData, fetch_choosealicense_licenses
from .compatibility_loader import load_compatibility_rules, load_copyleft_classification
from .fedora_parser import FedoraLicenseStatus, fetch_fedora_statuses
from .indexer_base import (
    EmbedClient,
    MilvusWriter,
    ProgressTracker,
    chunk_id_hash,
)
from .spdx_parser import SPDXLicense, parse_spdx_licenses

LONG_TEXT_LICENSES = {
    "GPL-2.0-only",
    "GPL-3.0-only",
    "AGPL-3.0-only",
    "LGPL-2.1-only",
    "LGPL-3.0-only",
    "MPL-2.0",
    "GPL-2.0-or-later",
    "GPL-3.0-or-later",
    "AGPL-3.0-or-later",
    "LGPL-2.1-or-later",
    "LGPL-3.0-or-later",
}

MAX_FULL_TEXT_CHUNK = 6000


def _build_summary_text(
    spdx: SPDXLicense,
    fedora: FedoraLicenseStatus | None,
    choose: ChoosealicenseData | None,
    copyleft_level: str,
) -> str:
    """Build a structured summary chunk for one license."""
    parts = [
        f"License: {spdx.name} (SPDX: {spdx.spdx_id})",
        f"OSI Approved: {'Yes' if spdx.osi_approved else 'No'}",
        f"Copyleft: {copyleft_level}",
    ]

    if fedora:
        parts.append(f"Red Hat / Fedora Status: {fedora.status}")

    if choose:
        if choose.description:
            parts.append(f"Description: {choose.description}")
        if choose.permissions:
            parts.append(f"Permissions: {', '.join(choose.permissions)}")
        if choose.conditions:
            parts.append(f"Conditions: {', '.join(choose.conditions)}")
        if choose.limitations:
            parts.append(f"Limitations: {', '.join(choose.limitations)}")
        if choose.how:
            parts.append(f"How to apply: {choose.how}")

    return "\n".join(parts)


def _split_full_text(text: str, spdx_id: str) -> list[str]:
    """Split long license texts into chunks at paragraph boundaries."""
    if len(text) <= MAX_FULL_TEXT_CHUNK:
        return [text] if text.strip() else []

    chunks: list[str] = []
    paragraphs = text.split("\n\n")
    current = f"[{spdx_id} full text continued]\n\n"

    for para in paragraphs:
        if len(current) + len(para) + 2 > MAX_FULL_TEXT_CHUNK:
            if current.strip():
                chunks.append(current.strip())
            current = f"[{spdx_id} full text continued]\n\n{para}\n\n"
        else:
            current += para + "\n\n"

    if current.strip():
        chunks.append(current.strip())

    return chunks


def _tags_for_license(
    spdx_id: str,
    license_name: str,
    osi_approved: bool,
    redhat_status: str,
    copyleft: str,
    choose: ChoosealicenseData | None,
) -> str:
    """Build tags string for license metadata (catalog schema)."""
    parts = [f"spdx:{spdx_id}", f"name:{license_name[:64]}", f"osi:{str(osi_approved).lower()}"]
    parts.append(f"rh:{redhat_status[:24]}")
    parts.append(f"copyleft:{copyleft[:16]}")
    if choose:
        if choose.permissions:
            parts.append(f"perm:{','.join(choose.permissions)[:80]}")
        if choose.conditions:
            parts.append(f"cond:{','.join(choose.conditions)[:80]}")
    return " ".join(parts)[:512]


def index_licenses(
    sources: dict,
    compat_path: str,
    writer: MilvusWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    skip_existing: bool = True,
    filter_license: str | None = None,
) -> None:
    """Main indexing pipeline: fetch from all sources, merge, chunk, embed into synesis_catalog."""
    ensure_synesis_catalog()
    existing_ids: set[str] = writer.existing_chunk_ids(SYNESIS_CATALOG) if skip_existing else set()
    logger.info(f"Existing chunks in {SYNESIS_CATALOG}: {len(existing_ids)}")

    # --- Fetch SPDX ---
    spdx_cfg = sources.get("spdx", {})
    spdx_licenses = parse_spdx_licenses(
        spdx_cfg.get("licenses_url", ""),
        spdx_cfg.get("details_base_url", ""),
        fetch_full_text=True,
    )
    spdx_map: dict[str, SPDXLicense] = {lic.spdx_id: lic for lic in spdx_licenses}

    # --- Fetch Fedora ---
    fedora_cfg = sources.get("fedora", {})
    all_spdx_ids = list(spdx_map.keys())
    fedora_map = fetch_fedora_statuses(
        fedora_cfg.get("repo_url", ""),
        fedora_cfg.get("common_licenses", all_spdx_ids[:50]),
    )

    # --- Fetch choosealicense ---
    choose_cfg = sources.get("choosealicense", {})
    choose_licenses = fetch_choosealicense_licenses(
        choose_cfg.get("repo", "github/choosealicense.com"),
        choose_cfg.get("branch", "gh-pages"),
        choose_cfg.get("licenses_path", "_licenses"),
    )
    choose_map: dict[str, ChoosealicenseData] = {c.spdx_id: c for c in choose_licenses}

    # --- Load copyleft classification ---
    copyleft_map = load_copyleft_classification(compat_path)

    # --- Filter if requested ---
    if filter_license:
        target = filter_license.upper()
        spdx_map = {k: v for k, v in spdx_map.items() if k.upper() == target}
        if not spdx_map:
            logger.warning(f"License '{filter_license}' not found in SPDX data")
            return

    # --- Build raw entities (cid, text, source, tags) ---
    raw_entities: list[tuple[str, str, str, str]] = []
    skipped = 0

    for spdx_id, spdx_lic in spdx_map.items():
        fedora = fedora_map.get(spdx_id)
        choose = choose_map.get(spdx_id)
        copyleft_level = copyleft_map.get(spdx_id, "unknown")
        tags = _tags_for_license(
            spdx_id,
            spdx_lic.name,
            spdx_lic.osi_approved,
            fedora.status if fedora else "unknown",
            copyleft_level,
            choose,
        )

        summary = _build_summary_text(spdx_lic, fedora, choose, copyleft_level)
        cid = chunk_id_hash(summary, f"license:{spdx_id}:summary")

        if cid not in existing_ids:
            raw_entities.append((cid, summary[:8192], f"license:{spdx_id}"[:512], tags))
        else:
            skipped += 1

        # Full text chunks for verbose licenses (verbatim recall for LICENSE file creation)
        if spdx_lic.full_text and spdx_id in LONG_TEXT_LICENSES:
            text_chunks = _split_full_text(spdx_lic.full_text, spdx_id)
            for i, chunk_text in enumerate(text_chunks):
                ft_cid = chunk_id_hash(chunk_text, f"license:{spdx_id}:fulltext:{i}")
                if ft_cid in existing_ids:
                    skipped += 1
                    continue
                ft_tags = f"spdx:{spdx_id} fulltext:true " + tags[:400]
                raw_entities.append((
                    ft_cid,
                    chunk_text[:8192],
                    f"license:{spdx_id}:fulltext:{i}"[:512],
                    ft_tags[:512],
                ))

    if skipped:
        logger.info(f"Skipped {skipped} unchanged license chunks")

    progress.log_source("SPDX/Fedora/choosealicense", len(raw_entities))

    # --- Compatibility rules ---
    compat_rules = load_compatibility_rules(compat_path)
    compat_raw: list[tuple[str, str, str, str]] = []

    for rule in compat_rules:
        text = (
            f"License Compatibility: {rule.from_license} -> {rule.to_license}\n"
            f"Compatible: {rule.compatible}\n"
            f"Note: {rule.note}"
        )
        cid = chunk_id_hash(text, f"compat:{rule.from_license}:{rule.to_license}")
        if cid in existing_ids:
            continue
        tags = f"compat {rule.from_license}->{rule.to_license}"
        compat_raw.append((cid, text[:8192], f"compat:{rule.from_license}->{rule.to_license}"[:512], tags[:512]))

    progress.log_source("Compatibility rules", len(compat_raw))

    # --- Embed and upsert all into synesis_catalog ---
    all_raw = raw_entities + compat_raw
    if not all_raw:
        logger.info("No new chunks to embed")
        return

    texts = [e[1] for e in all_raw]
    embeddings = embedder.embed_texts(texts)
    catalog_entities = []
    for (cid, text, source, tags), emb in zip(all_raw, embeddings):
        catalog_entities.append(
            catalog_entity(
                chunk_id=cid,
                text=text,
                source=source,
                language="license",
                embedding=emb,
                domain="license",
                indexer_source="license",
                tags=tags,
            )
        )

    count = writer.upsert_batch(SYNESIS_CATALOG, catalog_entities)
    logger.info(f"Upserted {count} chunks into {SYNESIS_CATALOG}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Synesis License Compliance Indexer")
    parser.add_argument("--sources", required=True, help="Path to sources.yaml")
    parser.add_argument("--compat", required=True, help="Path to compatibility.yaml")
    parser.add_argument("--license", default=None, help="Index only this SPDX license ID")
    parser.add_argument("--force", action="store_true", help="Re-embed all chunks")
    parser.add_argument(
        "--dry-run", action="store_true", help="Validate config and sources without connecting to Milvus/embedder"
    )
    args = parser.parse_args()

    sources_path = Path(args.sources)
    if not sources_path.exists():
        logger.error(f"Sources file not found: {sources_path}")
        sys.exit(1)

    compat_path = Path(args.compat)
    if not compat_path.exists():
        logger.error(f"Compatibility file not found: {compat_path}")
        sys.exit(1)

    with open(sources_path) as f:
        sources = yaml.safe_load(f)

    with open(compat_path) as f:
        compat = yaml.safe_load(f)

    logger.info(f"Loaded sources from {sources_path}")
    logger.info(f"Loaded {len(compat.get('rules', []))} compatibility rules from {compat_path}")
    logger.info(f"SPDX source: {sources.get('spdx', {}).get('licenses_url', 'N/A')}")

    if args.dry_run:
        logger.info("Dry run complete -- config and sources are valid")
        return

    try:
        writer = MilvusWriter()
    except Exception as e:
        logger.error(f"Failed to connect to Milvus: {e}")
        sys.exit(1)

    embedder = EmbedClient()
    progress = ProgressTracker(name="License Compliance Indexer")

    index_licenses(
        sources,
        str(compat_path),
        writer,
        embedder,
        progress,
        skip_existing=not args.force,
        filter_license=args.license,
    )

    progress.log_complete()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("License Compliance Indexer crashed with unhandled exception")
        sys.exit(1)
