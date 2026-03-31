"""Load patterns from YAML files into PatternEntry rows (upsert by pattern_id)."""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Any

import yaml
from app.db.engine import async_session
from app.db.models import PatternEntry
from sqlalchemy import select

logger = logging.getLogger("synesis.admin.pattern_loader")


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()[:16]


async def load_patterns_from_yaml(path: str | Path) -> dict:
    """Parse a YAML file and upsert PatternEntry rows.

    Returns counts: {created, updated, unchanged, errors}.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Pattern file not found: {path}")

    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    entries: list[dict[str, Any]] = raw.get("patterns", []) if isinstance(raw, dict) else []

    created = 0
    updated = 0
    unchanged = 0
    errors = 0

    async with async_session() as session:
        for entry in entries:
            pid = entry.get("pattern_id", "").strip()
            if not pid:
                errors += 1
                continue

            code = entry.get("code_block", "").strip()
            if not code:
                errors += 1
                continue

            content_hash = _hash_code(code)

            existing = (
                await session.execute(
                    select(PatternEntry).where(PatternEntry.pattern_id == pid)
                )
            ).scalar_one_or_none()

            if existing:
                if existing.content_hash == content_hash:
                    unchanged += 1
                    continue
                existing.code_block = code
                existing.description = entry.get("description", "")
                existing.constraints = entry.get("constraints", "")
                existing.test_snippet = entry.get("test_snippet", "")
                existing.framework = entry.get("framework", "")
                existing.tags = entry.get("tags", [])
                existing.content_hash = content_hash
                updated += 1
            else:
                row = PatternEntry(
                    pattern_id=pid,
                    language=entry.get("language", "").strip(),
                    framework=entry.get("framework", ""),
                    skill_family=entry.get("skill_family", "").strip(),
                    code_block=code,
                    description=entry.get("description", ""),
                    constraints=entry.get("constraints", ""),
                    test_snippet=entry.get("test_snippet", ""),
                    tags=entry.get("tags", []),
                    content_hash=content_hash,
                    created_by="bootstrap",
                )
                session.add(row)
                created += 1

        await session.commit()

    logger.info("pattern_load_complete file=%s created=%d updated=%d unchanged=%d errors=%d", path.name, created, updated, unchanged, errors)
    return {"file": path.name, "created": created, "updated": updated, "unchanged": unchanged, "errors": errors}


async def load_patterns_from_directory(directory: str | Path) -> dict:
    """Load all YAML files from a directory."""
    directory = Path(directory)
    results = []
    for yf in sorted(directory.glob("*.yaml")):
        try:
            r = await load_patterns_from_yaml(yf)
            results.append(r)
        except Exception as exc:
            logger.warning("pattern_load_file_error file=%s error=%s", yf.name, exc)
            results.append({"file": yf.name, "error": str(exc)})
    return {"files": results}
