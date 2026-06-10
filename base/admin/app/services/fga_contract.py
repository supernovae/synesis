"""Canonical OpenFGA tuple string contract.

FGA tuple strings are security-sensitive: ``type:id#relation`` is parsed by
OpenFGA, so callers must not splice raw user or resource identifiers into them.
"""

from __future__ import annotations

from ..route_validation import validate_safe_identifier

FGA_SUBJECT_TYPES = frozenset({"user", "org", "tenant", "tool"})
FGA_OBJECT_TYPES = frozenset(
    {
        "admin_endpoint",
        "feature",
        "org",
        "planner_endpoint",
        "platform",
        "platform_policy",
        "rag_catalog",
        "tenant",
        "tool",
        "yarn_endpoint",
    }
)


def fga_relation(value: str, *, field_name: str = "relation") -> str:
    return validate_safe_identifier(value, field_name=field_name, max_length=64)


def fga_object_type(value: str, *, allowed: frozenset[str] = FGA_OBJECT_TYPES) -> str:
    object_type = validate_safe_identifier(value, field_name="object_type", max_length=64)
    if object_type not in allowed:
        raise ValueError(f"Unsupported FGA object type: {object_type}")
    return object_type


def fga_id(value: str, *, field_name: str = "object_id", max_length: int = 128) -> str:
    return validate_safe_identifier(value, field_name=field_name, max_length=max_length)


def fga_user_for_id(user_id: str) -> str:
    return f"user:{fga_id(user_id, field_name='user_id', max_length=256)}"


def fga_object(object_type: str, object_id: str) -> str:
    return f"{fga_object_type(object_type)}:{fga_id(object_id, field_name='object_id', max_length=256)}"


def parse_fga_object(value: str) -> tuple[str, str]:
    candidate = str(value or "").strip()
    if candidate.count(":") != 1 or "#" in candidate:
        raise ValueError("object must use type:id syntax")
    object_type, object_id = candidate.split(":", 1)
    return fga_object_type(object_type), fga_id(object_id, field_name="object_id", max_length=256)


def fga_subject(value: str) -> str:
    candidate = str(value or "").strip()
    if candidate.count(":") != 1:
        raise ValueError("user must use type:id or type:id#relation syntax")
    base, relation = candidate.split("#", 1) if "#" in candidate else (candidate, "")
    subject_type, subject_id = base.split(":", 1)
    subject_type = fga_object_type(subject_type, allowed=FGA_SUBJECT_TYPES)
    subject_id = fga_id(subject_id, field_name="subject_id", max_length=256)
    if not relation:
        return f"{subject_type}:{subject_id}"
    return f"{subject_type}:{subject_id}#{fga_relation(relation)}"


def fga_tuple_key(user: str, relation: str, object_value: str) -> dict[str, str]:
    return {
        "user": fga_subject(user),
        "relation": fga_relation(relation),
        "object": fga_object(*parse_fga_object(object_value)),
    }
