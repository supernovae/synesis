from __future__ import annotations

import pytest
from app.routers.models import (
    DeploymentFallbacksBody,
    PromptAssignmentUpsertBody,
    PromptProfileCreateBody,
    PromptProfileUpdateBody,
    RoleAssignmentBody,
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


def test_role_assignment_accepts_known_generation_controls() -> None:
    body = RoleAssignmentBody(
        provider="openrouter",
        model="qwen/qwen-2.5-coder-32b-instruct",
        endpoint="https://openrouter.ai/api/v1",
        api_key_env="OPENROUTER_API_KEY",
        max_tokens=8192,
        temperature=0.2,
        top_p=0.95,
        top_k=40,
        min_p=0.05,
        presence_penalty=0.1,
        repetition_penalty=1.05,
        enable_thinking=True,
        reasoning_effort="medium",
        fallbacks=["synesis-coder-core"],
        adapter_hint="openai-compatible",
        context_window=131072,
        model_capability_preset="qwen3_coder",
        description="Coder role",
        notes="Known controls only",
    )

    assert body.provider == "openrouter"
    assert body.fallbacks == ["synesis-coder-core"]
    assert body.reasoning_effort == "medium"


def test_role_assignment_rejects_unknown_routing_field() -> None:
    with pytest.raises(ValidationError, match="admin_override"):
        RoleAssignmentBody(
            provider="openrouter",
            model="qwen/qwen-2.5-coder-32b-instruct",
            admin_override=True,
        )


def test_role_assignment_rejects_invalid_reasoning_effort() -> None:
    with pytest.raises(ValidationError, match="extreme"):
        RoleAssignmentBody(
            provider="openrouter",
            model="qwen/qwen-2.5-coder-32b-instruct",
            reasoning_effort="extreme",
        )


def test_deployment_fallbacks_accepts_known_field() -> None:
    body = DeploymentFallbacksBody(fallbacks=["synesis-writer-core", "synesis-writer-horizon"])

    assert body.model_dump() == {"fallbacks": ["synesis-writer-core", "synesis-writer-horizon"]}


def test_deployment_fallbacks_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError, match="fallback_policy"):
        DeploymentFallbacksBody(fallbacks=["synesis-writer-core"], fallback_policy="force")
