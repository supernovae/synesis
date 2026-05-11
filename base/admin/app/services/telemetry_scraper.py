"""Non-blocking telemetry scraper for planner-ts and yarn-ts /metrics and /health endpoints.

Called from the background maintenance loop in main.py every 5 minutes.
Persists prefix cache and compaction snapshots to the database.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime

from ..db.engine import async_session
from ..db.models import CompactionSnapshot, PrefixCacheSnapshot, YarnReducerTelemetrySnapshot
from ..deps import INTERNAL_SERVICE_TOKEN, PLANNER_TS_URL, YARN_TS_URL, get_http_client

logger = logging.getLogger("synesis.admin.telemetry_scraper")

_TIMEOUT = 3.0

_last_planner: dict[str, float] = {}
_last_yarn: dict[str, float] = {}
_last_yarn_reducer_success_at: datetime | None = None
_last_yarn_reducer_error_at: datetime | None = None
_last_yarn_reducer_error: str | None = None


def _parse_prom_line(line: str) -> tuple[str, float] | None:
    """Parse a single Prometheus metric line into (name_with_labels, value)."""
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    match = re.match(r"^([a-zA-Z_:][a-zA-Z0-9_:{},=\"]*)\s+([0-9eE.+\-]+|NaN|Inf|-Inf)$", line)
    if not match:
        return None
    try:
        return (match.group(1), float(match.group(2)))
    except ValueError:
        return None


def _extract_counter(parsed: dict[str, float], name: str) -> float:
    total = 0.0
    for key, val in parsed.items():
        if key == name or key.startswith(f"{name}{{"):
            total += val
    return total


def _extract_labeled(parsed: dict[str, float], name: str, label: str, value: str) -> float:
    pattern = f'{name}{{{label}="{value}"'
    total = 0.0
    for key, val in parsed.items():
        if pattern in key:
            total += val
    return total


async def _scrape_metrics(url: str) -> dict[str, float]:
    """Scrape a Prometheus /metrics endpoint and parse lines."""
    try:
        client = get_http_client()
        resp = await client.get(f"{url.rstrip('/')}/metrics", timeout=_TIMEOUT)
        if resp.status_code != 200:
            return {}
        parsed: dict[str, float] = {}
        for line in resp.text.splitlines():
            result = _parse_prom_line(line)
            if result:
                parsed[result[0]] = result[1]
        return parsed
    except Exception:
        logger.debug("scrape_metrics_failed url=%s", url, exc_info=True)
        return {}


async def _scrape_json(url: str, path: str) -> dict:
    """Scrape a JSON health endpoint (yarn /health/telemetry requires internal Bearer)."""
    headers: dict[str, str] = {}
    if INTERNAL_SERVICE_TOKEN and path != "/health":
        headers["Authorization"] = f"Bearer {INTERNAL_SERVICE_TOKEN}"
    try:
        client = get_http_client()
        resp = await client.get(f"{url.rstrip('/')}{path}", timeout=_TIMEOUT, headers=headers)
        if resp.status_code != 200:
            return {}
        return resp.json()
    except Exception:
        logger.debug("scrape_json_failed url=%s%s", url, path, exc_info=True)
        return {}


def _compute_delta(current: dict[str, float], last: dict[str, float]) -> dict[str, float]:
    """Compute the delta between two counter snapshots."""
    deltas: dict[str, float] = {}
    for key, val in current.items():
        prev = last.get(key, 0.0)
        deltas[key] = max(0.0, val - prev)
    return deltas


async def _persist_prefix_snapshot(
    service: str,
    prompt_tokens: int,
    cached_tokens: int,
    requests: int,
    mode: str,
    savings: float,
) -> None:
    hit_rate = cached_tokens / prompt_tokens if prompt_tokens > 0 else 0.0
    async with async_session() as session:
        session.add(
            PrefixCacheSnapshot(
                service=service,
                captured_at=datetime.now(UTC),
                prompt_tokens=prompt_tokens,
                cached_prompt_tokens=cached_tokens,
                hit_rate=round(hit_rate, 4),
                cache_mode=mode,
                requests=requests,
                estimated_savings_usd=round(savings, 6),
            )
        )
        await session.commit()


async def _persist_yarn_reducer_telemetry(trr: dict) -> None:
    """Persist full toolResultReduction blob for historical pass/fail rollups."""
    async with async_session() as session:
        session.add(
            YarnReducerTelemetrySnapshot(
                captured_at=datetime.now(UTC),
                payload=dict(trr),
            )
        )
        await session.commit()


def get_yarn_reducer_scrape_status(now: datetime | None = None, stale_after_minutes: int = 20) -> dict:
    """Expose reducer scrape health to help distinguish no-data vs scrape failure."""
    ref = now if now is not None else datetime.now(UTC)
    stale = True
    if _last_yarn_reducer_success_at is not None:
        stale = (ref - _last_yarn_reducer_success_at).total_seconds() > max(60, stale_after_minutes * 60)
    return {
        "last_success_at": _last_yarn_reducer_success_at.isoformat() if _last_yarn_reducer_success_at else None,
        "last_error_at": _last_yarn_reducer_error_at.isoformat() if _last_yarn_reducer_error_at else None,
        "has_recent_error": bool(_last_yarn_reducer_error),
        "stale": stale,
    }


async def _persist_compaction_snapshot(
    service: str,
    count: int,
    chars_saved: int,
    errors: int,
    detail: dict | None = None,
) -> None:
    async with async_session() as session:
        session.add(
            CompactionSnapshot(
                service=service,
                captured_at=datetime.now(UTC),
                compaction_count=count,
                chars_before=0,
                chars_after=0,
                tokens_saved_estimate=chars_saved // 4 if chars_saved > 0 else 0,
                errors=errors,
                detail=detail,
            )
        )
        await session.commit()


async def scrape_all() -> dict:
    """Run a full scrape cycle for both planner-ts and yarn-ts."""
    global \
        _last_planner, \
        _last_yarn, \
        _last_yarn_reducer_success_at, \
        _last_yarn_reducer_error_at, \
        _last_yarn_reducer_error

    planner_metrics, yarn_metrics, planner_health, yarn_health = await asyncio.gather(
        _scrape_metrics(PLANNER_TS_URL),
        _scrape_metrics(YARN_TS_URL),
        _scrape_json(PLANNER_TS_URL, "/health"),
        _scrape_json(YARN_TS_URL, "/health/telemetry"),
        return_exceptions=True,
    )

    if isinstance(planner_metrics, BaseException):
        planner_metrics = {}
    if isinstance(yarn_metrics, BaseException):
        yarn_metrics = {}
    if isinstance(planner_health, BaseException):
        planner_health = {}
    if isinstance(yarn_health, BaseException):
        yarn_health = {}

    results = {"planner": {}, "yarn": {}, "errors": []}

    try:
        if isinstance(yarn_health, dict):
            trr = yarn_health.get("toolResultReduction")
            if isinstance(trr, dict) and trr:
                await _persist_yarn_reducer_telemetry(trr)
                results["yarn"]["reducer_snapshot"] = True
                _last_yarn_reducer_success_at = datetime.now(UTC)
                _last_yarn_reducer_error_at = None
                _last_yarn_reducer_error = None
            else:
                results["yarn"]["reducer_snapshot"] = False
    except Exception as exc:
        results["errors"].append(f"yarn_reducer_telemetry: {exc}")
        _last_yarn_reducer_error_at = datetime.now(UTC)
        _last_yarn_reducer_error = str(exc)[:200]
        logger.warning("persist_yarn_reducer_telemetry_failed", exc_info=True)

    try:
        if planner_metrics:
            delta_p = _compute_delta(planner_metrics, _last_planner)
            _last_planner = dict(planner_metrics)

            p_prompt = int(_extract_counter(delta_p, "synesis_planner_token_total"))
            p_cached = int(_extract_labeled(delta_p, "synesis_planner_token_total", "cache_status", "cached"))
            p_requests = int(_extract_counter(delta_p, "synesis_planner_request_total"))
            p_savings = _extract_counter(delta_p, "synesis_planner_cost_estimated_usd_total")

            mode = (
                planner_health.get("llm", {}).get("prefixCacheMode", "auto")
                if isinstance(planner_health, dict)
                else "auto"
            )

            if p_prompt > 0 or p_requests > 0:
                await _persist_prefix_snapshot("planner", p_prompt, p_cached, p_requests, mode, p_savings)

            p_compaction = int(_extract_counter(delta_p, "synesis_planner_compaction_total"))
            p_comp_chars = int(_extract_counter(delta_p, "synesis_planner_compaction_chars_saved_total"))
            if p_compaction > 0:
                await _persist_compaction_snapshot("planner", p_compaction, p_comp_chars, 0)

            results["planner"] = {
                "prompt_tokens": p_prompt,
                "cached_tokens": p_cached,
                "requests": p_requests,
                "compaction_count": p_compaction,
            }
    except Exception as exc:
        results["errors"].append(f"planner: {exc}")
        logger.warning("scrape_planner_failed", exc_info=True)

    try:
        if yarn_metrics:
            delta_y = _compute_delta(yarn_metrics, _last_yarn)
            _last_yarn = dict(yarn_metrics)

            y_prompt = int(_extract_counter(delta_y, "synesis_yarn_token_total"))
            y_cached = int(_extract_labeled(delta_y, "synesis_yarn_token_total", "cache_status", "cached"))
            y_requests = int(_extract_counter(delta_y, "synesis_yarn_request_total"))
            y_savings = _extract_counter(delta_y, "synesis_yarn_cost_estimated_usd_total")

            if y_prompt > 0 or y_requests > 0:
                await _persist_prefix_snapshot("yarn", y_prompt, y_cached, y_requests, "auto", y_savings)

            y_compaction = int(_extract_counter(delta_y, "synesis_yarn_compaction_total"))
            y_comp_chars = int(_extract_counter(delta_y, "synesis_yarn_compaction_chars_saved_total"))
            if y_compaction > 0:
                detail = None
                if isinstance(yarn_health, dict):
                    detail = {
                        "sawtooth": yarn_health.get("sawtoothContext", {}),
                        "reduction": yarn_health.get("toolResultReduction", {}),
                    }
                await _persist_compaction_snapshot("yarn", y_compaction, y_comp_chars, 0, detail)

            results["yarn"] = {
                **results["yarn"],
                "prompt_tokens": y_prompt,
                "cached_tokens": y_cached,
                "requests": y_requests,
                "compaction_count": y_compaction,
            }
    except Exception as exc:
        results["errors"].append(f"yarn: {exc}")
        logger.warning("scrape_yarn_failed", exc_info=True)

    return results
