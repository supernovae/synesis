"""Opik trace annotation utilities.

Thin wrapper around the Opik Python SDK for attaching Synesis-specific
metadata to LangGraph traces.  All functions are no-ops when Opik is
disabled (opik_enabled=False).
"""

from __future__ import annotations

import logging
from typing import Any

from .config import settings

logger = logging.getLogger("synesis.opik")

_client: Any = None


def _get_client() -> Any:
    """Lazy-init Opik client singleton; returns None when disabled."""
    global _client
    if not settings.opik_enabled:
        return None
    if _client is not None:
        return _client
    try:
        import opik

        _client = opik.Opik(
            workspace="synesis",
        )
        return _client
    except Exception:
        logger.debug("opik_client_init_skipped", exc_info=True)
        return None


def log_request_feedback(
    *,
    run_id: str,
    difficulty: float,
    task_type: str,
    domain_tags: list[str],
    evidence_packet_count: int,
    avg_evidence_confidence: float,
    critic_weighted_score: float,
    critic_blocking_issues: int,
    iteration_count: int,
    is_code_task: bool,
    response_length: int,
    has_error: bool,
) -> None:
    """Attach request-level metadata to the current Opik trace."""
    client = _get_client()
    if client is None:
        return
    try:
        from opik import opik_context

        trace_data = opik_context.get_current_trace_data()
        if trace_data is None:
            return

        trace_data.update(
            metadata={
                "synesis.run_id": run_id,
                "synesis.difficulty": difficulty,
                "synesis.task_type": task_type,
                "synesis.domain_tags": domain_tags,
                "synesis.evidence_packet_count": evidence_packet_count,
                "synesis.avg_evidence_confidence": avg_evidence_confidence,
                "synesis.iteration_count": iteration_count,
                "synesis.is_code_task": is_code_task,
                "synesis.response_length": response_length,
                "synesis.has_error": has_error,
            },
            tags=domain_tags[:5],
        )

        client.log_traces_feedback_scores(
            project_name="synesis",
            traces_scores=[
                {
                    "id": trace_data.id,
                    "name": "critic_weighted_score",
                    "value": critic_weighted_score,
                },
                {
                    "id": trace_data.id,
                    "name": "difficulty",
                    "value": difficulty,
                },
            ],
        )
    except Exception:
        logger.debug("opik_request_feedback_failed", exc_info=True)


def log_critic_scores(
    *,
    weighted_overall: float,
    task_faithfulness: float,
    constraint_compliance: float,
    coverage: float,
    judgment_quality: float,
    failure_modes: list[str],
    approved: bool,
    difficulty: float,
    hallucinated_urls_count: int,
) -> None:
    """Attach critic scoring data as span-level feedback."""
    client = _get_client()
    if client is None:
        return
    try:
        from opik import opik_context

        span_data = opik_context.get_current_span_data()
        if span_data is None:
            return

        span_data.update(
            metadata={
                "synesis.critic.approved": approved,
                "synesis.critic.failure_modes": failure_modes,
                "synesis.critic.hallucinated_urls": hallucinated_urls_count,
                "synesis.critic.difficulty": difficulty,
            },
        )

        client.log_spans_feedback_scores(
            project_name="synesis",
            spans_scores=[
                {"id": span_data.id, "name": "weighted_overall", "value": weighted_overall},
                {"id": span_data.id, "name": "task_faithfulness", "value": task_faithfulness},
                {"id": span_data.id, "name": "constraint_compliance", "value": constraint_compliance},
                {"id": span_data.id, "name": "coverage", "value": coverage},
                {"id": span_data.id, "name": "judgment_quality", "value": judgment_quality},
            ],
        )
    except Exception:
        logger.debug("opik_critic_scores_failed", exc_info=True)
