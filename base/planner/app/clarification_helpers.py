"""Helpers for planner clarification resume (token + UX optimization)."""

from __future__ import annotations


def is_clarification_proceed_waiver(text: str) -> bool:
    """True when the user explicitly waives answering our clarification (keep general / use assumptions).

    Conservative: long replies or hedging words disable the fast path so we still re-plan.
    """
    t = (text or "").strip().lower()
    if not t or len(t) > 200:
        return False
    negatives = (
        "don't ",
        "dont ",
        "do not ",
        "never ",
        "except ",
        "but ",
        "however ",
        "instead ",
        "change ",
        "actually ",
        "should be ",
        "need to ",
        "must ",
    )
    if any(n in t for n in negatives):
        return False
    snippets = (
        "proceed",
        "go ahead",
        "just go",
        "keep it general",
        "general purpose",
        "general-purpose",
        "as you wish",
        "your best judgment",
        "your best judgement",
        "use assumptions",
        "state assumptions",
        "use your assumptions",
        "whatever you recommend",
        "up to you",
    )
    return any(s in t for s in snippets)
