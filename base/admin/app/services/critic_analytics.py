"""Critic analytics from Postgres traces full_record JSONB."""

from __future__ import annotations

import logging
import time
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.engine import async_session

logger = logging.getLogger("synesis.admin.critic_analytics")

SCORE_KEYS = [
    "weighted_overall",
    "task_faithfulness",
    "constraint_compliance",
    "coverage",
    "judgment_quality",
]

# Static JSONB path fragments — NOT user input.  Semgrep flags text() with
# f-strings as potential SQL injection, but these are compile-time constants.
_CS = "full_record -> 'critic_scores'"
_BG = "full_record -> 'background_critic' -> 'scores'"
_MC = "full_record -> 'manual_critic' -> 'scores'"
_APPROVED = f"(({_CS} ->> 'approved')::text = 'true')"
_BG_APPROVED = "(full_record -> 'background_critic' ->> 'approved')::text = 'true'"
_MC_APPROVED = "(full_record -> 'manual_critic' ->> 'approved')::text = 'true'"

# Unified view: manual > background > inline critic.  Exclude trivial traces (< 100 tokens).
_HAS_CRITIC = f"""(
    (
        (full_record ? 'manual_critic' AND {_MC} IS NOT NULL AND jsonb_typeof({_MC}) = 'object')
        OR (full_record ? 'background_critic' AND {_BG} IS NOT NULL AND jsonb_typeof({_BG}) = 'object')
        OR (full_record ? 'critic_scores' AND {_CS} IS NOT NULL AND jsonb_typeof({_CS}) = 'object')
    )
    AND total_tokens >= 100
)"""

_SCORE_EXPR = f"COALESCE(({_MC} ->> 'weighted_overall')::float, ({_BG} ->> 'weighted_overall')::float, ({_CS} ->> 'weighted_overall')::float)"
_APPROVED_EXPR = f"""(
    CASE WHEN full_record ? 'manual_critic' AND {_MC} IS NOT NULL
         THEN ({_MC_APPROVED})
         WHEN full_record ? 'background_critic' AND {_BG} IS NOT NULL
         THEN ({_BG_APPROVED})
         ELSE {_APPROVED}
    END
)"""


def _score_col(key: str) -> str:
    return f"COALESCE(({_MC} ->> '{key}')::float, ({_BG} ->> '{key}')::float, ({_CS} ->> '{key}')::float)"


# All queries are pre-built at module load with fixed JSONB path expressions.
# Bind parameters (:cutoff) handle the only runtime input.
_Q_MAIN = text(  # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    f"""
    SELECT
        COUNT(*)::int AS total_evaluated,
        COUNT(*) FILTER (WHERE {_APPROVED_EXPR})::int AS approved,
        COUNT(*) FILTER (WHERE NOT {_APPROVED_EXPR})::int AS rejected,
        AVG({_score_col("weighted_overall")}) AS avg_weighted_overall,
        AVG({_score_col("task_faithfulness")}) AS avg_task_faithfulness,
        AVG({_score_col("constraint_compliance")}) AS avg_constraint_compliance,
        AVG({_score_col("coverage")}) AS avg_coverage,
        AVG({_score_col("judgment_quality")}) AS avg_judgment_quality
    FROM traces
    WHERE timestamp >= :cutoff
      AND {_HAS_CRITIC}
    """
)

_Q_BUCKETS = text(  # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    f"""
    WITH scored AS (
        SELECT {_SCORE_EXPR} AS score
        FROM traces
        WHERE timestamp >= :cutoff
          AND {_HAS_CRITIC}
          AND {_SCORE_EXPR} IS NOT NULL
    )
    SELECT
        COALESCE(SUM(CASE WHEN score >= 0 AND score < 3 THEN 1 ELSE 0 END), 0)::int AS b03,
        COALESCE(SUM(CASE WHEN score >= 3 AND score < 5 THEN 1 ELSE 0 END), 0)::int AS b35,
        COALESCE(SUM(CASE WHEN score >= 5 AND score < 7 THEN 1 ELSE 0 END), 0)::int AS b57,
        COALESCE(SUM(CASE WHEN score >= 7 AND score < 8 THEN 1 ELSE 0 END), 0)::int AS b78,
        COALESCE(SUM(CASE WHEN score >= 8 AND score <= 10 THEN 1 ELSE 0 END), 0)::int AS b810
    FROM scored
    """
)

_FAILURE_MODES_EXPR = f"""COALESCE(
    full_record -> 'manual_critic' -> 'failure_modes',
    full_record -> 'background_critic' -> 'failure_modes',
    {_CS} -> 'failure_modes',
    '[]'::jsonb
)"""

_Q_MODES = text(  # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    f"""
    WITH modes AS (
        SELECT trim(both '"' FROM elem::text) AS mode
        FROM traces,
             jsonb_array_elements_text({_FAILURE_MODES_EXPR}) AS elem
        WHERE timestamp >= :cutoff
          AND {_HAS_CRITIC}
          AND jsonb_typeof({_FAILURE_MODES_EXPR}) = 'array'
    )
    SELECT mode, COUNT(*)::int AS cnt
    FROM modes
    WHERE mode != ''
    GROUP BY mode
    ORDER BY cnt DESC
    LIMIT 10
    """
)

_Q_REJECTIONS = text(  # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    f"""
    SELECT
        trace_id,
        COALESCE(query_snippet, '') AS query_snippet,
        COALESCE(
            (
                SELECT array_agg(trim(both '"' FROM elem::text))
                FROM jsonb_array_elements_text({_FAILURE_MODES_EXPR}) AS elem
            ),
            '{{}}'
        )::text[] AS failure_modes,
        {_SCORE_EXPR} AS score
    FROM traces
    WHERE timestamp >= :cutoff
      AND {_HAS_CRITIC}
      AND NOT {_APPROVED_EXPR}
    ORDER BY timestamp DESC
    LIMIT 20
    """
)


_Q_EVALUATIONS = text(  # nosemgrep
    f"""
    SELECT
        trace_id,
        timestamp,
        COALESCE(query_snippet, '') AS query_snippet,
        {_SCORE_EXPR} AS weighted_overall,
        {_APPROVED_EXPR} AS approved,
        COALESCE(
            (
                SELECT array_agg(trim(both '"' FROM elem::text))
                FROM jsonb_array_elements_text({_FAILURE_MODES_EXPR}) AS elem
            ),
            '{{}}'
        )::text[] AS failure_modes,
        COALESCE(
            full_record -> 'manual_critic' ->> 'repair_instructions',
            full_record -> 'background_critic' ->> 'repair_instructions',
            full_record -> 'critic_scores' ->> 'repair_instructions',
            ''
        ) AS repair_instructions
    FROM traces
    WHERE timestamp >= :cutoff
      AND {_HAS_CRITIC}
    ORDER BY timestamp DESC
    LIMIT :lim OFFSET :off
    """
)

_Q_EVAL_COUNT = text(  # nosemgrep
    f"""
    SELECT COUNT(*)::int AS cnt
    FROM traces
    WHERE timestamp >= :cutoff
      AND {_HAS_CRITIC}
    """
)


async def get_critic_evaluations(days: int = 7, limit: int = 50, offset: int = 0) -> dict[str, Any] | None:
    """Return paginated list of individual critic evaluations."""
    cutoff = time.time() - (days * 86400)
    try:
        async with async_session() as session:
            cnt_row = (await session.execute(_Q_EVAL_COUNT, {"cutoff": cutoff})).one()
            total = cnt_row.cnt or 0

            rows = (await session.execute(_Q_EVALUATIONS, {"cutoff": cutoff, "lim": limit, "off": offset})).all()

            items = []
            for r in rows:
                modes = []
                if r.failure_modes is not None:
                    if isinstance(r.failure_modes, str):
                        raw = r.failure_modes.strip("{}")
                        modes = [m.strip().strip('"') for m in raw.split(",")] if raw else []
                    else:
                        modes = list(r.failure_modes)
                items.append(
                    {
                        "trace_id": r.trace_id,
                        "timestamp": r.timestamp,
                        "query_snippet": (r.query_snippet or "")[:200],
                        "weighted_overall": round(float(r.weighted_overall or 0), 2),
                        "approved": bool(r.approved),
                        "failure_modes": [m for m in modes if m],
                        "repair_instructions": (r.repair_instructions or "")[:500],
                    }
                )
            return {"evaluations": items, "total": total, "limit": limit, "offset": offset}
    except Exception:
        logger.warning("critic_evaluations_query_failed", exc_info=True)
        return None


async def get_critic_detailed(days: int = 7) -> dict[str, Any] | None:
    """Query traces table for critic_scores in full_record. Returns None on error."""
    cutoff = time.time() - (days * 86400)
    try:
        async with async_session() as session:
            return await _query_detailed(session, cutoff, days)
    except Exception:
        logger.warning("critic_detailed_query_failed", exc_info=True)
        return None


async def _query_detailed(session: AsyncSession, cutoff: float, days: int) -> dict[str, Any]:
    params = {"cutoff": cutoff}

    r_main = (await session.execute(_Q_MAIN, params)).one()

    total = r_main.total_evaluated or 0
    approved = r_main.approved or 0
    rejected = r_main.rejected or 0

    avg_scores: dict[str, float] = {}
    for k in SCORE_KEYS:
        attr = f"avg_{k}"
        val = getattr(r_main, attr, None)
        avg_scores[k] = round(float(val or 0), 2)

    if total == 0:
        return {
            "period_days": days,
            "total_evaluated": 0,
            "approved": 0,
            "rejected": 0,
            "approval_rate": 0.0,
            "avg_scores": avg_scores,
            "score_distribution": [
                {"bucket": "0-3", "count": 0},
                {"bucket": "3-5", "count": 0},
                {"bucket": "5-7", "count": 0},
                {"bucket": "7-8", "count": 0},
                {"bucket": "8-10", "count": 0},
            ],
            "top_failure_modes": [],
            "rejection_reasons": [],
        }

    r_buckets = (await session.execute(_Q_BUCKETS, params)).one()
    score_distribution = [
        {"bucket": "0-3", "count": r_buckets.b03 or 0},
        {"bucket": "3-5", "count": r_buckets.b35 or 0},
        {"bucket": "5-7", "count": r_buckets.b57 or 0},
        {"bucket": "7-8", "count": r_buckets.b78 or 0},
        {"bucket": "8-10", "count": r_buckets.b810 or 0},
    ]

    rows_modes = (await session.execute(_Q_MODES, params)).all()
    top_failure_modes = [{"mode": r.mode, "count": r.cnt} for r in rows_modes]

    rows_rej = (await session.execute(_Q_REJECTIONS, params)).all()
    rejection_reasons = []
    for r in rows_rej:
        if r.failure_modes is None:
            modes = []
        elif isinstance(r.failure_modes, str):
            raw = r.failure_modes.strip("{}")
            modes = [m.strip().strip('"') for m in raw.split(",")] if raw else []
        else:
            modes = list(r.failure_modes)
        rejection_reasons.append(
            {
                "trace_id": r.trace_id,
                "query_snippet": (r.query_snippet or "")[:200],
                "failure_modes": modes,
                "score": round(float(r.score or 0), 2),
            }
        )

    return {
        "period_days": days,
        "total_evaluated": total,
        "approved": approved,
        "rejected": rejected,
        "approval_rate": round(approved / total, 4) if total > 0 else 0.0,
        "avg_scores": avg_scores,
        "score_distribution": score_distribution,
        "top_failure_modes": top_failure_modes,
        "rejection_reasons": rejection_reasons,
    }
