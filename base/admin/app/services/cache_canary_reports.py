"""Operator-facing summaries for provider cache canary reports."""

from __future__ import annotations

import json
import os
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

DEFAULT_STALE_HOURS = 24
DEFAULT_MAX_BYTES = 2_000_000


def _env_int(name: str, default: int, *, minimum: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, value)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_strings(value: Any) -> list[str]:
    return [item for item in _as_list(value) if isinstance(item, str) and item.strip()]


def _as_int(value: Any, default: int = 0) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else default


def _as_float(value: Any, default: float = 0.0) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else default


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value.strip()
    if candidate.endswith("Z"):
        candidate = f"{candidate[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _alert(
    severity: str,
    code: str,
    message: str,
    *,
    provider_id: str | None = None,
    count: int | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {"severity": severity, "code": code, "message": message}
    if provider_id:
        data["provider_id"] = provider_id
    if count is not None:
        data["count"] = count
    return data


def _empty_summary() -> dict[str, Any]:
    return {"passed": False, "total": 0, "failed": 0, "skipped": 0, "failures": []}


def _empty_payload(
    *,
    configured: bool,
    present: bool,
    stale: bool,
    path: str | None,
    mode: str,
    alerts: list[dict[str, Any]],
    generated_at: str | None = None,
    modified_at: str | None = None,
) -> dict[str, Any]:
    return {
        "configured": configured,
        "present": present,
        "stale": stale,
        "path": path,
        "generated_at": generated_at,
        "modified_at": modified_at,
        "mode": mode,
        "summary": _empty_summary(),
        "results": [],
        "live_summary": _empty_summary(),
        "live_results": [],
        "alerts": alerts,
    }


def _normalize_failures(value: Any) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    for item in _as_list(value):
        if isinstance(item, str) and item.strip():
            failures.append({"id": "unknown", "failures": [item]})
            continue
        item_dict = _as_dict(item)
        if not item_dict:
            continue
        failures.append(
            {
                "id": str(item_dict.get("id") or item_dict.get("provider_id") or "unknown"),
                "failures": _as_strings(item_dict.get("failures")),
            }
        )
    return failures


def _normalize_summary(value: Any) -> dict[str, Any]:
    data = _as_dict(value)
    if not data:
        return _empty_summary()
    total = _as_int(data.get("total"))
    failed = _as_int(data.get("failed"))
    skipped = _as_int(data.get("skipped"))
    passed_raw = data.get("passed")
    passed = passed_raw if isinstance(passed_raw, bool) else failed == 0 and total > 0
    return {
        "passed": passed,
        "total": total,
        "failed": failed,
        "skipped": skipped,
        "failures": _normalize_failures(data.get("failures")),
    }


def _normalize_offline_result(value: Any) -> dict[str, Any]:
    data = _as_dict(value)
    return {
        "id": str(data.get("id") or "unknown"),
        "display_name": str(data.get("display_name") or data.get("displayName") or data.get("id") or "unknown"),
        "passed": data.get("passed") is True,
        "failures": _as_strings(data.get("failures")),
        "marker_backend": str(data.get("marker_backend") or data.get("markerBackend") or ""),
        "provider_strategy": str(data.get("provider_strategy") or data.get("providerStrategy") or ""),
        "cache_hint_strategy": str(data.get("cache_hint_strategy") or data.get("cacheHintStrategy") or ""),
        "prefix_stable_bytes": _as_int(data.get("prefix_stable_bytes") or data.get("prefixStableBytes")),
    }


def _normalize_live_result(value: Any) -> dict[str, Any]:
    data = _as_dict(value)
    return {
        "id": str(data.get("id") or "unknown"),
        "display_name": str(data.get("display_name") or data.get("displayName") or data.get("id") or "unknown"),
        "status": str(data.get("status") or "skipped"),
        "reason": data.get("reason") if isinstance(data.get("reason"), str) else None,
        "failures": _as_strings(data.get("failures")),
        "warnings": _as_strings(data.get("warnings")),
        "http_statuses": [
            status
            for status in _as_list(data.get("http_statuses") or data.get("httpStatuses"))
            if isinstance(status, int)
        ],
        "prompt_tokens": _as_int(data.get("prompt_tokens") or data.get("promptTokens")),
        "cached_prompt_tokens": _as_int(data.get("cached_prompt_tokens") or data.get("cachedPromptTokens")),
        "cache_creation_tokens": _as_int(data.get("cache_creation_tokens") or data.get("cacheCreationTokens")),
        "cache_hit_pct": _as_float(data.get("cache_hit_pct") or data.get("cacheHitPct")),
        "recommendation": str(data.get("recommendation") or "not_run"),
    }


def _warning_code(warning: str) -> str:
    prefix = warning.split(":", 1)[0].strip() or "warning"
    return "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in prefix)


def summarize_cache_canary_report(
    report: dict[str, Any],
    *,
    modified_at: datetime | None = None,
    path: str | None = None,
    stale_hours: int = DEFAULT_STALE_HOURS,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Normalize a cache canary JSON report into a compact admin payload."""
    current = (now or datetime.now(UTC)).astimezone(UTC)
    generated_at = _parse_datetime(report.get("generated_at"))
    modified_at_utc = modified_at.astimezone(UTC) if isinstance(modified_at, datetime) else None
    freshness_anchor = generated_at or modified_at_utc
    stale = freshness_anchor is None or freshness_anchor < current - timedelta(hours=max(1, stale_hours))

    mode = str(report.get("mode") or "unknown")
    summary = _normalize_summary(report.get("summary"))
    live_summary = _normalize_summary(report.get("live_summary"))
    results = [_normalize_offline_result(item) for item in _as_list(report.get("results"))]
    live_results = [_normalize_live_result(item) for item in _as_list(report.get("live_results"))]

    alerts: list[dict[str, Any]] = []
    if stale:
        alerts.append(
            _alert(
                "warning",
                "report_stale",
                f"Cache canary report is older than {max(1, stale_hours)}h or lacks a valid timestamp.",
            )
        )
    if summary["total"] <= 0:
        alerts.append(
            _alert("warning", "offline_canaries_missing", "Offline provider cache canary results are missing.")
        )
    elif not summary["passed"] or summary["failed"] > 0:
        alerts.append(
            _alert(
                "error",
                "offline_canaries_failed",
                f"{summary['failed']} offline provider cache canary result(s) failed.",
                count=summary["failed"],
            )
        )
    for result in results:
        if not result["passed"]:
            alerts.append(
                _alert(
                    "error",
                    "offline_canary_failed",
                    f"{result['display_name']} failed offline cache packet validation.",
                    provider_id=result["id"],
                )
            )

    if live_summary["total"] <= 0:
        alerts.append(_alert("info", "live_canaries_missing", "Live provider cache canary results are missing."))
    elif live_summary["skipped"] >= live_summary["total"]:
        skipped_reasons = Counter(result["reason"] or "unknown" for result in live_results)
        live_disabled_only = set(skipped_reasons) == {"live_disabled"}
        severity = "info" if mode == "offline" and live_disabled_only else "warning"
        reason_text = ", ".join(f"{reason}={count}" for reason, count in skipped_reasons.most_common()) or "unknown"
        alerts.append(
            _alert(
                severity,
                "live_canaries_skipped",
                f"All live provider cache canaries were skipped ({reason_text}).",
                count=live_summary["skipped"],
            )
        )
    elif live_summary["failed"] > 0:
        alerts.append(
            _alert(
                "error",
                "live_canaries_failed",
                f"{live_summary['failed']} live provider cache canary result(s) failed.",
                count=live_summary["failed"],
            )
        )

    for result in live_results:
        if result["status"] == "failed":
            alerts.append(
                _alert(
                    "error",
                    "live_canary_failed",
                    f"{result['display_name']} live cache probe failed: {', '.join(result['failures']) or 'unknown failure'}",
                    provider_id=result["id"],
                )
            )
        elif result["status"] == "skipped" and mode != "offline":
            alerts.append(
                _alert(
                    "warning",
                    "live_canary_skipped",
                    f"{result['display_name']} live cache probe skipped: {result['reason'] or 'unknown'}",
                    provider_id=result["id"],
                )
            )
        for warning in result["warnings"]:
            code = _warning_code(warning)
            alerts.append(
                _alert(
                    "warning",
                    code,
                    f"{result['display_name']} live cache probe warning: {warning}",
                    provider_id=result["id"],
                )
            )

    return {
        "configured": bool(path),
        "present": True,
        "stale": stale,
        "path": path,
        "generated_at": _iso(generated_at),
        "modified_at": _iso(modified_at_utc),
        "mode": mode,
        "summary": summary,
        "results": results,
        "live_summary": live_summary,
        "live_results": live_results,
        "alerts": alerts,
    }


def load_cache_canary_report(
    path: str | None = None,
    *,
    stale_hours: int | None = None,
    max_bytes: int | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Load the latest cache canary report from disk for the admin API."""
    configured_path = (path if path is not None else os.getenv("SYNESIS_CACHE_CANARY_REPORT_PATH", "")).strip()
    effective_stale_hours = (
        max(1, stale_hours)
        if stale_hours is not None
        else _env_int("SYNESIS_CACHE_CANARY_REPORT_STALE_HOURS", DEFAULT_STALE_HOURS, minimum=1)
    )
    effective_max_bytes = (
        max(1, max_bytes)
        if max_bytes is not None
        else _env_int("SYNESIS_CACHE_CANARY_REPORT_MAX_BYTES", DEFAULT_MAX_BYTES, minimum=1)
    )
    if not configured_path:
        return _empty_payload(
            configured=False,
            present=False,
            stale=True,
            path=None,
            mode="not_configured",
            alerts=[
                _alert(
                    "info",
                    "not_configured",
                    "Set SYNESIS_CACHE_CANARY_REPORT_PATH to expose CI or cron cache canary results here.",
                )
            ],
        )

    report_path = Path(configured_path)
    try:
        stat = report_path.stat()
    except FileNotFoundError:
        return _empty_payload(
            configured=True,
            present=False,
            stale=True,
            path=configured_path,
            mode="missing",
            alerts=[_alert("warning", "report_missing", "Configured cache canary report path does not exist.")],
        )
    except OSError:
        return _empty_payload(
            configured=True,
            present=False,
            stale=True,
            path=configured_path,
            mode="unreadable",
            alerts=[_alert("error", "report_stat_failed", "Unable to stat cache canary report.")],
        )

    modified_at = datetime.fromtimestamp(stat.st_mtime, tz=UTC)
    if stat.st_size > effective_max_bytes:
        return _empty_payload(
            configured=True,
            present=True,
            stale=True,
            path=configured_path,
            mode="too_large",
            modified_at=_iso(modified_at),
            alerts=[
                _alert(
                    "error",
                    "report_too_large",
                    f"Cache canary report is {stat.st_size} bytes, above the {effective_max_bytes} byte limit.",
                )
            ],
        )

    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return _empty_payload(
            configured=True,
            present=True,
            stale=True,
            path=configured_path,
            mode="invalid_json",
            modified_at=_iso(modified_at),
            alerts=[_alert("error", "invalid_json", "Cache canary report is not valid JSON.")],
        )
    except OSError:
        return _empty_payload(
            configured=True,
            present=True,
            stale=True,
            path=configured_path,
            mode="read_failed",
            modified_at=_iso(modified_at),
            alerts=[_alert("error", "read_failed", "Unable to read cache canary report.")],
        )

    if not isinstance(report, dict):
        return _empty_payload(
            configured=True,
            present=True,
            stale=True,
            path=configured_path,
            mode="invalid_report",
            modified_at=_iso(modified_at),
            alerts=[_alert("error", "invalid_report", "Cache canary report JSON root must be an object.")],
        )

    return summarize_cache_canary_report(
        report,
        modified_at=modified_at,
        path=configured_path,
        stale_hours=effective_stale_hours,
        now=now,
    )
