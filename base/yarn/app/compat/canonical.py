"""Canonical internal request/response models for protocol-agnostic processing.

These types sit between the inbound protocol adapters (Claude Messages, OpenAI
Chat) and the downstream provider boundary, keeping translation explicit and
reversible.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class StopReason(str, Enum):
    END_TURN = "end_turn"
    TOOL_USE = "tool_use"
    MAX_TOKENS = "max_tokens"
    STOP_SEQUENCE = "stop_sequence"
    ERROR = "error"


class ContentBlockType(str, Enum):
    TEXT = "text"
    TOOL_USE = "tool_use"
    TOOL_RESULT = "tool_result"
    THINKING = "thinking"
    IMAGE = "image"
    TOOL_REFERENCE = "tool_reference"


# ---------------------------------------------------------------------------
# Content blocks (Claude-native shape preserved)
# ---------------------------------------------------------------------------


@dataclass
class TextBlock:
    text: str
    type: str = "text"


@dataclass
class ToolUseBlock:
    id: str
    name: str
    input: dict[str, Any]
    type: str = "tool_use"


@dataclass
class ToolResultBlock:
    tool_use_id: str
    content: str | list[dict[str, Any]]
    is_error: bool = False
    type: str = "tool_result"


@dataclass
class ThinkingBlock:
    thinking: str
    signature: str = ""
    type: str = "thinking"


@dataclass
class ToolReferenceBlock:
    tool_name: str
    type: str = "tool_reference"


ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | ToolReferenceBlock


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------


@dataclass
class CanonicalMessage:
    role: str  # "user" | "assistant"
    content: list[ContentBlock] | str


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------


@dataclass
class CanonicalToolDef:
    """A tool definition in Claude-native shape (``input_schema``).

    Downstream adapters convert to OpenAI ``function.parameters`` when needed.
    """

    name: str
    description: str
    input_schema: dict[str, Any]
    cache_control: dict[str, Any] | None = None
    defer_loading: bool = False


# ---------------------------------------------------------------------------
# Request
# ---------------------------------------------------------------------------


@dataclass
class CanonicalRequest:
    model: str
    messages: list[CanonicalMessage]
    max_tokens: int = 4096
    system: str | list[dict[str, Any]] | None = None
    tools: list[CanonicalToolDef] | None = None
    tool_choice: dict[str, Any] | None = None
    temperature: float | None = None
    top_p: float | None = None
    stop_sequences: list[str] | None = None
    stream: bool = False
    metadata: dict[str, Any] | None = None
    thinking: dict[str, Any] | None = None

    # Protocol-level headers preserved from inbound request
    anthropic_version: str | None = None
    anthropic_beta: str | None = None

    # Extra fields from the inbound payload that we pass through untouched
    extra: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Response
# ---------------------------------------------------------------------------


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0


@dataclass
class CanonicalResponse:
    id: str
    model: str
    role: str = "assistant"
    content: list[ContentBlock] = field(default_factory=list)
    stop_reason: StopReason | None = None
    stop_sequence: str | None = None
    usage: Usage = field(default_factory=Usage)


# ---------------------------------------------------------------------------
# Streaming events (Claude SSE model)
# ---------------------------------------------------------------------------


@dataclass
class StreamEvent:
    """One event in the Claude streaming SSE protocol."""

    event_type: str  # message_start | content_block_start | content_block_delta | ...
    data: dict[str, Any]
