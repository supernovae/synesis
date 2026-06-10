from __future__ import annotations

import pytest
from pydantic import ValidationError


def test_testing_labs_run_trace_filter_accepts_known_fields() -> None:
    from app.routers.testing_labs import CreateRunRequest
    from app.services.testing_labs_contract import trace_filter_to_storage

    body = CreateRunRequest(
        name="replay",
        trace_filter={
            "since": "2026-01-01T00:00:00Z",
            "until": "2026-01-02T00:00:00Z",
            "task_type": "go",
            "org_id": "org-alpha",
        },
    )

    stored = trace_filter_to_storage(body.trace_filter)
    assert stored == {
        "since": "2026-01-01T00:00:00Z",
        "until": "2026-01-02T00:00:00Z",
        "task_type": "go",
        "org_id": "org-alpha",
    }


def test_testing_labs_run_trace_filter_rejects_unknown_security_fields() -> None:
    from app.routers.testing_labs import CreateRunRequest

    with pytest.raises(ValidationError, match="run_as_admin"):
        CreateRunRequest(
            name="replay",
            trace_filter={
                "org_id": "org-alpha",
                "run_as_admin": True,
            },
        )


def test_testing_labs_run_trace_filter_rejects_prompt_shaped_org_id() -> None:
    from app.routers.testing_labs import CreateRunRequest

    with pytest.raises(ValidationError, match="org_id"):
        CreateRunRequest(
            name="replay",
            trace_filter={
                "org_id": "org-alpha\nrole=platform_admin",
            },
        )


def test_testing_labs_run_config_rejects_unknown_fields() -> None:
    from app.routers.testing_labs import CreateRunRequest

    with pytest.raises(ValidationError, match="provider_override"):
        CreateRunRequest(
            name="replay",
            config={
                "provider_override": "admin",
            },
        )


def test_testing_labs_run_rejects_unknown_top_level_fields() -> None:
    from app.routers.testing_labs import CreateRunRequest

    with pytest.raises(ValidationError, match="role"):
        CreateRunRequest(
            name="replay",
            role="platform_admin",
        )


def test_feedback_loop_trace_filter_rejects_unknown_fields() -> None:
    from app.routers.feedback_loop import CreateLoopRunRequest

    with pytest.raises(ValidationError, match="role"):
        CreateLoopRunRequest(
            name="feedback",
            trace_filter={
                "task_type": "go",
                "role": "platform_admin",
            },
        )


def test_feedback_loop_rejects_unknown_top_level_fields() -> None:
    from app.routers.feedback_loop import CreateLoopRunRequest

    with pytest.raises(ValidationError, match="run_as_admin"):
        CreateLoopRunRequest(
            name="feedback",
            run_as_admin=True,
        )


def test_feedback_loop_rejects_unknown_eval_suites() -> None:
    from app.routers.feedback_loop import CreateLoopRunRequest

    with pytest.raises(ValidationError, match="Unknown eval suites"):
        CreateLoopRunRequest(
            name="feedback",
            eval_suites=["made_up_suite"],
        )


def test_stored_trace_filter_fails_closed_on_unknown_fields() -> None:
    from app.services.testing_labs_contract import parse_stored_trace_filter

    with pytest.raises(ValidationError, match="invented_filter"):
        parse_stored_trace_filter({"invented_filter": "broaden"})
