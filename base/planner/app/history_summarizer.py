"""Context pivot: summarize previous era before flushing, archive to L2.

When user pivots languages (Python→JS→shell), we optionally:
1. Summarize the "old era" via a tiny micro model (Qwen 0.5B, CPU)
2. Archive raw history to L2 (durable store)
3. Replace flushed history with a compact summary for smooth UX

Uses summarizer_model_url when configured; otherwise falls back to stub.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .config import settings
from .llm_telemetry import get_llm_http_client

logger = logging.getLogger("synesis.history_summarizer")

_summarizer_llm: Any = "__unset__"


def _get_summarizer_llm():
    """Lazy-init summarizer LLM. Returns None if URL not configured or init failed."""
    global _summarizer_llm
    url = getattr(settings, "summarizer_model_url", "") or ""
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
            max_tokens=150,
            http_client=get_llm_http_client(),
        )
        return _summarizer_llm
    except Exception as e:
        logger.debug("summarizer_llm_init_failed %s", e)
        _summarizer_llm = None
        return None


def _stub_pivot_summary(
    history: list[str],
    last_lang: str,
    current_lang: str,
    interaction_mode: str = "do",
) -> str:
    """Fallback when micro model unavailable."""
    if not history:
        return ""
    turn_count = len(history)
    stub = f"Completed {turn_count} turn(s) in {last_lang}."
    if interaction_mode == "teach":
        stub += (
            f" [Mentor: We're moving from {last_lang} to {current_lang}. "
            "Same intent may use different tools—e.g. Python json vs Shell jq.]"
        )
    return stub


async def summarize_pivot_history(
    history: list[str],
    last_lang: str,
    current_lang: str,
    interaction_mode: str = "do",
) -> str:
    """Summarize the pre-pivot history in 1-2 sentences.

    Uses micro model (Qwen 0.5B, SmolLM, etc.) when summarizer_model_url
    is configured. Falls back to stub on error or when not deployed.
    """
    if not history:
        return ""

    llm = _get_summarizer_llm()
    if llm is None:
        return _stub_pivot_summary(history, last_lang, current_lang, interaction_mode)

    # Truncate to fit micro model context (~1k tokens)
    combined = "\n".join(history[-5:])[:2000]

    prompt = (
        f"Summarize in 1-2 sentences what the user accomplished in {last_lang}.\n\n"
        f"Conversation:\n{combined}\n\n"
        "Reply with only the summary, no preamble."
    )

    try:
        from langchain_core.messages import HumanMessage

        response = await asyncio.wait_for(
            llm.ainvoke([HumanMessage(content=prompt)]),
            timeout=10.0,
        )
        summary = (response.content or "").strip()
        if summary:
            if interaction_mode == "teach":
                summary += (
                    f" [Mentor: We're moving from {last_lang} to {current_lang}. "
                    "Same intent may use different tools—e.g. Python json vs Shell jq.]"
                )
            logger.debug(
                "pivot_summary_from_model",
                extra={"last_lang": last_lang, "current_lang": current_lang},
            )
            return summary
    except asyncio.TimeoutError:
        logger.warning("pivot_summarizer_timeout")
    except Exception as e:
        logger.debug("pivot_summarizer_error %s", e)

    return _stub_pivot_summary(history, last_lang, current_lang, interaction_mode)


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
    except (asyncio.TimeoutError, Exception) as e:
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
