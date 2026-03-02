"""Strategic Advisor node -- fast LLM classifier for platform/domain detection.

Domain Aligner (alias: strategic_advisor). Runs after Entry Classifier, before Supervisor. Infers platform_context (domain metadata key) from
task_description (openshift, kubernetes, garmin, synthesizer, generic, etc.)
without rigid keyword mapping. Convention-based: sop_{domain} collections
are used automatically when they exist.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..config import settings
from ..llm_telemetry import get_llm_http_client
from ..state import NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.strategic_advisor")

ADVISOR_SYSTEM = """Classify the user's task domain. Reply with exactly one word or short phrase (lowercase, no punctuation).
Examples: openshift, kubernetes, python_web, embedded_garmin, synthesizer_music, generic"""


def _normalize_domain(raw: str) -> str:
    """Extract and normalize domain from LLM response."""
    if not raw or not raw.strip():
        return "generic"
    s = raw.strip().lower()
    # Take first line or first "word" (before comma, period, newline)
    s = s.split("\n")[0].split(",")[0].split(".")[0].strip()
    # Keep alphanumeric and underscore only
    s = re.sub(r"[^a-z0-9_]", "", s)
    return s if s else "generic"


advisor_llm = ChatOpenAI(
    base_url=settings.advisor_model_url,
    api_key="not-needed",
    model=settings.advisor_model_name,
    temperature=0.0,
    max_tokens=15,
    http_client=get_llm_http_client(uds_path=settings.advisor_model_uds or None),
)


async def strategic_advisor_node(state: dict[str, Any]) -> dict[str, Any]:
    """Classify task domain for platform-aware RAG routing. Passthrough for trivial."""
    node_name = "strategic_advisor"
    start = time.monotonic()

    task_desc = (state.get("task_description") or "").strip()[:400]
    task_size = state.get("task_size", "small")
    rag_mode = state.get("rag_mode", "normal")

    # Preserve EntryClassifier-seeded active_domain_refs (Sovereign Intersection)
    existing_domains = state.get("active_domain_refs") or []

    # Trivial or RAG disabled: no-op, use generic. Skip heavy RAG (common knowledge).
    if task_size == "trivial" or rag_mode == "disabled":
        return {
            "platform_context": "generic",
            "rag_gravity": "light",
            "active_domain_refs": existing_domains,
            "advisory_message": "",
            "current_node": node_name,
        }

    # Complex: EntryClassifier already escalated; skip advisor LLM (anemic advisor).
    # Infer platform_context from active_domain_refs for Sovereign Persona injection.
    if task_size == "complex":
        platform_context = "generic"
        if existing_domains:
            _domain_to_platform = {
                "healthcare_compliance": "healthcare",
                "fintech_compliance": "fintech",
                "industrial": "industrial",
                "secops_hardening": "openshift",
                "kubernetes": "kubernetes",
                "llm_rag": "rag",
                "llm_prompting": "prompting",
                "llm_evaluation": "eval",
                "ai_governance": "llm safety",
            }
            for d in existing_domains:
                key = (d or "").strip().lower()
                if key in _domain_to_platform:
                    platform_context = _domain_to_platform[key]
                    break
        return {
            "platform_context": platform_context,
            "rag_gravity": "normal",
            "active_domain_refs": existing_domains,
            "advisory_message": "",
            "current_node": node_name,
        }

    if not getattr(settings, "advisor_enabled", True):
        return {
            "platform_context": "generic",
            "rag_gravity": "light",
            "active_domain_refs": existing_domains,
            "advisory_message": "",
            "current_node": node_name,
        }

    platform_context = "generic"
    try:
        prompt = f"Task: {task_desc[:300]}\nDomain:"
        messages = [
            SystemMessage(content=ADVISOR_SYSTEM),
            HumanMessage(content=prompt),
        ]
        response = await asyncio.wait_for(
            advisor_llm.ainvoke(messages),
            timeout=5.0,
        )
        raw = (response.content or "").strip()
        platform_context = _normalize_domain(raw)
        if platform_context == "generic" and raw:
            logger.debug("strategic_advisor_raw", extra={"raw": raw[:80]})
    except asyncio.TimeoutError:
        logger.warning("strategic_advisor_timeout", extra={"task_preview": task_desc[:60]})
    except Exception as e:
        logger.warning("strategic_advisor_error", extra={"error": str(e)[:100]})

    # Adaptive Rigor: generic/python_web = common knowledge; skip Strategic Pivot / heavy RAG
    rag_gravity = "light" if platform_context in ("generic", "python_web") else "normal"
    latency_ms = (time.monotonic() - start) * 1000
    trace = NodeTrace(
        node_name=node_name,
        reasoning=f"platform_context={platform_context}",
        assumptions=[],
        confidence=0.9 if platform_context != "generic" else 0.5,
        outcome=NodeOutcome.SUCCESS,
        latency_ms=latency_ms,
        tokens_used=0,
    )

    # Keep EntryClassifier deterministic domains; LLM platform_context complements them
    return {
        "platform_context": platform_context,
        "rag_gravity": rag_gravity,
        "active_domain_refs": existing_domains,
        "advisory_message": "",
        "current_node": node_name,
        "node_traces": [trace],
    }
