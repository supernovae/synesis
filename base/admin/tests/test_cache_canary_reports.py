from __future__ import annotations

import json
from datetime import UTC, datetime

from app.services.cache_canary_reports import load_cache_canary_report, summarize_cache_canary_report


def _report(generated_at: str = "2026-05-22T12:00:00Z") -> dict:
    return {
        "generated_at": generated_at,
        "mode": "offline+live",
        "summary": {"passed": True, "total": 6, "failed": 0, "failures": []},
        "results": [
            {
                "id": "anthropic",
                "display_name": "Anthropic",
                "passed": True,
                "failures": [],
                "marker_backend": "anthropic",
                "provider_strategy": "explicit_standard",
                "cache_hint_strategy": "explicit_standard",
                "prefix_stable_bytes": 4096,
            }
        ],
        "live_summary": {"passed": True, "total": 2, "skipped": 1, "failed": 0, "failures": []},
        "live_results": [
            {
                "id": "openrouter",
                "display_name": "OpenRouter",
                "status": "passed",
                "reason": None,
                "failures": [],
                "warnings": ["cache_hit_unverified:miss"],
                "http_statuses": [200, 200],
                "prompt_tokens": 1200,
                "cached_prompt_tokens": 0,
                "cache_creation_tokens": 0,
                "cache_hit_pct": 0,
                "recommendation": "preserve_stable_prefix_and_investigate",
            },
            {
                "id": "dashscope",
                "display_name": "DashScope",
                "status": "skipped",
                "reason": "endpoint_not_configured",
                "failures": [],
                "warnings": [],
                "http_statuses": [],
                "prompt_tokens": 0,
                "cached_prompt_tokens": 0,
                "cache_creation_tokens": 0,
                "cache_hit_pct": 0,
                "recommendation": "not_run",
            },
        ],
    }


def test_summarize_cache_canary_report_surfaces_live_warning():
    summary = summarize_cache_canary_report(
        _report(),
        path="/tmp/cache-canary.json",
        stale_hours=24,
        now=datetime(2026, 5, 22, 13, 0, tzinfo=UTC),
    )

    assert summary["configured"] is True
    assert summary["present"] is True
    assert summary["stale"] is False
    assert summary["summary"]["passed"] is True
    assert summary["live_summary"]["skipped"] == 1
    assert any(alert["code"] == "cache_hit_unverified" for alert in summary["alerts"])


def test_summarize_cache_canary_report_marks_stale_and_failed():
    report = _report(generated_at="2026-05-20T12:00:00Z")
    report["summary"] = {
        "passed": False,
        "total": 6,
        "failed": 1,
        "failures": [{"id": "dashscope", "failures": ["prefix_stable_bytes:0 below:1024"]}],
    }
    report["results"][0]["passed"] = False
    report["results"][0]["failures"] = ["prefix_stable_bytes:0 below:1024"]

    summary = summarize_cache_canary_report(
        report,
        path="/tmp/cache-canary.json",
        stale_hours=24,
        now=datetime(2026, 5, 22, 13, 0, tzinfo=UTC),
    )

    codes = {alert["code"] for alert in summary["alerts"]}
    assert summary["stale"] is True
    assert "report_stale" in codes
    assert "offline_canaries_failed" in codes
    assert "offline_canary_failed" in codes


def test_load_cache_canary_report_reads_configured_file(tmp_path):
    report_path = tmp_path / "cache-canary.json"
    report_path.write_text(json.dumps(_report()), encoding="utf-8")

    loaded = load_cache_canary_report(
        str(report_path),
        stale_hours=24,
        now=datetime(2026, 5, 22, 13, 0, tzinfo=UTC),
    )

    assert loaded["configured"] is True
    assert loaded["present"] is True
    assert loaded["path"] == str(report_path)
    assert loaded["live_results"][0]["id"] == "openrouter"


def test_load_cache_canary_report_disabled_when_path_unset():
    loaded = load_cache_canary_report("", now=datetime(2026, 5, 22, 13, 0, tzinfo=UTC))

    assert loaded["configured"] is False
    assert loaded["present"] is False
    assert loaded["alerts"][0]["code"] == "not_configured"
