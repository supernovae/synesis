"""Taxonomy domain browser."""

from __future__ import annotations

import logging
from pathlib import Path

import yaml
from fastapi import APIRouter, Depends

from ..auth import UserInfo, get_current_user
from ..deps import TAXONOMY_YAML_PATH

logger = logging.getLogger("synesis.admin.taxonomy")

router = APIRouter(prefix="/api/v1/taxonomy", tags=["taxonomy"])

_taxonomy_cache: list[dict] | None = None


def _load_taxonomy() -> list[dict]:
    global _taxonomy_cache
    if _taxonomy_cache is not None:
        return _taxonomy_cache
    p = Path(TAXONOMY_YAML_PATH)
    if not p.exists():
        return []
    try:
        raw = yaml.safe_load(p.read_text()) or {}
        domains = []
        for key, cfg in raw.items():
            if not isinstance(cfg, dict):
                continue
            domains.append({
                "key": key,
                "path": cfg.get("path", ""),
                "complexity": cfg.get("complexity", 0),
                "persona": cfg.get("persona", ""),
            })
        _taxonomy_cache = sorted(domains, key=lambda d: d["path"])
        return _taxonomy_cache
    except Exception as exc:
        logger.warning("taxonomy_load_error error=%s", str(exc)[:80])
        return []


@router.get("/")
async def list_domains(_user: UserInfo = Depends(get_current_user)):
    return {"domains": _load_taxonomy()}


@router.get("/{key}")
async def domain_detail(key: str, _user: UserInfo = Depends(get_current_user)):
    for d in _load_taxonomy():
        if d["key"] == key:
            return d
    return {"key": key, "path": "", "complexity": 0, "persona": ""}
