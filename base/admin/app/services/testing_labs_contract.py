"""Typed request/storage contracts for Testing Labs replay runs."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..route_validation import validate_safe_identifier


class TestingLabsTraceFilter(BaseModel):
    """Allowed trace selectors for replay prompt extraction."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    since: datetime | None = None
    until: datetime | None = None
    task_type: str = Field("", max_length=64)
    org_id: str = Field("", max_length=128)

    @field_validator("task_type", mode="after")
    @classmethod
    def _task_type_is_token(cls, value: str) -> str:
        if not value:
            return ""
        return validate_safe_identifier(value, field_name="task_type", max_length=64)

    @field_validator("org_id", mode="after")
    @classmethod
    def _org_id_is_token(cls, value: str) -> str:
        if not value:
            return ""
        return validate_safe_identifier(value, field_name="org_id", max_length=128)

    @model_validator(mode="after")
    def _time_range_is_ordered(self) -> TestingLabsTraceFilter:
        if self.since is not None and self.until is not None and self.since > self.until:
            raise ValueError("since must be before until")
        return self


class TestingLabsRunConfig(BaseModel):
    """Reserved for future execution knobs.

    Keep this explicitly empty until a backend consumer is added. New knobs should
    be typed here and covered by endpoint and engine tests before use.
    """

    model_config = ConfigDict(extra="forbid")


def trace_filter_to_storage(value: TestingLabsTraceFilter | None) -> dict[str, Any] | None:
    if value is None:
        return None
    data = value.model_dump(mode="json", exclude_none=True)
    return {key: item for key, item in data.items() if item not in ("", [], {})}


def run_config_to_storage(value: TestingLabsRunConfig | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return value.model_dump(mode="json")


def parse_stored_trace_filter(value: Any) -> TestingLabsTraceFilter:
    if value is None:
        return TestingLabsTraceFilter()
    if not isinstance(value, dict):
        raise ValueError("stored trace_filter must be an object")
    return TestingLabsTraceFilter.model_validate(value)
