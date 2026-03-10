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

from .schemas import CriticOut, _extract_json

logger = logging.getLogger("synesis.validator")

T = TypeVar("T", bound=BaseModel)

# Matches escaped-backslash pairs (\\) OR a single backslash NOT followed by a
# valid JSON escape character.  The callback keeps \\ as-is and doubles the
# backslash for anything else so json.loads sees a literal backslash.
_INVALID_ESCAPE_RE = re.compile(r'\\\\|\\(?!["\\/bfnrtu])')


def _fix_invalid_escapes(s: str) -> str:
    """Replace invalid JSON escape sequences (e.g. ``\\s``, ``\\a`` from LaTeX)."""

    def _repl(m: re.Match) -> str:
        if m.group(0) == "\\\\":
            return "\\\\"
        return "\\\\" + m.group(0)[1]

    return _INVALID_ESCAPE_RE.sub(_repl, s)


def _repair_json(raw: str) -> str:
    """Rule-based repair: fix common JSON issues (invalid escapes, truncation, trailing comma)."""
    content = raw.strip()
    content = _fix_invalid_escapes(content)
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


def _repair_truncated_json(content: str) -> tuple[str, bool]:
    """Auto-close truncated JSON. Prioritize closing blocking_issues over nonblocking.

    If Expecting ',' delimiter or unclosed brace, append ]} or } and return (repaired, True).
    """
    content = _fix_invalid_escapes(content.rstrip())
    if not content:
        return content, False

    # Truncation: ends with partial token or unclosed structure
    for suffix in (
        ',"nonblocking":[],"residual_risks":[]}',  # stopped after blocking_issues
        '],"nonblocking":[]}',  # stopped mid-structure
        "]}",  # inside array, e.g. blocking_issues
        "}",  # inside object
        "]",  # array only
        '"',  # unclosed string
    ):
        try:
            repaired = content + suffix
            json.loads(repaired)
            return repaired, True
        except json.JSONDecodeError:
            pass

    # Try progressively adding closing chars
    for closes in (["]", "}"], ["}"], ["]"], ['"']):
        try:
            repaired = content + "".join(closes)
            json.loads(repaired)
            return repaired, True
        except json.JSONDecodeError:
            pass

    return content, False


def validate_with_repair(raw: str, model: type[T]) -> T:
    """Validate raw LLM output. One repair pass if invalid. Hard fail if still invalid."""
    extracted = None
    try:
        extracted = _extract_json(raw)
    except ValueError:
        extracted = _repair_json(raw)

    for attempt in range(3):
        try:
            if attempt == 0:
                content = extracted or raw
            elif attempt == 1:
                content = _repair_json(extracted or raw)
            else:
                content, _ = _repair_truncated_json(extracted or raw)
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
            elif attempt == 1:
                extracted, _ = _repair_truncated_json(extracted or raw)
                logger.info("schema_truncation_repaired", extra={"detail": "Auto-closed truncated JSON"})
            else:
                raise ValueError(f"Schema validation failed after repair: {e}") from e
    raise ValueError("Schema validation failed")  # unreachable


def validate_critic_with_repair(raw: str) -> tuple[CriticOut, bool]:
    """Validate Critic output with truncation repair. Returns (parsed, is_truncated)."""
    extracted = None
    is_truncated = False
    try:
        extracted = _extract_json(raw)
    except ValueError:
        extracted = _repair_json(raw)

    for attempt in range(3):
        try:
            if attempt == 0:
                content = extracted or raw
            elif attempt == 1:
                content = _repair_json(extracted or raw)
            else:
                content, is_truncated = _repair_truncated_json(extracted or raw)
                if is_truncated:
                    extracted = content
            data = json.loads(content)
            return CriticOut.model_validate(data), is_truncated
        except (json.JSONDecodeError, ValueError, ValidationError) as e:
            if attempt == 0:
                extracted = _repair_json(extracted or raw)
            elif attempt == 1:
                extracted, is_truncated = _repair_truncated_json(extracted or raw)
                if is_truncated:
                    logger.info(
                        "critic_truncation_repaired",
                        extra={"detail": "Auto-closed; first N blocking_issues preserved"},
                    )
            else:
                raise ValueError(f"Critic schema validation failed: {e}") from e
    raise ValueError("Critic schema validation failed")
