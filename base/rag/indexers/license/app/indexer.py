"""License Compliance Indexer.

Fetches license data from SPDX, Fedora, and choosealicense.com,
merges into unified license records, chunks and embeds into Milvus.
Also loads the built-in compatibility matrix as separate chunks.

Usage:
    python -m app.indexer --sources /data/sources.yaml --compat /data/compatibility.yaml
    python -m app.indexer --sources /data/sources.yaml --compat /data/compatibility.yaml --license MIT
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import yaml
from pymilvus import FieldSchema, DataType

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "ingestion"))
from app.indexer_base import (
    MilvusWriter,
    EmbedClient,
    ProgressTracker,
    chunk_id_hash,
)

from .spdx_parser import parse_spdx_licenses, SPDXLicense
from .fedora_parser import fetch_fedora_statuses, FedoraLicenseStatus
from .choosealicense_parser import fetch_choosealicense_licenses, ChoosealicenseData
from .compatibility_loader import load_compatibility_rules, load_copyleft_classification

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.indexer.license")

COLLECTION_NAME = "licenses_v1"

LICENSE_EXTRA_FIELDS = [
    FieldSchema(name="spdx_id", dtype=DataType.VARCHAR, max_length=64),
    FieldSchema(name="license_name", dtype=DataType.VARCHAR, max_length=256),
    FieldSchema(name="osi_approved", dtype=DataType.VARCHAR, max_length=8),
    FieldSchema(name="redhat_status", dtype=DataType.VARCHAR, max_length=32),
    FieldSchema(name="copyleft", dtype=DataType.VARCHAR, max_length=16),
    FieldSchema(name="permissions", dtype=DataType.VARCHAR, max_length=512),
    FieldSchema(name="conditions", dtype=DataType.VARCHAR, max_length=512),
    FieldSchema(name="limitations", dtype=DataType.VARCHAR, max_length=512),
]

LONG_TEXT_LICENSES = {"GPL-2.0-only", "GPL-3.0-only", "AGPL-3.0-only",
                      "LGPL-2.1-only", "LGPL-3.0-only", "MPL-2.0",
                      "GPL-2.0-or-later", "GPL-3.0-or-later",
                      "AGPL-3.0-or-later", "LGPL-2.1-or-later", "LGPL-3.0-or-later"}

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


def index_licenses(
    sources: dict,
    compat_path: str,
    writer: MilvusWriter,
    embedder: EmbedClient,
    progress: ProgressTracker,
    skip_existing: bool = True,
    filter_license: str | None = None,
) -> None:
    """Main indexing pipeline: fetch from all sources, merge, chunk, embed."""
    writer.ensure_collection(
        COLLECTION_NAME,
        extra_fields=LICENSE_EXTRA_FIELDS,
        description="Open source license knowledge for compliance checking",
    )

    existing_ids: set[str] = set()
    if skip_existing:
        existing_ids = writer.existing_chunk_ids(COLLECTION_NAME)
        logger.info(f"Existing chunks in {COLLECTION_NAME}: {len(existing_ids)}")

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

    # --- Build entities ---
    entities: list[dict] = []
    skipped = 0

    for spdx_id, spdx_lic in spdx_map.items():
        fedora = fedora_map.get(spdx_id)
        choose = choose_map.get(spdx_id)
        copyleft_level = copyleft_map.get(spdx_id, "unknown")

        summary = _build_summary_text(spdx_lic, fedora, choose, copyleft_level)
        cid = chunk_id_hash(summary, f"license:{spdx_id}:summary")

        if cid not in existing_ids:
            entities.append({
                "chunk_id": cid,
                "text": summary[:8192],
                "source": f"license:{spdx_id}"[:512],
                "language": "license",
                "spdx_id": spdx_id[:64],
                "license_name": spdx_lic.name[:256],
                "osi_approved": str(spdx_lic.osi_approved).lower()[:8],
                "redhat_status": (fedora.status if fedora else "unknown")[:32],
                "copyleft": copyleft_level[:16],
                "permissions": (",".join(choose.permissions) if choose else "")[:512],
                "conditions": (",".join(choose.conditions) if choose else "")[:512],
                "limitations": (",".join(choose.limitations) if choose else "")[:512],
                "embedding": None,
            })
        else:
            skipped += 1

        # Full text chunks for verbose licenses
        if spdx_lic.full_text and spdx_id in LONG_TEXT_LICENSES:
            text_chunks = _split_full_text(spdx_lic.full_text, spdx_id)
            for i, chunk_text in enumerate(text_chunks):
                ft_cid = chunk_id_hash(chunk_text, f"license:{spdx_id}:fulltext:{i}")
                if ft_cid in existing_ids:
                    skipped += 1
                    continue
                entities.append({
                    "chunk_id": ft_cid,
                    "text": chunk_text[:8192],
                    "source": f"license:{spdx_id}:fulltext:{i}"[:512],
                    "language": "license",
                    "spdx_id": spdx_id[:64],
                    "license_name": spdx_lic.name[:256],
                    "osi_approved": str(spdx_lic.osi_approved).lower()[:8],
                    "redhat_status": (fedora.status if fedora else "unknown")[:32],
                    "copyleft": copyleft_level[:16],
                    "permissions": ""[:512],
                    "conditions": ""[:512],
                    "limitations": ""[:512],
                    "embedding": None,
                })

    if skipped:
        logger.info(f"Skipped {skipped} unchanged license chunks")

    progress.log_source("SPDX/Fedora/choosealicense", len(entities))

    # --- Compatibility rules ---
    compat_rules = load_compatibility_rules(compat_path)
    compat_entities: list[dict] = []

    for rule in compat_rules:
        text = (
            f"License Compatibility: {rule.from_license} -> {rule.to_license}\n"
            f"Compatible: {rule.compatible}\n"
            f"Note: {rule.note}"
        )
        cid = chunk_id_hash(text, f"compat:{rule.from_license}:{rule.to_license}")
        if cid in existing_ids:
            continue
        compat_entities.append({
            "chunk_id": cid,
            "text": text[:8192],
            "source": f"compat:{rule.from_license}->{rule.to_license}"[:512],
            "language": "license",
            "spdx_id": f"{rule.from_license}->{rule.to_license}"[:64],
            "license_name": "compatibility rule"[:256],
            "osi_approved": ""[:8],
            "redhat_status": ""[:32],
            "copyleft": ""[:16],
            "permissions": ""[:512],
            "conditions": ""[:512],
            "limitations": ""[:512],
            "embedding": None,
        })

    progress.log_source("Compatibility rules", len(compat_entities))

    # --- Embed and upsert all ---
    all_entities = entities + compat_entities
    if not all_entities:
        logger.info("No new chunks to embed")
        return

    texts = [e["text"] for e in all_entities]
    embeddings = embedder.embed_texts(texts)
    for entity, emb in zip(all_entities, embeddings):
        entity["embedding"] = emb

    count = writer.upsert_batch(COLLECTION_NAME, all_entities)
    logger.info(f"Upserted {count} chunks into {COLLECTION_NAME}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Synesis License Compliance Indexer")
    parser.add_argument("--sources", required=True, help="Path to sources.yaml")
    parser.add_argument("--compat", required=True, help="Path to compatibility.yaml")
    parser.add_argument("--license", default=None, help="Index only this SPDX license ID")
    parser.add_argument("--force", action="store_true", help="Re-embed all chunks")
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

    writer = MilvusWriter()
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
    main()
