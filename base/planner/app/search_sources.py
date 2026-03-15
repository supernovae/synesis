"""Search source catalog — loads and validates search_sources.yaml.

Provides typed SearchSource objects to the retrieval pipeline and derives
engine_authority_map entries for backward compatibility.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .config import settings

logger = logging.getLogger("synesis.search_sources")

_DEFAULT_SEARCH_SOURCES_PATH = "/etc/synesis/search_sources.yaml"


@dataclass
class SourceRouting:
    tags: list[str] = field(default_factory=list)
    task_types: list[str] = field(default_factory=list)
    prompt_aliases: list[str] = field(default_factory=list)
    always: bool = False


@dataclass
class SourceTrust:
    authority: str = "external"
    origin_type: str = "external"


@dataclass
class SearchSource:
    id: str
    label: str = ""
    description: str = ""
    enabled: bool = True
    searxng_params: dict[str, str] = field(default_factory=dict)
    trust: SourceTrust = field(default_factory=SourceTrust)
    weight: float = 1.0
    max_results: int = 5
    fetch_pages: bool = True
    routing: SourceRouting = field(default_factory=SourceRouting)

    @property
    def prompt_alias_set(self) -> frozenset[str]:
        return frozenset(a.lower().strip() for a in self.routing.prompt_aliases if a)

    @property
    def tag_set(self) -> frozenset[str]:
        return frozenset(t.lower().strip() for t in self.routing.tags if t)

    @property
    def task_type_set(self) -> frozenset[str]:
        return frozenset(t.lower().strip() for t in self.routing.task_types if t)


def _parse_source(raw: dict[str, Any]) -> SearchSource | None:
    """Parse a single source entry from YAML."""
    src_id = raw.get("id")
    if not src_id:
        logger.warning("search_source_missing_id", extra={"raw_keys": list(raw.keys())})
        return None

    trust_raw = raw.get("trust") or {}
    trust = SourceTrust(
        authority=str(trust_raw.get("authority", "external")),
        origin_type=str(trust_raw.get("origin_type", "external")),
    )

    routing_raw = raw.get("routing") or {}
    routing = SourceRouting(
        tags=list(routing_raw.get("tags") or []),
        task_types=list(routing_raw.get("task_types") or []),
        prompt_aliases=list(routing_raw.get("prompt_aliases") or []),
        always=bool(routing_raw.get("always", False)),
    )

    return SearchSource(
        id=str(src_id),
        label=str(raw.get("label", src_id)),
        description=str(raw.get("description", "")),
        enabled=bool(raw.get("enabled", True)),
        searxng_params=dict(raw.get("searxng_params") or {}),
        trust=trust,
        weight=float(raw.get("weight", 1.0)),
        max_results=int(raw.get("max_results", 5)),
        fetch_pages=bool(raw.get("fetch_pages", True)),
        routing=routing,
    )


def load_search_sources(path: str = "") -> list[SearchSource]:
    """Load search sources from YAML. Returns empty list on error."""
    resolved = path or getattr(settings, "search_sources_path", "") or _DEFAULT_SEARCH_SOURCES_PATH

    p = Path(resolved)
    if not p.exists():
        logger.info("search_sources_file_not_found", extra={"path": resolved})
        return _default_sources()

    try:
        raw = yaml.safe_load(p.read_text()) or {}
        entries = raw.get("sources") or []
        sources = []
        for entry in entries:
            src = _parse_source(entry)
            if src:
                sources.append(src)
        logger.info(
            "search_sources_loaded",
            extra={"path": resolved, "total": len(sources), "enabled": sum(1 for s in sources if s.enabled)},
        )
        return sources or _default_sources()
    except Exception:
        logger.warning("search_sources_load_error", exc_info=True, extra={"path": resolved})
        return _default_sources()


def _default_sources() -> list[SearchSource]:
    """Fallback: safe general web + code search (matches legacy PROFILE_PARAMS)."""
    return [
        SearchSource(
            id="web_general",
            label="Web Search",
            enabled=True,
            searxng_params={"categories": "general"},
            trust=SourceTrust(authority="external", origin_type="external"),
            weight=1.0,
            max_results=5,
            fetch_pages=True,
            routing=SourceRouting(prompt_aliases=["web", "internet", "search"], always=True),
        ),
        SearchSource(
            id="code_general",
            label="Code Search",
            enabled=True,
            searxng_params={"engines": "github,stackoverflow"},
            trust=SourceTrust(authority="community", origin_type="external"),
            weight=1.1,
            max_results=5,
            fetch_pages=False,
            routing=SourceRouting(
                tags=["software-engineering", "programming", "devops"],
                task_types=["code", "debug", "architecture"],
                prompt_aliases=["code", "github", "stackoverflow"],
            ),
        ),
    ]


def derive_engine_authority_map(sources: list[SearchSource]) -> dict[str, dict[str, str]]:
    """Build an engine_authority_map from search sources for backward compatibility.

    Maps SearXNG engine names to {authority, origin_type} entries. Only sources
    with non-external trust are included (external is already the default).
    """
    result: dict[str, dict[str, str]] = {}
    for src in sources:
        if src.trust.authority == "external" and src.trust.origin_type == "external":
            continue
        engines_str = src.searxng_params.get("engines", "")
        if engines_str:
            for engine in engines_str.split(","):
                engine = engine.strip()
                if engine and engine not in result:
                    result[engine] = {
                        "authority": src.trust.authority,
                        "origin_type": src.trust.origin_type,
                    }
    return result


def select_sources(
    all_sources: list[SearchSource],
    *,
    domain_tags: list[str] | None = None,
    task_type: str = "",
    prompt_source_hints: list[str] | None = None,
) -> list[SearchSource]:
    """Select which sources to query based on routing rules.

    Selection logic:
    1. Sources with routing.always=True are always included (if enabled).
    2. Sources matching domain_tags or task_type are included (if enabled).
    3. Sources matching prompt_source_hints are included even if disabled,
       since the user explicitly requested them.
    """
    selected: dict[str, SearchSource] = {}
    hint_set = frozenset(h.lower().strip() for h in (prompt_source_hints or []) if h)
    tag_set = frozenset(t.lower().strip() for t in (domain_tags or []) if t)
    task = task_type.lower().strip()

    for src in all_sources:
        # Explicit prompt request overrides enabled/disabled
        if hint_set and hint_set & src.prompt_alias_set:
            selected[src.id] = src
            continue

        if not src.enabled:
            continue

        if src.routing.always:
            selected[src.id] = src
            continue

        if tag_set and tag_set & src.tag_set:
            selected[src.id] = src
            continue

        if task and task in src.task_type_set:
            selected[src.id] = src
            continue

    return list(selected.values())


# ---------------------------------------------------------------------------
# Module-level singleton (loaded once at import / startup)
# ---------------------------------------------------------------------------

_cached_sources: list[SearchSource] | None = None


def get_search_sources() -> list[SearchSource]:
    """Return cached search sources, loading on first call."""
    global _cached_sources
    if _cached_sources is None:
        _cached_sources = load_search_sources()
    return _cached_sources


def reload_search_sources() -> list[SearchSource]:
    """Force reload from disk (e.g. after config change)."""
    global _cached_sources
    _cached_sources = load_search_sources()
    return _cached_sources


# ---------------------------------------------------------------------------
# Prompt-level source hint extraction
# ---------------------------------------------------------------------------

import re as _re

_TRIGGER_RE = _re.compile(
    r"(?:include|search|use|query|check|add)\s+([\w\s+,]+?)(?:\s+(?:for|in|as|to|and|$)|\.|,|$)",
    _re.IGNORECASE,
)


def extract_prompt_source_hints(
    prompt: str,
    all_sources: list[SearchSource] | None = None,
) -> list[str]:
    """Extract explicit source inclusion hints from the user prompt.

    Recognizes patterns like "include github", "search jira", "use helpdesk",
    "include github+jira", and matches them against known prompt_aliases from
    the search sources catalog.
    """
    if not prompt or not all_sources:
        return []

    prompt_lower = prompt.lower()

    known_aliases: set[str] = set()
    for src in all_sources:
        for alias in src.routing.prompt_aliases:
            known_aliases.add(alias.lower().strip())

    if not known_aliases:
        return []

    found: list[str] = []
    for m in _TRIGGER_RE.finditer(prompt_lower):
        tokens = _re.split(r"[+,\s]+", m.group(1).strip())
        for tok in tokens:
            tok = tok.strip()
            if tok and tok in known_aliases:
                found.append(tok)

    for alias in known_aliases:
        if " " in alias and alias in prompt_lower and alias not in found:
            found.append(alias)

    return list(dict.fromkeys(found))
