"""Context pivot: summarize previous era before flushing, archive to L2.

When user pivots languages (Python→JS→shell), needs_sandbox (True↔False),
or domain, we optionally:
1. Summarize the "old era" via a tiny micro model (Qwen 0.5B, CPU)
2. Archive raw history to L2 (durable store)
3. Replace flushed history with a compact summary for smooth UX

Uses summarizer_model_url when configured; otherwise falls back to stub.
Taxonomy-aware: pivot summary prompts inlined (formerly approach_dark_debt_config.yaml).
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from .config import settings
from .llm_telemetry import get_llm_http_client

logger = logging.getLogger("synesis.history_summarizer")

_summarizer_llm: Any = "__unset__"


_PIVOT_PROMPTS: dict[str, Any] = {
    "language": {
        "template": (
            "Summarize in 1-2 sentences what the user accomplished in {from_era}.\n"
            "Conversation:\n{conversation}\nReply with only the summary, no preamble."
        ),
    },
    "deliverable": {
        "template": (
            "Summarize in 1-2 sentences what the user discussed or worked on in the "
            "previous {from_era} context.\n{domain_suffix}\nConversation:\n{conversation}\n"
            "Reply with only the summary, no preamble."
        ),
        "domain_suffix_by_vertical": {
            "scientific": "Focus on concepts, data, or methodology discussed.",
            "lifestyle": "Focus on goals, plans, or advice exchanged.",
            "medical": "Focus on concepts or workflows (do not mention PHI).",
            "generic": "",
        },
    },
    "domain": {
        "template": (
            "Summarize what the user worked on in the previous context ({domain_hint}).\n"
            "Conversation:\n{conversation}\nReply with only the summary, no preamble."
        ),
    },
}


def _load_pivot_prompts() -> dict[str, Any]:
    """Return inlined pivot summary prompts."""
    return _PIVOT_PROMPTS


def _get_summarizer_llm():
    """Lazy-init summarizer LLM. Returns None if URL not configured or init failed."""
    global _summarizer_llm
    from .url_utils import ensure_url_protocol

    url = ensure_url_protocol(getattr(settings, "summarizer_model_url", "") or "")
    if not url or not url.strip():
        return None
    if _summarizer_llm != "__unset__":
        return _summarizer_llm if _summarizer_llm is not None else None
    try:
        from langchain_openai import ChatOpenAI

        _summarizer_llm = ChatOpenAI(
            base_url=url.rstrip("/"),
            api_key="not-needed",
            model=getattr(settings, "summarizer_model_name", "synesis-summarizer"),
            temperature=0.1,
            max_completion_tokens=150,
            use_responses_api=False,
            http_client=get_llm_http_client(),
        )
        return _summarizer_llm
    except Exception as e:
        logger.debug("summarizer_llm_init_failed %s", e)
        _summarizer_llm = None
        return None


def _stub_pivot_summary(
    history: list[str],
    from_era: str,
    to_era: str,
    pivot_type: str = "language",
    interaction_mode: str = "do",
) -> str:
    """Fallback when micro model unavailable."""
    if not history:
        return ""
    turn_count = len(history)
    if pivot_type == "language":
        stub = f"Completed {turn_count} turn(s) in {from_era}."
    elif pivot_type == "deliverable":
        stub = f"Completed {turn_count} turn(s) in {from_era} context."
    else:
        stub = f"Completed {turn_count} turn(s) in previous context."
    if interaction_mode == "teach" and pivot_type == "language":
        stub += (
            f" [Mentor: We're moving from {from_era} to {to_era}. "
            "Same intent may use different tools—e.g. Python json vs Shell jq.]"
        )
    return stub


def _build_pivot_prompt(
    pivot_type: str,
    from_era: str,
    combined: str,
    active_domain_refs: list[str] | None,
) -> str:
    """Build prompt from pivot_summary_prompts config or fallback."""
    prompts = _load_pivot_prompts()
    cfg = prompts.get(pivot_type) if pivot_type in prompts else None

    domain_suffix = ""
    if pivot_type == "deliverable" and cfg and isinstance(cfg, dict):
        vert = "generic"
        if active_domain_refs:
            try:
                from .taxonomy_prompt_factory import resolve_active_vertical

                vert = resolve_active_vertical(active_domain_refs, None)
            except Exception:
                pass
        # Use prompt_taxonomy to resolve vertical → suffix key (enables aliasing, e.g. astronomy→scientific)
        try:
            from .prompt_taxonomy import get_summary_domain_suffix_key

            suffix_key = get_summary_domain_suffix_key(vert)
        except Exception:
            suffix_key = vert
        suffixes = cfg.get("domain_suffix_by_vertical") or {}
        domain_suffix = (suffixes.get(suffix_key) or suffixes.get("generic") or "").strip()
        if domain_suffix:
            domain_suffix = domain_suffix + "\n\n"

    template = None
    if cfg and isinstance(cfg, dict):
        template = cfg.get("template", "").strip()

    if template:
        return template.format(
            from_era=from_era,
            conversation=combined,
            domain_suffix=domain_suffix,
            domain_hint=", ".join((active_domain_refs or [])[:3]) or "general",
        ).strip()

    # Fallback when config missing — pivot-type aware (avoid code bias for document)
    if pivot_type == "deliverable":
        base = f"Summarize in 1-2 sentences what the user discussed or worked on in the previous {from_era} context."
    elif pivot_type == "language":
        base = f"Summarize in 1-2 sentences what the user accomplished in {from_era}."
    else:
        base = f"Summarize what the user worked on in the previous context ({from_era})."
    return f"{base}\n\nConversation:\n{combined}\n\nReply with only the summary, no preamble."


async def summarize_pivot_history(
    history: list[str],
    from_era: str,
    to_era: str,
    interaction_mode: str = "do",
    *,
    pivot_type: str = "language",
    active_domain_refs: list[str] | None = None,
) -> str:
    """Summarize the pre-pivot history in 1-2 sentences.

    Taxonomy-aware: uses inlined pivot summary prompts.
    pivot_type: language (Python→JS) | deliverable (needs_sandbox True↔False) | domain
    Uses micro model when summarizer_model_url configured; falls back to stub.
    """
    if not history:
        return ""

    llm = _get_summarizer_llm()
    if llm is None:
        return _stub_pivot_summary(history, from_era, to_era, pivot_type, interaction_mode)

    # Truncate to fit micro model context (~1k tokens)
    combined = "\n".join(history[-5:])[:2000]

    prompt = _build_pivot_prompt(pivot_type, from_era, combined, active_domain_refs)

    try:
        from langchain_core.messages import HumanMessage

        response = await asyncio.wait_for(
            llm.ainvoke([HumanMessage(content=prompt)]),
            timeout=10.0,
        )
        summary = (response.content or "").strip()
        if summary:
            if interaction_mode == "teach" and pivot_type == "language":
                summary += (
                    f" [Mentor: We're moving from {from_era} to {to_era}. "
                    "Same intent may use different tools—e.g. Python json vs Shell jq.]"
                )
            logger.debug(
                "pivot_summary_from_model",
                extra={"from_era": from_era, "to_era": to_era, "pivot_type": pivot_type},
            )
            return summary
    except TimeoutError:
        logger.warning("pivot_summarizer_timeout")
    except Exception as e:
        logger.debug("pivot_summarizer_error %s", e)

    return _stub_pivot_summary(history, from_era, to_era, pivot_type, interaction_mode)


async def summarize_text(text: str, max_tokens: int = 400) -> str:
    """Summarize long text to fit token budget. Used for Tier 3 project manifest.

    Returns summary when model available; otherwise returns truncated text.
    """
    if not text or not text.strip():
        return ""

    llm = _get_summarizer_llm()
    if llm is None:
        # Fallback: hard truncate
        words = text.strip().split()
        target = max(1, (max_tokens * 3) // 4)
        return " ".join(words[:target]) + (" [...truncated]" if len(words) > target else "")

    trunc = text[:4000]  # Fit in micro model context

    prompt = (
        f"Summarize this project configuration or manifest in under {max_tokens} tokens. "
        "Preserve key details: language, dependencies, commands, constraints.\n\n"
        f"{trunc}\n\n"
        "Reply with only the summary."
    )

    try:
        from langchain_core.messages import HumanMessage

        response = await asyncio.wait_for(
            llm.ainvoke([HumanMessage(content=prompt)]),
            timeout=10.0,
        )
        return (response.content or "").strip() or text[:1500]
    except (TimeoutError, Exception) as e:
        logger.debug("summarize_text_error %s", e)
        words = text.strip().split()
        target = max(1, (max_tokens * 3) // 4)
        return " ".join(words[:target]) + (" [...truncated]" if len(words) > target else "")


def archive_to_l2(run_id: str, user_id: str, history: list[str]) -> None:
    """Archive raw conversation history to durable L2 store.

    Stub: No-op. Future: write to Milvus/Redis/Postgres for later retrieval.

    TODO: Implement L2 persistence; wire to conversation_memory._on_evict.
    """
    if not history:
        return
    logger.debug(
        "archive_to_l2_stub",
        extra={"run_id": run_id[:8], "user_id": user_id[:8], "turns": len(history)},
    )
