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


async def get_critic_detailed(days: int = 7) -> dict[str, Any] | None:
    """Query traces table for critic_scores in full_record. Returns None on error."""
    cutoff = time.time() - (days * 86400)
    try:
        async with async_session() as session:
            return await _query_detailed(session, cutoff, days)
    except Exception:
        logger.warning("critic_detailed_query_failed", exc_info=True)
        return None


async def _query_detailed(
    session: AsyncSession, cutoff: float, days: int
) -> dict[str, Any]:
    # Base filter: traces with critic_scores in the time window
    cs = "full_record -> 'critic_scores'"
    approved_expr = f"(({cs} ->> 'approved')::text = 'true')"

    # 1. Main aggregates
    q_main = text(f"""
        SELECT
            COUNT(*)::int AS total_evaluated,
            COUNT(*) FILTER (WHERE {approved_expr})::int AS approved,
            COUNT(*) FILTER (WHERE NOT {approved_expr})::int AS rejected,
            AVG(({cs} ->> 'weighted_overall')::float) AS avg_weighted_overall,
            AVG(({cs} ->> 'task_faithfulness')::float) AS avg_task_faithfulness,
            AVG(({cs} ->> 'constraint_compliance')::float) AS avg_constraint_compliance,
            AVG(({cs} ->> 'coverage')::float) AS avg_coverage,
            AVG(({cs} ->> 'judgment_quality')::float) AS avg_judgment_quality
        FROM traces
        WHERE timestamp >= :cutoff
          AND full_record ? 'critic_scores'
          AND {cs} IS NOT NULL
          AND jsonb_typeof({cs}) = 'object'
    """)
    r_main = (await session.execute(q_main, {"cutoff": cutoff})).one()

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

    # 2. Score distribution buckets
    q_buckets = text(f"""
        WITH scored AS (
            SELECT (({cs} ->> 'weighted_overall')::float) AS score
            FROM traces
            WHERE timestamp >= :cutoff
              AND full_record ? 'critic_scores'
              AND {cs} IS NOT NULL
              AND jsonb_typeof({cs}) = 'object'
              AND ({cs} ->> 'weighted_overall') IS NOT NULL
        )
        SELECT
            COALESCE(SUM(CASE WHEN score >= 0 AND score < 3 THEN 1 ELSE 0 END), 0)::int AS b03,
            COALESCE(SUM(CASE WHEN score >= 3 AND score < 5 THEN 1 ELSE 0 END), 0)::int AS b35,
            COALESCE(SUM(CASE WHEN score >= 5 AND score < 7 THEN 1 ELSE 0 END), 0)::int AS b57,
            COALESCE(SUM(CASE WHEN score >= 7 AND score < 8 THEN 1 ELSE 0 END), 0)::int AS b78,
            COALESCE(SUM(CASE WHEN score >= 8 AND score <= 10 THEN 1 ELSE 0 END), 0)::int AS b810
        FROM scored
    """)
    r_buckets = (await session.execute(q_buckets, {"cutoff": cutoff})).one()

    score_distribution = [
        {"bucket": "0-3", "count": r_buckets.b03 or 0},
        {"bucket": "3-5", "count": r_buckets.b35 or 0},
        {"bucket": "5-7", "count": r_buckets.b57 or 0},
        {"bucket": "7-8", "count": r_buckets.b78 or 0},
        {"bucket": "8-10", "count": r_buckets.b810 or 0},
    ]

    # 3. Top failure modes (unnest array)
    q_modes = text(f"""
        WITH modes AS (
            SELECT trim(both '"' FROM elem::text) AS mode
            FROM traces,
                 jsonb_array_elements_text(
                     COALESCE(({cs} -> 'failure_modes'), '[]'::jsonb)
                 ) AS elem
            WHERE timestamp >= :cutoff
              AND full_record ? 'critic_scores'
              AND {cs} IS NOT NULL
              AND jsonb_typeof({cs}) = 'object'
              AND jsonb_typeof(COALESCE({cs} -> 'failure_modes', '[]'::jsonb)) = 'array'
        )
        SELECT mode, COUNT(*)::int AS cnt
        FROM modes
        WHERE mode != ''
        GROUP BY mode
        ORDER BY cnt DESC
        LIMIT 10
    """)
    rows_modes = (await session.execute(q_modes, {"cutoff": cutoff})).all()
    top_failure_modes = [{"mode": r.mode, "count": r.cnt} for r in rows_modes]

    # 4. Rejection reasons (rejected traces with trace_id, query_snippet, failure_modes, score)
    q_rejections = text(f"""
        SELECT
            trace_id,
            COALESCE(query_snippet, '') AS query_snippet,
            COALESCE(
                (
                    SELECT array_agg(trim(both '"' FROM elem::text))
                    FROM jsonb_array_elements_text(
                        COALESCE(({cs} -> 'failure_modes'), '[]'::jsonb)
                    ) AS elem
                ),
                '{{}}'
            )::text[] AS failure_modes,
            (({cs} ->> 'weighted_overall')::float) AS score
        FROM traces
        WHERE timestamp >= :cutoff
          AND full_record ? 'critic_scores'
          AND {cs} IS NOT NULL
          AND jsonb_typeof({cs}) = 'object'
          AND NOT {approved_expr}
        ORDER BY timestamp DESC
        LIMIT 20
    """)
    rows_rej = (await session.execute(q_rejections, {"cutoff": cutoff})).all()

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
