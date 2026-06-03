"""Deterministic ingestion discovery heuristics.

This module is intentionally free of DB writes and network fetches. It is used
by the ingestion router for URL preflight and preview endpoints.
"""

from __future__ import annotations

import ipaddress
from typing import Any
from urllib.parse import urlparse

from fastapi import HTTPException

TAG_SIGNALS: dict[str, str] = {
    "/docs": "documentation",
    "/documentation": "documentation",
    "/api": "api-reference",
    "/reference": "reference",
    "/guide": "guide",
    "/tutorial": "tutorial",
    "/blog": "blog",
    "/changelog": "changelog",
}

CORPUS_HEURISTICS: dict[str, str] = {
    "github.com": "coder_enriched",
    "docs.python.org": "coder_enriched",
    "go.dev": "coder_enriched",
    "kubernetes.io": "coder_enriched",
    "developer.mozilla.org": "coder_enriched",
    "rust-lang.org": "coder_enriched",
    "typescriptlang.org": "coder_enriched",
    "registry.terraform.io": "coder_enriched",
    "docs.oracle.com": "coder_enriched",
    "learn.microsoft.com": "coder_enriched",
    "docs.aws.amazon.com": "coder_enriched",
    "cloud.google.com": "coder_enriched",
}


def is_public_discovery_host(host: str) -> bool:
    """Allow hostnames/IPs that are not local/private targets."""
    hostname = (host or "").strip().lower().rstrip(".")
    if not hostname:
        return False
    if hostname in {"localhost", "localhost.localdomain"} or hostname.endswith(".local"):
        return False
    try:
        ip_obj = ipaddress.ip_address(hostname)
    except ValueError:
        return True
    if (
        ip_obj.is_private
        or ip_obj.is_loopback
        or ip_obj.is_link_local
        or ip_obj.is_multicast
        or ip_obj.is_reserved
        or ip_obj.is_unspecified
    ):
        return False
    return True


def validate_discovery_target_url(raw_url: str) -> tuple[str, Any]:
    parsed = urlparse(raw_url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="URL must start with http:// or https://")
    if parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="URL credentials are not allowed")
    if not is_public_discovery_host(parsed.hostname or ""):
        raise HTTPException(status_code=400, detail="URL host is not allowed for discovery")
    return parsed.geturl(), parsed


async def run_heuristic_discovery(
    raw_url: str,
    *,
    hints: str = "",
) -> dict[str, Any]:
    """Pure-heuristic URL analysis. No LLM, no DB writes."""
    raw_url, parsed = validate_discovery_target_url(raw_url)
    host = parsed.hostname or ""
    path = parsed.path.rstrip("/").lower()

    risk_flags: list[str] = []
    notes_parts: list[str] = []
    recommendation_reasons: list[str] = []

    handler = "web_page"
    if any(raw_url.endswith(ext) for ext in (".pdf",)):
        handler = "pdf_document"
        recommendation_reasons.append("File extension indicates PDF document")
    elif any(raw_url.endswith(ext) for ext in (".md", ".rst", ".txt")):
        handler = "html_document"
        recommendation_reasons.append("File extension indicates plain-text document")
    elif ((host == "github.com" or host.endswith(".github.com")) and "/tree/" in raw_url) or (
        host == "github.com" or host.endswith(".github.com")
    ):
        handler = "github_repo"
        recommendation_reasons.append("GitHub host detected — using repo handler")
    else:
        recommendation_reasons.append("Default web_page handler for HTTP URL")

    domain = ""
    domain_parts = host.replace("www.", "").split(".")
    if len(domain_parts) >= 2:
        domain = domain_parts[-2]

    title = ""
    path_segments = [s for s in parsed.path.strip("/").split("/") if s]
    if path_segments:
        title = path_segments[-1].replace("-", " ").replace("_", " ").title()

    tags: list[str] = []
    for signal, tag in TAG_SIGNALS.items():
        if signal in path:
            tags.append(tag)

    notes_parts.append("Network probing disabled for discovery safety")
    sitemap_url_count = 0

    config: dict[str, Any] = {}
    if handler == "web_page":
        config["url"] = raw_url
        config["discovery"] = "sitemap_first"
        if sitemap_url_count > 500:
            config["max_pages"] = 200
            config["max_depth"] = 2
            risk_flags.append("high_page_count_estimate")
            notes_parts.append(f"Estimated {sitemap_url_count}+ pages — capped to 200 for active mode")
        elif sitemap_url_count > 100:
            config["max_pages"] = 100
            config["max_depth"] = 3
        else:
            config["max_pages"] = 80
            config["max_depth"] = 4

    recommended_mode = "active"
    if sitemap_url_count > 200 or "high_page_count_estimate" in risk_flags:
        recommended_mode = "batch"
        recommendation_reasons.append("High page count suggests batch mode")
    config["execution_mode"] = recommended_mode

    if hints:
        hints_lower = hints.lower()
        if "docs" in hints_lower or "documentation" in hints_lower:
            if "documentation" not in tags:
                tags.append("documentation")
            config["discovery"] = "sitemap_first"
        if "api" in hints_lower and "api-reference" not in tags:
            tags.append("api-reference")

    suggested_corpus_class = "general"
    host_lower = host.lower()
    for pattern, cc in CORPUS_HEURISTICS.items():
        if pattern in host_lower:
            suggested_corpus_class = cc
            recommendation_reasons.append(f"Host matches known coder domain ({pattern})")
            break
    if suggested_corpus_class == "general" and any(t in tags for t in ("api-reference", "documentation", "reference")):
        suggested_corpus_class = "coder_enriched"
        recommendation_reasons.append("Tag signals suggest coder-enriched content")

    required_missing: list[str] = []
    if not title:
        required_missing.append("title")
    if not domain:
        required_missing.append("domain")
    if not tags:
        required_missing.append("tags")

    return {
        "url": raw_url,
        "handler": handler,
        "title": title,
        "domain": domain,
        "tags": tags,
        "config": config,
        "risk_flags": risk_flags,
        "recommended_mode": recommended_mode,
        "notes": "; ".join(notes_parts) if notes_parts else "",
        "deterministic": True,
        "recommendation_reasons": recommendation_reasons,
        "suggested_corpus_class": suggested_corpus_class,
        "required_missing_fields": required_missing,
    }
