"""Shared crawl config defaults/parsing for web_page handler and telemetry."""

from __future__ import annotations

import os
from typing import Any

DEFAULT_DISCOVERY = "sitemap_first"
DEFAULT_MAX_PAGES = int(os.getenv("SYNESIS_INDEXER_WEB_MAX_PAGES", "220"))
DEFAULT_MAX_DEPTH = int(os.getenv("SYNESIS_INDEXER_WEB_MAX_DEPTH", "7"))
DEFAULT_MAX_SITEMAP_EXPAND = int(os.getenv("SYNESIS_INDEXER_WEB_MAX_SITEMAP_EXPAND", "220"))
DEFAULT_MIN_REQUEST_INTERVAL = float(os.getenv("SYNESIS_INDEXER_WEB_MIN_REQUEST_INTERVAL", "0.35"))
DEFAULT_MAX_LINKS_PER_PAGE = int(os.getenv("SYNESIS_INDEXER_WEB_MAX_LINKS_PER_PAGE", "120"))

PROFILE_DEFAULTS: dict[str, dict[str, int]] = {
    "reference": {"max_pages": 320, "max_depth": 8, "max_sitemap_expand": 320, "max_links_per_page": 140},
    "tutorial": {"max_pages": 260, "max_depth": 7, "max_sitemap_expand": 260, "max_links_per_page": 140},
    "blog": {"max_pages": 220, "max_depth": 6, "max_sitemap_expand": 200, "max_links_per_page": 120},
}


def effective_crawl_config(config: dict[str, Any] | None) -> dict[str, Any]:
    cfg = config if isinstance(config, dict) else {}
    profile = str(cfg.get("profile") or "").strip().lower()
    profile_defaults = PROFILE_DEFAULTS.get(profile, {})
    max_pages_default = int(profile_defaults.get("max_pages", DEFAULT_MAX_PAGES))
    max_depth_default = int(profile_defaults.get("max_depth", DEFAULT_MAX_DEPTH))
    max_sitemap_default = int(profile_defaults.get("max_sitemap_expand", DEFAULT_MAX_SITEMAP_EXPAND))
    max_links_default = int(profile_defaults.get("max_links_per_page", DEFAULT_MAX_LINKS_PER_PAGE))
    return {
        "discovery": str(cfg.get("discovery") or DEFAULT_DISCOVERY).lower(),
        "max_pages": max(1, int(cfg.get("max_pages", max_pages_default))),
        "max_depth": max(0, int(cfg.get("max_depth", max_depth_default))),
        "max_sitemap_expand": max(1, int(cfg.get("max_sitemap_expand", max_sitemap_default))),
        "min_request_interval": float(cfg.get("min_request_interval", DEFAULT_MIN_REQUEST_INTERVAL)),
        "max_links_per_page": max(1, int(cfg.get("max_links_per_page", max_links_default))),
        "profile": profile,
    }
