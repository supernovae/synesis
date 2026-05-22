from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from app.services.token_economics_observability import summarize_token_economics_events


def _event(event_kind: str, metadata_json: dict, created_at: datetime):
    return SimpleNamespace(
        event_kind=event_kind,
        metadata_json=metadata_json,
        created_at=created_at,
        session_key="session-1",
        request_id="req-1",
    )


def test_summarize_token_economics_events_rolls_up_request_warning_and_policy():
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    rows = [
        _event(
            "request_trajectory_v1",
            {
                "cost": {
                    "token_economics": {
                        "strategy": "explicit_premium",
                        "cache_outcome": "miss",
                        "recommendation": "preserve_stable_prefix_and_investigate",
                        "cache_hit_pct": 0,
                        "warnings": [
                            "cacheable_prompt_without_provider_hit",
                            "compaction_savings_unproven_without_cache_hit",
                        ],
                    }
                }
            },
            now - timedelta(minutes=5),
        ),
        _event(
            "token_economics_warning_v1",
            {
                "strategy": "explicit_premium",
                "cache_outcome": "write_without_read",
                "recommendation": "disable_premium_cache_write",
                "cache_hit_pct": 0,
                "warnings": ["premium_cache_write_without_read"],
            },
            now - timedelta(minutes=3),
        ),
        _event(
            "cache_policy_controller_decision_v1",
            {
                "enabled": True,
                "action": "safe_efficiency",
                "compaction_mode": "aggressive",
                "allow_explicit_cache_markers": False,
                "cache_unavailable": True,
                "retry_loop_risk": False,
                "premium_cache_write_suppressed": True,
                "provider": "dashscope",
                "provider_cache_strategy": "explicit_premium",
                "reasons": [
                    "cache_unavailable_or_unreported",
                    "premium_cache_write_without_read_streak",
                ],
            },
            now,
        ),
    ]

    summary = summarize_token_economics_events(rows, since_hours=24, scope="platform")

    assert summary["inspected_events"] == 3
    assert summary["counts_by_event_kind"]["request_trajectory_v1"] == 1
    assert summary["token_economics"]["request_observation_count"] == 1
    assert summary["token_economics"]["warning_event_count"] == 1
    assert summary["token_economics"]["cache_outcomes"] == {"miss": 1}
    assert summary["token_economics"]["recommendations"] == {"preserve_stable_prefix_and_investigate": 1}
    assert summary["token_economics"]["warnings"]["premium_cache_write_without_read"] == 1
    assert summary["token_economics"]["compaction_savings_unproven_count"] == 1
    assert summary["cache_policy"]["decision_count"] == 1
    assert summary["cache_policy"]["actions"] == {"safe_efficiency": 1}
    assert summary["cache_policy"]["compaction_modes"] == {"aggressive": 1}
    assert summary["cache_policy"]["cache_unavailable_count"] == 1
    assert summary["cache_policy"]["premium_write_suppressed_count"] == 1
    assert summary["cache_policy"]["explicit_marker_disabled_count"] == 1
    assert summary["cache_policy"]["latest"][0]["provider"] == "dashscope"
