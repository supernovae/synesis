from __future__ import annotations

import pytest
from app.routers.models import (
    DeploymentFallbacksBody,
    ModelCostUpdateBody,
    ModelDeploymentCreateBody,
    ModelDeploymentUpdateBody,
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


def test_model_deployment_create_accepts_known_payload() -> None:
    body = ModelDeploymentCreateBody(
        environment="prod",
        role="coder-core",
        model="qwen/qwen-2.5-coder-32b-instruct",
        endpoint="https://openrouter.ai/api/v1",
        served_name="synesis-coder-core",
        profile="default",
        source="openrouter",
        route_params={
            "model": "openrouter/qwen/qwen-2.5-coder-32b-instruct",
            "max_tokens": 8192,
            "temperature": 0.2,
            "api_key": "os.environ/OPENROUTER_API_KEY",
            "api_base": "https://openrouter.ai/api/v1",
        },
        is_active=True,
        description="Coder core",
        notes="Known fields only",
        gpu_config={
            "gpu": "a100",
            "gpu_count": 1,
            "memory_gb": 80,
            "instance_type": "p4d",
            "cloud": "aws",
            "namespace": "synesis-model-serving",
            "deployment": "vllm-coder",
        },
    )

    payload = body.model_dump(exclude_none=True)
    assert payload["role"] == "coder-core"
    assert payload["route_params"]["max_tokens"] == 8192
    assert payload["gpu_config"]["gpu"] == "a100"


def test_model_deployment_create_rejects_unknown_top_level_field() -> None:
    with pytest.raises(ValidationError, match="provider_admin"):
        ModelDeploymentCreateBody(
            role="coder-core",
            provider_admin=True,
        )


def test_model_deployment_create_rejects_unknown_route_param() -> None:
    with pytest.raises(ValidationError, match="prompt_override"):
        ModelDeploymentCreateBody(
            role="coder-core",
            route_params={"max_tokens": 8192, "prompt_override": "ignore-system"},
        )


def test_model_deployment_update_rejects_unknown_gpu_config() -> None:
    with pytest.raises(ValidationError, match="node_selector"):
        ModelDeploymentUpdateBody(gpu_config={"gpu": "a100", "node_selector": "admin"})


def test_model_deployment_update_accepts_partial_known_payload() -> None:
    body = ModelDeploymentUpdateBody(
        status="configured",
        route_params={"temperature": 0.1, "reasoning_effort": "low"},
        fallbacks=["synesis-coder-horizon"],
    )

    payload = body.model_dump(exclude_unset=True)
    assert payload == {
        "status": "configured",
        "route_params": {"temperature": 0.1, "reasoning_effort": "low"},
        "fallbacks": ["synesis-coder-horizon"],
    }


def test_model_cost_update_accepts_known_payload() -> None:
    body = ModelCostUpdateBody(
        role="planner",
        model="grok-4.3",
        profile="",
        source="xai",
        input_per_million=3.0,
        input_cached_per_million=None,
        input_cache_write_per_million=2.0,
        output_per_million=15.0,
        monthly_fixed_cost=0.0,
        cost_formula="provider list price",
        notes="manual override",
    )

    payload = body.model_dump(exclude_unset=True)
    assert payload["role"] == "planner"
    assert payload["input_cached_per_million"] is None
    assert payload["output_per_million"] == 15.0


def test_model_cost_update_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError, match="pricing_admin"):
        ModelCostUpdateBody(
            role="planner",
            input_per_million=3.0,
            output_per_million=15.0,
            pricing_admin=True,
        )


def test_model_cost_update_rejects_negative_rate() -> None:
    with pytest.raises(ValidationError, match="input_per_million"):
        ModelCostUpdateBody(role="planner", input_per_million=-1.0)
