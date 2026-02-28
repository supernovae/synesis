"""Validator/Formatter node -- schema validation with one repair pass.

Schema failure does NOT count as a retry strategy. Invalid output → one repair
pass (rule-based) → re-validate. If still invalid → hard fail.
"""

from __future__ import annotations

import json
import logging
import re
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from .schemas import _extract_json

logger = logging.getLogger("synesis.validator")

T = TypeVar("T", bound=BaseModel)


def _repair_json(raw: str) -> str:
    """Rule-based repair: fix common JSON issues (truncation, trailing comma)."""
    content = raw.strip()
    # Try to extract object
    start = content.find("{")
    if start < 0:
        return content
    depth = 0
    end = -1
    for i, c in enumerate(content[start:], start=start):
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end < 0:
        return content
    extracted = content[start : end + 1]
    # Remove trailing comma before } or ]
    extracted = re.sub(r",\s*([}\]])", r"\1", extracted)
    # Ensure string values are closed (truncation: add closing quote if needed)
    if extracted.count('"') % 2 != 0:
        extracted = extracted.rstrip()
        if not extracted.endswith('"'):
            extracted += '"'
    return extracted


def validate_with_repair(raw: str, model: type[T]) -> T:
    """Validate raw LLM output. One repair pass if invalid. Hard fail if still invalid."""
    extracted = None
    try:
        extracted = _extract_json(raw)
    except ValueError:
        extracted = _repair_json(raw)

    for attempt in range(2):
        try:
            content = extracted if attempt == 0 else _repair_json(extracted or raw)
            data = json.loads(content)
            if "task_type" in data and isinstance(data["task_type"], str):
                from .state import TaskType

                try:
                    data["task_type"] = TaskType(data["task_type"])
                except ValueError:
                    data["task_type"] = TaskType.GENERAL
            return model.model_validate(data)
        except (json.JSONDecodeError, ValueError, ValidationError) as e:
            if attempt == 0:
                extracted = _repair_json(extracted or raw)
                logger.warning("schema_repair_attempt", extra={"error": str(e)[:200]})
            else:
                raise ValueError(f"Schema validation failed after repair: {e}") from e
    raise ValueError("Schema validation failed")  # unreachable
