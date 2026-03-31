"""Conformance tracking: scrape Yarn telemetry and aggregate trace metrics into durable rollups."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import desc, select

from ..db.engine import async_session
from ..db.models import ConformanceRollup
from ..deps import INTERNAL_SERVICE_TOKEN

logger = logging.getLogger("synesis.admin.conformance_tracker")

_YARN_URL_ENV = "SYNESIS_YARN_URL"


def _yarn_url() -> str:
    import os

    return os.getenv(
        _YARN_URL_ENV,
        "http://synesis-yarn.synesis-yarn.svc.cluster.local:8000",
    )


async def scrape_yarn_telemetry() -> dict[str, Any]:
    """Scrape Yarn /health/telemetry and store conformance rollups.

    Returns summary of what was stored.
    """
    url = f"{_yarn_url().rstrip('/')}/health/telemetry"
    headers: dict[str, str] = {}
    if INTERNAL_SERVICE_TOKEN:
        headers["Authorization"] = f"Bearer {INTERNAL_SERVICE_TOKEN}"

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        logger.warning("conformance_scrape_failed: %s", str(exc)[:200])
        return {"status": "error", "error": str(exc)[:200]}

    now = datetime.now(UTC)
    rollups_created = 0

    lang_packs = data.get("languagePacks", [])
    recall = data.get("recall", {})
    verification = data.get("verification", {})
    orchestrator = data.get("phaseOrchestrator", {})
    sensemaking = data.get("sensemaking", {})

    global_metrics = {
        "recall_bypass_attempts": recall.get("bypassAttempts", 0),
        "recall_bypass_successes": recall.get("bypassSuccesses", 0),
        "recall_enrich_attempts": recall.get("enrichAttempts", 0),
        "recall_enrich_successes": recall.get("enrichSuccesses", 0),
        "recall_passthrough_count": recall.get("passthroughCount", 0),
        "recall_tokens_saved": recall.get("tokensSavedEstimate", 0),
        "recall_recipe_hits": recall.get("recipeHitCount", 0),
        "verification_loops_started": verification.get("loopsStarted", 0),
        "verification_loops_completed": verification.get("loopsCompleted", 0),
        "verification_findings_detected": verification.get("findingsDetected", 0),
        "verification_findings_resolved": verification.get("findingsResolved", 0),
        "verification_stalls": verification.get("stalls", 0),
        "verification_self_repairs": verification.get("selfRepairSuggestions", 0),
        "decision_count": orchestrator.get("decisions", 0),
        "decision_deterministic": orchestrator.get("deterministicCount", 0),
        "decision_constrained": orchestrator.get("constrainedCount", 0),
        "decision_inference": orchestrator.get("inferenceFirstCount", 0),
        "decision_abstain": orchestrator.get("abstainCount", 0),
        "escalations": orchestrator.get("escalationCount", 0),
        "deescalations": orchestrator.get("deescalationCount", 0),
        "sensemaking_triggered": sensemaking.get("triggeredCount", 0),
        "sensemaking_skipped": sensemaking.get("skippedCount", 0),
    }

    async with async_session() as session:
        global_rollup = ConformanceRollup(
            rollup_id=f"scrape-global-{uuid.uuid4().hex[:12]}",
            timestamp=now,
            source="yarn_telemetry",
            language="_global",
            metrics=global_metrics,
        )
        session.add(global_rollup)
        rollups_created += 1

        for pack in lang_packs:
            lang = pack.get("language", "unknown")
            by_lang_recall = recall.get("byLanguage", {}).get(lang, {})
            by_lang_verification = verification.get("byLanguage", {}).get(lang, {})

            lang_metrics = {
                "conformance_family_count": pack.get("familyCount", 0),
                "conformance_classifier_count": pack.get("classifierCount", 0),
                "conformance_reducer_count": pack.get("reducerCount", 0),
                "conformance_classifier_coverage": pack.get("classifierCoverage", 0),
                "conformance_reducer_coverage": pack.get("reducerCoverage", 0),
                "conformance_fast_path_count": pack.get("fastPathPatternCount", 0),
                "conformance_verification_cmd_count": pack.get("verificationCommandCount", 0),
                "conformance_fix_recipe_count": pack.get("fixRecipeCount", 0),
                "recall_bypass_attempts": by_lang_recall.get("bypassAttempts", 0),
                "recall_bypass_successes": by_lang_recall.get("bypassSuccesses", 0),
                "recall_enrich_attempts": by_lang_recall.get("enrichAttempts", 0),
                "verification_loops": by_lang_verification.get("loopsStarted", 0),
                "verification_findings": by_lang_verification.get("findingsDetected", 0),
                "verification_stalls": by_lang_verification.get("stalls", 0),
            }
            rollup = ConformanceRollup(
                rollup_id=f"scrape-{lang}-{uuid.uuid4().hex[:12]}",
                timestamp=now,
                source="yarn_telemetry",
                language=lang,
                metrics=lang_metrics,
            )
            session.add(rollup)
            rollups_created += 1

        await session.commit()

    logger.info("conformance_scrape_complete rollups=%d", rollups_created)
    return {"status": "ok", "rollups_created": rollups_created, "timestamp": now.isoformat()}


async def get_conformance_summary() -> dict[str, Any]:
    """Latest rollup per language with delta vs previous."""
    async with async_session() as session:
        latest_q = (
            select(ConformanceRollup)
            .where(ConformanceRollup.source == "yarn_telemetry")
            .order_by(desc(ConformanceRollup.timestamp))
            .limit(100)
        )
        rows = (await session.execute(latest_q)).scalars().all()

    by_lang: dict[str, list[ConformanceRollup]] = {}
    for r in rows:
        by_lang.setdefault(r.language, []).append(r)

    summary: list[dict[str, Any]] = []
    for lang, rollups in by_lang.items():
        latest = rollups[0]
        entry: dict[str, Any] = {
            "language": lang,
            "timestamp": latest.timestamp.isoformat() if latest.timestamp else None,
            "metrics": latest.metrics,
        }
        if len(rollups) >= 2:
            prev = rollups[1]
            delta: dict[str, Any] = {}
            for key in latest.metrics:
                cur = latest.metrics.get(key, 0)
                old = prev.metrics.get(key, 0)
                if isinstance(cur, (int, float)) and isinstance(old, (int, float)):
                    delta[key] = round(cur - old, 4)
            entry["delta_vs_previous"] = delta
        summary.append(entry)

    return {"summary": summary, "languages": list(by_lang.keys())}


async def get_conformance_history(
    *,
    language: str = "_global",
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Time-series rollups for a specific language pack."""
    async with async_session() as session:
        q = (
            select(ConformanceRollup)
            .where(
                ConformanceRollup.language == language,
                ConformanceRollup.source == "yarn_telemetry",
            )
            .order_by(desc(ConformanceRollup.timestamp))
            .limit(limit)
        )
        rows = (await session.execute(q)).scalars().all()

    return [
        {
            "rollup_id": r.rollup_id,
            "timestamp": r.timestamp.isoformat() if r.timestamp else None,
            "language": r.language,
            "metrics": r.metrics,
        }
        for r in rows
    ]
