"""Anthropic Messages ↔ canonical model adapters.

Inbound:  Claude ``/v1/messages`` JSON → ``CanonicalRequest``
Outbound: ``CanonicalResponse`` → Claude JSON / SSE events
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from .canonical import (
    CanonicalMessage,
    CanonicalRequest,
    CanonicalResponse,
    CanonicalToolDef,
    ContentBlock,
    TextBlock,
    ThinkingBlock,
    ToolReferenceBlock,
    ToolResultBlock,
    ToolUseBlock,
    Usage,
)

logger = logging.getLogger("yarn.compat.claude_adapter")


# ---------------------------------------------------------------------------
# Inbound: Claude Messages body → CanonicalRequest
# ---------------------------------------------------------------------------


def claude_body_to_canonical(
    body: dict[str, Any],
    *,
    anthropic_version: str | None = None,
    anthropic_beta: str | None = None,
) -> CanonicalRequest:
    messages = [_parse_claude_message(m) for m in body.get("messages", [])]

    tools: list[CanonicalToolDef] | None = None
    raw_tools = body.get("tools")
    if raw_tools and isinstance(raw_tools, list):
        tools = [_parse_claude_tool(t) for t in raw_tools]

    known_keys = {
        "model", "messages", "max_tokens", "system", "tools", "tool_choice",
        "temperature", "top_p", "stop_sequences", "stream", "metadata",
        "thinking",
    }
    extra = {k: v for k, v in body.items() if k not in known_keys}

    return CanonicalRequest(
        model=body.get("model", ""),
        messages=messages,
        max_tokens=body.get("max_tokens", 4096),
        system=body.get("system"),
        tools=tools,
        tool_choice=body.get("tool_choice"),
        temperature=body.get("temperature"),
        top_p=body.get("top_p"),
        stop_sequences=body.get("stop_sequences"),
        stream=body.get("stream", False),
        metadata=body.get("metadata"),
        thinking=body.get("thinking"),
        anthropic_version=anthropic_version,
        anthropic_beta=anthropic_beta,
        extra=extra,
    )


def _parse_claude_message(raw: dict[str, Any]) -> CanonicalMessage:
    role = raw.get("role", "user")
    content = raw.get("content", "")

    if isinstance(content, str):
        return CanonicalMessage(role=role, content=content)

    blocks: list[ContentBlock] = []
    if isinstance(content, list):
        for block in content:
            blocks.append(_parse_content_block(block))
    return CanonicalMessage(role=role, content=blocks)


def _parse_content_block(block: dict[str, Any]) -> ContentBlock:
    btype = block.get("type", "text")

    if btype == "text":
        return TextBlock(text=block.get("text", ""))
    if btype == "tool_use":
        return ToolUseBlock(
            id=block.get("id", ""),
            name=block.get("name", ""),
            input=block.get("input", {}),
        )
    if btype == "tool_result":
        return ToolResultBlock(
            tool_use_id=block.get("tool_use_id", ""),
            content=block.get("content", ""),
            is_error=block.get("is_error", False),
        )
    if btype == "thinking":
        return ThinkingBlock(
            thinking=block.get("thinking", ""),
            signature=block.get("signature", ""),
        )
    if btype == "tool_reference":
        return ToolReferenceBlock(tool_name=block.get("tool_name", ""))

    return TextBlock(text=block.get("text", ""))


def _parse_claude_tool(raw: dict[str, Any]) -> CanonicalToolDef:
    return CanonicalToolDef(
        name=raw.get("name", ""),
        description=raw.get("description", ""),
        input_schema=raw.get("input_schema", {}),
        cache_control=raw.get("cache_control"),
        defer_loading=raw.get("defer_loading", False),
    )


# ---------------------------------------------------------------------------
# Outbound: CanonicalResponse → Claude Messages JSON (non-streaming)
# ---------------------------------------------------------------------------


def canonical_to_claude_response(resp: CanonicalResponse) -> dict[str, Any]:
    content = [_block_to_dict(b) for b in resp.content]
    stop_reason = resp.stop_reason.value if resp.stop_reason else "end_turn"

    return {
        "id": resp.id,
        "type": "message",
        "role": resp.role,
        "content": content,
        "model": resp.model,
        "stop_reason": stop_reason,
        "stop_sequence": resp.stop_sequence,
        "usage": {
            "input_tokens": resp.usage.input_tokens,
            "output_tokens": resp.usage.output_tokens,
        },
    }


def _block_to_dict(block: ContentBlock) -> dict[str, Any]:
    if isinstance(block, TextBlock):
        return {"type": "text", "text": block.text}
    if isinstance(block, ToolUseBlock):
        return {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
    if isinstance(block, ToolResultBlock):
        return {
            "type": "tool_result",
            "tool_use_id": block.tool_use_id,
            "content": block.content,
            "is_error": block.is_error,
        }
    if isinstance(block, ThinkingBlock):
        d: dict[str, Any] = {"type": "thinking", "thinking": block.thinking}
        if block.signature:
            d["signature"] = block.signature
        return d
    if isinstance(block, ToolReferenceBlock):
        return {"type": "tool_reference", "tool_name": block.tool_name}
    return {"type": "text", "text": ""}


# ---------------------------------------------------------------------------
# Outbound: CanonicalResponse → Claude streaming SSE events
# ---------------------------------------------------------------------------


def build_message_start_event(
    msg_id: str,
    model: str,
    usage: Usage,
) -> str:
    data = {
        "type": "message_start",
        "message": {
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "content": [],
            "model": model,
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {
                "input_tokens": usage.input_tokens,
                "output_tokens": 0,
            },
        },
    }
    return f"event: message_start\ndata: {json.dumps(data)}\n\n"


def build_ping_event() -> str:
    return "event: ping\ndata: {\"type\": \"ping\"}\n\n"


def build_content_block_start(index: int, block: ContentBlock) -> str:
    if isinstance(block, TextBlock):
        cb: dict[str, Any] = {"type": "text", "text": ""}
    elif isinstance(block, ToolUseBlock):
        cb = {"type": "tool_use", "id": block.id, "name": block.name, "input": {}}
    elif isinstance(block, ThinkingBlock):
        cb = {"type": "thinking", "thinking": "", "signature": ""}
    else:
        cb = {"type": "text", "text": ""}

    data = {"type": "content_block_start", "index": index, "content_block": cb}
    return f"event: content_block_start\ndata: {json.dumps(data)}\n\n"


def build_content_block_delta(index: int, delta: dict[str, Any]) -> str:
    data = {"type": "content_block_delta", "index": index, "delta": delta}
    return f"event: content_block_delta\ndata: {json.dumps(data)}\n\n"


def build_content_block_stop(index: int) -> str:
    data = {"type": "content_block_stop", "index": index}
    return f"event: content_block_stop\ndata: {json.dumps(data)}\n\n"


def build_message_delta(stop_reason: str, usage: Usage) -> str:
    data = {
        "type": "message_delta",
        "delta": {"stop_reason": stop_reason, "stop_sequence": None},
        "usage": {"output_tokens": usage.output_tokens},
    }
    return f"event: message_delta\ndata: {json.dumps(data)}\n\n"


def build_message_stop() -> str:
    return "event: message_stop\ndata: {\"type\": \"message_stop\"}\n\n"


def build_error_event(error_type: str, message: str) -> str:
    data = {"type": "error", "error": {"type": error_type, "message": message}}
    return f"event: error\ndata: {json.dumps(data)}\n\n"


# ---------------------------------------------------------------------------
# Convenience: generate a new message ID
# ---------------------------------------------------------------------------


def generate_message_id() -> str:
    return f"msg_{uuid.uuid4().hex[:24]}"
