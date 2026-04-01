"""Sync PatternEntry rows to IngestionItem for Milvus indexing."""

from __future__ import annotations

import hashlib
import logging

from app.db.engine import async_session
from app.db.models import IngestionItem, IngestionSource, PatternEntry
from sqlalchemy import select

logger = logging.getLogger("synesis.admin.pattern_sync")

_SOURCE_NAME = "pattern_library"
_HANDLER = "pattern_library"


def _content_body(p: PatternEntry) -> str:
    """Build the corpus content from a pattern entry."""
    parts = [f"# {p.language} / {p.skill_family}: {p.pattern_id}"]
    if p.description:
        parts.append(p.description)
    if p.constraints:
        parts.append(f"Constraints: {p.constraints}")
    parts.append(f"```{p.language}\n{p.code_block}\n```")
    if p.test_snippet:
        parts.append(f"Test:\n```{p.language}\n{p.test_snippet}\n```")
    return "\n\n".join(parts)


def _compute_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


async def sync_patterns_to_ingestion() -> dict:
    """Sync enabled patterns into ingestion items (upsert by URI, skip unchanged)."""
    created = 0
    updated = 0
    unchanged = 0

    async with async_session() as session:
        source = (
            await session.execute(select(IngestionSource).where(IngestionSource.name == _SOURCE_NAME))
        ).scalar_one_or_none()

        if not source:
            source = IngestionSource(
                name=_SOURCE_NAME,
                handler=_HANDLER,
                origin_type="curated",
                authority="vetted",
                domain="pattern_library",
                status="active",
            )
            session.add(source)
            await session.flush()

        patterns = (await session.execute(select(PatternEntry).where(PatternEntry.enabled == True))).scalars().all()

        for p in patterns:
            body = _content_body(p)
            content_hash = _compute_hash(body)
            uri = f"pattern://{p.pattern_id}"

            existing = (
                await session.execute(select(IngestionItem).where(IngestionItem.uri == uri))
            ).scalar_one_or_none()

            tags = [f"lang:{p.language}", f"skill:{p.skill_family}"]
            if p.framework:
                tags.append(f"framework:{p.framework}")
            tags.append("corpus_class:coder_enriched")
            tags.append("content_profile:pattern")
            tags.append("ck:guiding")
            if p.tags:
                tags.extend(p.tags)

            confidence = max(0.3, min(1.0, p.trust_score))

            config_blob = {
                "synesis_meta": {
                    "language": p.language,
                    "languages": [p.language],
                    "corpus_class": "coder_enriched",
                    "content_profile": "pattern",
                    "constraint_kind": "guiding",
                    "scope_tags": [p.skill_family, p.language] + (p.tags or []),
                    "constraint_confidence": confidence,
                },
                "inline_content": body,
            }

            if existing:
                if existing.content_hash == content_hash:
                    unchanged += 1
                    continue
                existing.content_hash = content_hash
                existing.config = config_blob
                existing.tags = tags
                existing.status = "pending"
                updated += 1
            else:
                item = IngestionItem(
                    source_id=source.id,
                    uri=uri,
                    handler=_HANDLER,
                    title=f"{p.language} {p.skill_family}: {p.pattern_id}",
                    domain="pattern_library",
                    authority="vetted",
                    origin_type="curated",
                    tags=tags,
                    config=config_blob,
                    status="pending",
                    content_hash=content_hash,
                )
                session.add(item)
                created += 1

        await session.commit()

    total = created + updated + unchanged
    logger.info("pattern_sync_complete total=%d created=%d updated=%d unchanged=%d", total, created, updated, unchanged)
    return {"total": total, "created": created, "updated": updated, "unchanged": unchanged}
