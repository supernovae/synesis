from __future__ import annotations

import pytest
from app.routers.models import (
    PromptAssignmentUpsertBody,
    PromptProfileCreateBody,
    PromptProfileUpdateBody,
)
from pydantic import ValidationError


def test_prompt_profile_create_accepts_known_fields() -> None:
    body = PromptProfileCreateBody(
        name="planner-default",
        service="planner",
        description="Default planner prompt",
        content="Use grounded planning.",
        enabled=True,
    )

    assert body.model_dump() == {
        "name": "planner-default",
        "service": "planner",
        "description": "Default planner prompt",
        "content": "Use grounded planning.",
        "enabled": True,
    }


def test_prompt_profile_create_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError, match="invented_security_attr"):
        PromptProfileCreateBody(
            name="yarn-default",
            service="yarn",
            content="Operate safely.",
            invented_security_attr=True,
        )


def test_prompt_profile_update_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError, match="prompt_injection_mode"):
        PromptProfileUpdateBody(content="Updated prompt.", prompt_injection_mode="override")


def test_prompt_profile_rejects_unknown_service() -> None:
    with pytest.raises(ValidationError, match="admin"):
        PromptProfileCreateBody(name="bad", service="admin", content="Nope.")


def test_prompt_assignment_accepts_known_target_type() -> None:
    body = PromptAssignmentUpsertBody(
        service="yarn",
        target_type="chat_profile",
        target_value="rag_grounded_answer",
        profile_id=10,
        enabled=False,
    )

    assert body.model_dump() == {
        "service": "yarn",
        "target_type": "chat_profile",
        "target_value": "rag_grounded_answer",
        "profile_id": 10,
        "enabled": False,
    }


def test_prompt_assignment_rejects_unknown_target_type() -> None:
    with pytest.raises(ValidationError, match="platform_admin"):
        PromptAssignmentUpsertBody(
            service="yarn",
            target_type="platform_admin",
            target_value="*",
            profile_id=1,
        )


def test_prompt_assignment_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError, match="extra_role"):
        PromptAssignmentUpsertBody(
            service="planner",
            target_type="default",
            target_value="*",
            profile_id=1,
            extra_role="admin",
        )
