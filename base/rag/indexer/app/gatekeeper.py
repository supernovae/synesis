"""Document-level semantic gatekeeper (optional OpenAI-compatible LLM).

Runs once per document (hierarchical labeling) when enabled. Produces structured
metadata inherited by all chunks from that document. See docs/plans/semantic_rag_ingestion_v9.md.

No torch/transformers in this module — HTTP only.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger("synesis.indexer.gatekeeper")

_DEFAULT_MODEL = os.getenv("SYNESIS_INDEXER_GATEKEEPER_MODEL", "synesis-general")


@dataclass
class GatekeeperLabels:
    """Labels applied to every chunk from a document."""

    content_type: str = ""
    quality_score: float = -1.0
    technical_depth: float = -1.0
    domain_relevance: float = -1.0
    index_decision: str = "index"
    doc_summary: str = ""
    doc_keywords: list[str] = field(default_factory=list)
    entities: list[dict[str, str]] = field(default_factory=list)
    section_outline: list[str] = field(default_factory=list)
    enrichment_profile: str = "v9_gatekeeper"


def _env_bool(name: str, default: bool = False) -> bool:
    v = (os.getenv(name) or "").strip().lower()
    if v in ("1", "true", "yes", "on"):
        return True
    if v in ("0", "false", "no", "off"):
        return False
    return default


def gatekeeper_enabled() -> bool:
    return _env_bool("SYNESIS_INDEXER_GATEKEEPER_ENABLE", False)


def _skip_authority(authority: str) -> bool:
    raw = (os.getenv("SYNESIS_INDEXER_GATEKEEPER_SKIP_AUTHORITY") or "canonical,vetted").strip().lower()
    skip_set = {a.strip() for a in raw.split(",") if a.strip()}
    return (authority or "").strip().lower() in skip_set


def _clamp01(x: Any) -> float:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return -1.0
    if f < 0:
        return -1.0
    return max(0.0, min(1.0, f))


def _build_excerpt(chunk_texts: list[str], max_chars: int = 12000) -> str:
    parts: list[str] = []
    n = 0
    for t in chunk_texts:
        if n >= max_chars:
            break
        piece = (t or "").strip()
        if not piece:
            continue
        take = piece[: max_chars - n]
        parts.append(take)
        n += len(take)
    return "\n\n---\n\n".join(parts)[:max_chars]


_SYSTEM_PROMPT = """You classify and score web/documentation content for a RAG corpus.
Return ONLY a single JSON object (no markdown) with these keys:
- content_type: string, one of: tutorial, reference, blog, marketing, changelog, code, forum, news, other
- quality_score: number 0..1 (usefulness, accuracy signal from text)
- technical_depth: number 0..1 (0 = shallow/marketing, 1 = deep technical)
- domain_relevance: number 0..1 (how technical/on-topic vs generic noise)
- index_decision: string, one of: index, skip, review
- summary_one_line: string, max 200 chars, neutral description
- keywords: array of up to 12 short strings (no commas inside a keyword)
- entities: array of objects with "name" and "type" (type e.g. product, api, concept, org)
- section_outline: array of up to 8 short strings describing main sections (headings or themes)

Use index_decision "skip" for obvious spam, empty boilerplate, or pages with no durable information.
Use "review" when uncertain."""


def run_document_gatekeeper(
    *,
    document_name: str,
    authority: str,
    domain: str,
    chunk_texts: list[str],
    base_url: str = "",
    model: str = "",
    api_key: str = "",
    timeout: float = 120.0,
) -> GatekeeperLabels | None:
    """Call LLM once per document. Returns None on failure (caller uses defaults)."""
    url = (base_url or os.getenv("SYNESIS_INDEXER_GATEKEEPER_URL") or "").strip().rstrip("/")
    if not url:
        logger.warning("gatekeeper_no_url")
        return None
    model_id = (model or _DEFAULT_MODEL).strip()
    key = (api_key or os.getenv("SYNESIS_INDEXER_GATEKEEPER_API_KEY") or "").strip()
    excerpt = _build_excerpt(chunk_texts)
    if len(excerpt) < 80:
        logger.debug("gatekeeper_excerpt_short", extra={"doc": document_name[:80]})
    user_msg = f"document_name: {document_name}\nauthority: {authority}\ndomain: {domain}\n\nexcerpt:\n{excerpt}"
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    payload: dict[str, Any] = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 0.2,
        "max_tokens": 900,
    }
    try:
        to = float(os.getenv("SYNESIS_INDEXER_GATEKEEPER_TIMEOUT") or str(timeout))
    except ValueError:
        to = timeout
    chat_url = f"{url}/chat/completions"
    try:
        with httpx.Client(timeout=to) as client:
            resp = client.post(chat_url, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logger.warning("gatekeeper_http_error", extra={"error": str(e)[:200], "doc": document_name[:60]})
        return None

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        logger.warning("gatekeeper_bad_response_shape", extra={"doc": document_name[:60]})
        return None

    raw = content.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("gatekeeper_json_parse_failed", extra={"doc": document_name[:60], "preview": raw[:120]})
        return None

    if not isinstance(obj, dict):
        return None

    decision = str(obj.get("index_decision") or "index").lower().strip()
    if decision not in ("index", "skip", "review"):
        decision = "index"

    kw = obj.get("keywords") or []
    keywords: list[str] = []
    if isinstance(kw, list):
        for x in kw[:12]:
            s = str(x).strip()[:64]
            if s:
                keywords.append(s)

    ent_raw = obj.get("entities") or []
    entities: list[dict[str, str]] = []
    if isinstance(ent_raw, list):
        for e in ent_raw[:24]:
            if isinstance(e, dict):
                name = str(e.get("name") or "")[:128]
                typ = str(e.get("type") or "")[:32]
                if name:
                    entities.append({"name": name, "type": typ})

    outline = obj.get("section_outline") or []
    section_outline: list[str] = []
    if isinstance(outline, list):
        for x in outline[:8]:
            s = str(x).strip()[:256]
            if s:
                section_outline.append(s)

    labels = GatekeeperLabels(
        content_type=str(obj.get("content_type") or "")[:64],
        quality_score=_clamp01(obj.get("quality_score")),
        technical_depth=_clamp01(obj.get("technical_depth")),
        domain_relevance=_clamp01(obj.get("domain_relevance")),
        index_decision=decision,
        doc_summary=str(obj.get("summary_one_line") or "")[:200],
        doc_keywords=keywords,
        entities=entities,
        section_outline=section_outline,
        enrichment_profile="v9_gatekeeper",
    )
    logger.info(
        "gatekeeper_ok",
        extra={
            "doc": document_name[:80],
            "index_decision": labels.index_decision,
            "content_type": labels.content_type,
        },
    )
    return labels


def labels_for_document(
    *,
    document_name: str,
    authority: str,
    domain: str,
    chunk_texts: list[str],
) -> GatekeeperLabels:
    """Return gatekeeper labels or sensible defaults."""
    defaults = GatekeeperLabels(
        index_decision="index",
        enrichment_profile="v9_default",
    )
    if not gatekeeper_enabled():
        return defaults
    if _skip_authority(authority):
        return GatekeeperLabels(
            index_decision="index",
            enrichment_profile="v9_skip_authority",
        )
    gk = run_document_gatekeeper(
        document_name=document_name,
        authority=authority,
        domain=domain,
        chunk_texts=chunk_texts,
    )
    return gk if gk is not None else defaults


def entities_to_json(entities: list[dict[str, str]]) -> str:
    try:
        return json.dumps(entities, ensure_ascii=False)[:4090]
    except Exception:
        return "[]"


def section_outline_to_json(outline: list[str]) -> str:
    try:
        return json.dumps(outline, ensure_ascii=False)[:2040]
    except Exception:
        return "[]"
