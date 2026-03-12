"""Opik trace annotation utilities.

Thin wrapper around the Opik Python SDK for attaching Synesis-specific
metadata to LangGraph traces.  All functions are no-ops when Opik is
disabled (opik_enabled=False).
"""

from __future__ import annotations

import functools
import logging
from typing import Any, Callable, TypeVar

from .config import settings

logger = logging.getLogger("synesis.opik")

F = TypeVar("F", bound=Callable[..., Any])

_client: Any = None
_track_fn: Any = None  # cached opik.track reference


def track_node(name: str) -> Callable[[F], F]:
    """Conditional ``@opik.track()`` decorator for LangGraph node functions.

    Returns a no-op passthrough when Opik is disabled so that importing
    this helper never pulls in the ``opik`` package unnecessarily.
    The decorator creates a child span under the current OpikTracer trace,
    giving per-node latency and input/output visibility.
    """
    if not settings.opik_enabled:
        return lambda fn: fn  # type: ignore[return-value]

    global _track_fn
    if _track_fn is None:
        try:
            import opik

            _track_fn = opik.track
        except Exception:
            logger.debug("opik_track_import_failed", exc_info=True)
            _track_fn = False  # sentinel: don't retry

    if _track_fn is False:
        return lambda fn: fn  # type: ignore[return-value]

    return _track_fn(name=name, project_name="synesis")  # type: ignore[return-value]


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
            project_name="synesis",
            workspace="default",
            host=settings.opik_url,
        )
        return _client
    except Exception:
        logger.warning("opik_client_init_failed", exc_info=True)
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
