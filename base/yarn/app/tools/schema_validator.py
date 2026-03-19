"""JSON Schema validation for tool call arguments."""

from __future__ import annotations

import json
import logging
from typing import Any

import jsonschema

logger = logging.getLogger("yarn.tools.validator")


class ToolValidationError(Exception):
    def __init__(self, tool_name: str, errors: list[str]):
        self.tool_name = tool_name
        self.errors = errors
        super().__init__(f"Validation failed for {tool_name}: {'; '.join(errors)}")


def validate_tool_args(
    tool_name: str,
    arguments: dict[str, Any] | str,
    schema: dict[str, Any],
) -> dict[str, Any]:
    """Validate and parse tool call arguments against a JSON Schema.

    Accepts both dict and JSON string arguments (models sometimes emit strings).
    """
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError as e:
            raise ToolValidationError(tool_name, [f"Invalid JSON: {e}"])

    if not isinstance(arguments, dict):
        raise ToolValidationError(tool_name, ["Arguments must be a JSON object"])

    input_schema = schema.get("inputSchema") or schema.get("parameters", {})
    if not input_schema:
        return arguments

    try:
        jsonschema.validate(instance=arguments, schema=input_schema)
    except jsonschema.ValidationError as e:
        raise ToolValidationError(tool_name, [e.message])

    return arguments
