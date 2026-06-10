"""Shared FastAPI route parameter validation for security-sensitive selectors."""

from __future__ import annotations

import math
import re
from typing import Any

from fastapi import HTTPException, Path

from .services.provider_catalog import KNOWN_ROLES

SAFE_IDENTIFIER_PATTERN = r"^[A-Za-z0-9_.:-]+$"
SAFE_TEXT_PATTERN = r"^[^\x00-\x1F\x7F]+$"
MODEL_ROLE_PATH_PATTERN = r"^[a-z0-9_-]+$"
PROVIDER_KEY_PATTERN = r"^[a-z0-9_-]+$"
MODEL_ID_PATTERN = r"^[^\x00-\x1F\x7F]+$"

_SAFE_IDENTIFIER_RE = re.compile(SAFE_IDENTIFIER_PATTERN)
_SAFE_TEXT_RE = re.compile(SAFE_TEXT_PATTERN)


def validate_safe_identifier(value: str, *, field_name: str = "identifier", max_length: int = 64) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        raise ValueError(f"{field_name} is required")
    if len(candidate) > max_length:
        raise ValueError(f"{field_name} must be at most {max_length} characters")
    if not _SAFE_TEXT_RE.fullmatch(candidate):
        raise ValueError(f"{field_name} must not contain control characters")
    if not _SAFE_IDENTIFIER_RE.fullmatch(candidate):
        raise ValueError(f"{field_name} must be token-shaped")
    return candidate


def validate_optional_safe_identifier(
    value: str | None,
    *,
    field_name: str = "identifier",
    max_length: int = 64,
) -> str | None:
    if value is None:
        return None
    return validate_safe_identifier(value, field_name=field_name, max_length=max_length)


def validate_safe_text(
    value: str | None,
    *,
    field_name: str = "text",
    max_length: int,
    allow_empty: bool = True,
) -> str:
    candidate = str(value or "").strip()
    if not candidate and not allow_empty:
        raise ValueError(f"{field_name} is required")
    if len(candidate) > max_length:
        raise ValueError(f"{field_name} must be at most {max_length} characters")
    if candidate and not _SAFE_TEXT_RE.fullmatch(candidate):
        raise ValueError(f"{field_name} must not contain control characters")
    return candidate


def validate_optional_safe_text(
    value: str | None,
    *,
    field_name: str = "text",
    max_length: int,
) -> str | None:
    if value is None:
        return None
    return validate_safe_text(value, field_name=field_name, max_length=max_length)


def validate_observability_payload(
    value: Any,
    *,
    field_name: str,
    max_depth: int = 4,
    max_items: int = 200,
    max_key_length: int = 128,
    max_string_length: int = 4000,
) -> Any:
    """Validate JSON-like observability metadata before storing it in JSONB."""
    if value is None:
        return None

    def _validate(node: Any, *, path: str, depth: int) -> Any:
        if depth > max_depth:
            raise ValueError(f"{field_name} exceeds maximum nesting depth")
        if isinstance(node, dict):
            if len(node) > max_items:
                raise ValueError(f"{path} contains too many fields")
            cleaned: dict[str, Any] = {}
            for raw_key, raw_child in node.items():
                if not isinstance(raw_key, str):
                    raise ValueError(f"{path} keys must be strings")
                key = validate_safe_text(
                    raw_key,
                    field_name=f"{path} key",
                    max_length=max_key_length,
                    allow_empty=False,
                )
                cleaned[key] = _validate(raw_child, path=f"{path}.{key}", depth=depth + 1)
            return cleaned
        if isinstance(node, list):
            if len(node) > max_items:
                raise ValueError(f"{path} contains too many items")
            return [_validate(item, path=f"{path}[]", depth=depth + 1) for item in node]
        if isinstance(node, str):
            return validate_safe_text(node, field_name=path, max_length=max_string_length)
        if isinstance(node, bool) or node is None:
            return node
        if isinstance(node, int | float):
            if isinstance(node, float) and not math.isfinite(node):
                raise ValueError(f"{path} must be finite")
            return node
        raise ValueError(f"{path} must be JSON-compatible")

    return _validate(value, path=field_name, depth=0)


def require_known_model_role_path(
    role: str = Path(..., min_length=1, max_length=64, pattern=MODEL_ROLE_PATH_PATTERN),
) -> str:
    if role not in KNOWN_ROLES:
        raise HTTPException(404, f"Unknown role: {role}")
    return role
