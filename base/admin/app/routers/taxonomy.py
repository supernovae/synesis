"""Taxonomy domain browser — Postgres-backed with YAML import/export."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import delete, select

from ..auth import UserInfo, get_current_user
from ..db.engine import async_session
from ..db.models import TaxonomyDomain
from ..deps import TAXONOMY_YAML_PATH

logger = logging.getLogger("synesis.admin.taxonomy")

router = APIRouter(prefix="/api/v1/taxonomy", tags=["taxonomy"])


async def _ensure_loaded() -> None:
    """If the taxonomy_domains table is empty, seed it from the YAML file."""
    async with async_session() as session:
        count = (await session.execute(select(TaxonomyDomain.id).limit(1))).scalar_one_or_none()
        if count is not None:
            return

    p = Path(TAXONOMY_YAML_PATH)
    if not p.exists():
        return

    try:
        raw = yaml.safe_load(p.read_text()) or {}
    except Exception as exc:
        logger.warning("taxonomy_yaml_parse_error error=%s", str(exc)[:80])
        return

    async with async_session() as session:
        for key, cfg in raw.items():
            if not isinstance(cfg, dict):
                continue
            domain = TaxonomyDomain(
                key=key,
                path=cfg.get("path", ""),
                complexity=cfg.get("complexity", 0),
                persona=cfg.get("persona", ""),
                raw_config=cfg,
            )
            session.add(domain)
        await session.commit()
    logger.info("taxonomy_seeded_from_yaml count=%d", len(raw))


@router.get("/")
async def list_domains(_user: UserInfo = Depends(get_current_user)):
    await _ensure_loaded()
    async with async_session() as session:
        result = await session.execute(select(TaxonomyDomain).order_by(TaxonomyDomain.path))
        rows = result.scalars().all()
        domains = [
            {
                "key": r.key,
                "path": r.path,
                "complexity": r.complexity,
                "persona": r.persona,
            }
            for r in rows
        ]
    return {"domains": domains}


@router.get("/{key}")
async def domain_detail(key: str, _user: UserInfo = Depends(get_current_user)):
    await _ensure_loaded()
    async with async_session() as session:
        result = await session.execute(select(TaxonomyDomain).where(TaxonomyDomain.key == key))
        row = result.scalar_one_or_none()
    if row is None:
        return {"key": key, "path": "", "complexity": 0, "persona": ""}
    cfg = row.raw_config or {}
    return {
        "key": row.key,
        "path": row.path,
        "complexity": row.complexity,
        "persona": row.persona,
        "required_elements": cfg.get("required_elements", []),
        "depth_instructions": cfg.get("depth_instructions", ""),
        "output_style_guidance": cfg.get("output_style_guidance", ""),
        "epistemic_guidance": cfg.get("epistemic_guidance", ""),
        "raw_config": cfg,
    }


@router.put("/{key}")
async def update_domain(
    key: str,
    data: dict = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    async with async_session() as session:
        result = await session.execute(select(TaxonomyDomain).where(TaxonomyDomain.key == key))
        row = result.scalar_one_or_none()
        if row is None:
            row = TaxonomyDomain(key=key)
            session.add(row)

        row.path = data.get("path", row.path)
        row.complexity = data.get("complexity", row.complexity)
        row.persona = data.get("persona", row.persona)

        cfg = dict(row.raw_config or {})
        if "required_elements" in data:
            cfg["required_elements"] = data["required_elements"]
        if "depth_instructions" in data:
            cfg["depth_instructions"] = data["depth_instructions"]
        if "output_style_guidance" in data:
            cfg["output_style_guidance"] = data["output_style_guidance"]
        if "epistemic_guidance" in data:
            cfg["epistemic_guidance"] = data["epistemic_guidance"]
        if "raw_config" in data:
            cfg = data["raw_config"]
        row.raw_config = cfg

        await session.commit()
        await session.refresh(row)
    return {
        "key": row.key,
        "path": row.path,
        "complexity": row.complexity,
        "persona": row.persona,
    }


@router.post("/sync-from-yaml")
async def sync_from_yaml(_user: UserInfo = Depends(get_current_user)):
    """Re-import taxonomy from the mounted YAML file, overwriting DB entries."""
    p = Path(TAXONOMY_YAML_PATH)
    if not p.exists():
        raise HTTPException(status_code=404, detail="Taxonomy YAML not found")

    raw = yaml.safe_load(p.read_text()) or {}
    count = 0

    async with async_session() as session:
        await session.execute(delete(TaxonomyDomain))

        for key, cfg in raw.items():
            if not isinstance(cfg, dict):
                continue
            domain = TaxonomyDomain(
                key=key,
                path=cfg.get("path", ""),
                complexity=cfg.get("complexity", 0),
                persona=cfg.get("persona", ""),
                raw_config=cfg,
            )
            session.add(domain)
            count += 1
        await session.commit()

    return {"synced": count}


@router.post("/export-yaml")
async def export_yaml(_user: UserInfo = Depends(get_current_user)):
    """Export current taxonomy DB state as YAML (for planner reload).

    Writes to the taxonomy YAML path so a planner restart picks up changes.
    """
    async with async_session() as session:
        result = await session.execute(select(TaxonomyDomain).order_by(TaxonomyDomain.path))
        rows = result.scalars().all()

    output: dict[str, Any] = {}
    for row in rows:
        if row.raw_config:
            entry = dict(row.raw_config)
        else:
            entry = {}
        entry["path"] = row.path
        entry["complexity"] = row.complexity
        entry["persona"] = row.persona
        output[row.key] = entry

    p = Path(TAXONOMY_YAML_PATH)
    try:
        p.write_text(yaml.dump(output, default_flow_style=False, allow_unicode=True))
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to write YAML: {exc}",
        ) from exc

    return {"exported": len(output), "path": str(p)}
