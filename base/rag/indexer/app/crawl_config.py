"""Shared crawl config defaults/parsing for web_page handler and telemetry."""

from __future__ import annotations

import os
from typing import Any

DEFAULT_DISCOVERY = "sitemap_first"
DEFAULT_MAX_PAGES = int(os.getenv("SYNESIS_INDEXER_WEB_MAX_PAGES", "80"))
DEFAULT_MAX_DEPTH = int(os.getenv("SYNESIS_INDEXER_WEB_MAX_DEPTH", "4"))
DEFAULT_MAX_SITEMAP_EXPAND = int(os.getenv("SYNESIS_INDEXER_WEB_MAX_SITEMAP_EXPAND", "24"))
DEFAULT_MIN_REQUEST_INTERVAL = float(os.getenv("SYNESIS_INDEXER_WEB_MIN_REQUEST_INTERVAL", "0.35"))


def effective_crawl_config(config: dict[str, Any] | None) -> dict[str, Any]:
    cfg = config if isinstance(config, dict) else {}
    return {
        "discovery": str(cfg.get("discovery") or DEFAULT_DISCOVERY).lower(),
        "max_pages": max(1, int(cfg.get("max_pages", DEFAULT_MAX_PAGES))),
        "max_depth": max(0, int(cfg.get("max_depth", DEFAULT_MAX_DEPTH))),
        "max_sitemap_expand": max(1, int(cfg.get("max_sitemap_expand", DEFAULT_MAX_SITEMAP_EXPAND))),
        "min_request_interval": float(cfg.get("min_request_interval", DEFAULT_MIN_REQUEST_INTERVAL)),
    }
