"""Canonical ↔ OpenAI Chat Completions translation at the provider boundary.

This module converts canonical requests/responses into OpenAI's wire format
only when the downstream backend speaks OpenAI. It is the *last* step before
hitting the provider and the *first* step when reading the provider's response.

Translation is deliberately reversible: each Claude content block type has a
deterministic mapping, so round-trip fidelity is preserved for regressions.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from .canonical import (
    CanonicalMessage,
    CanonicalRequest,
    CanonicalResponse,
    CanonicalToolDef,
    ContentBlock,
    StopReason,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    Usage,
)

logger = logging.getLogger("yarn.compat.openai_bridge")


# ---------------------------------------------------------------------------
# Canonical → OpenAI request payload
# ---------------------------------------------------------------------------


def canonical_to_openai_payload(req: CanonicalRequest) -> dict[str, Any]:
    messages = _build_openai_messages(req)
    payload: dict[str, Any] = {
        "model": req.model,
        "messages": messages,
        "stream": req.stream,
        "max_tokens": req.max_tokens,
    }
    if req.stream:
        payload["stream_options"] = {"include_usage": True}
    if req.temperature is not None:
        payload["temperature"] = req.temperature
    if req.top_p is not None:
        payload["top_p"] = req.top_p
    if req.stop_sequences:
        payload["stop"] = req.stop_sequences
    if req.tools:
        payload["tools"] = [_tool_to_openai(t) for t in req.tools]
        if req.tool_choice:
            payload["tool_choice"] = _tool_choice_to_openai(req.tool_choice)
        else:
            payload["tool_choice"] = "auto"

    return payload


def _build_openai_messages(req: CanonicalRequest) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    if req.system:
        if isinstance(req.system, str):
            out.append({"role": "system", "content": req.system})
        elif isinstance(req.system, list):
            text_parts = [b.get("text", "") for b in req.system if isinstance(b, dict) and b.get("type") == "text"]
            out.append({"role": "system", "content": "\n".join(text_parts)})

    for msg in req.messages:
        out.extend(_convert_message(msg))

    return out


def _convert_message(msg: CanonicalMessage) -> list[dict[str, Any]]:
    if isinstance(msg.content, str):
        return [{"role": msg.role, "content": msg.content}]

    if msg.role == "assistant":
        return _convert_assistant_blocks(msg.content)

    if msg.role == "user":
        return _convert_user_blocks(msg.content)

    return [{"role": msg.role, "content": ""}]


def _convert_assistant_blocks(blocks: list[ContentBlock]) -> list[dict[str, Any]]:
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []

    for block in blocks:
        if isinstance(block, TextBlock):
            text_parts.append(block.text)
        elif isinstance(block, ToolUseBlock):
            tool_calls.append({
                "id": block.id,
                "type": "function",
                "function": {
                    "name": block.name,
                    "arguments": json.dumps(block.input),
                },
            })

    msg: dict[str, Any] = {"role": "assistant"}
    content = "\n".join(text_parts) if text_parts else None
    msg["content"] = content
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return [msg]


def _convert_user_blocks(blocks: list[ContentBlock]) -> list[dict[str, Any]]:
    """Convert user-role content blocks.

    Tool results become separate ``tool`` role messages (OpenAI convention).
    All other blocks become multipart content on a single user message.
    """
    results: list[dict[str, Any]] = []
    other_parts: list[dict[str, Any]] = []

    for block in blocks:
        if isinstance(block, ToolResultBlock):
            content = block.content if isinstance(block.content, str) else json.dumps(block.content)
            results.append({
                "role": "tool",
                "tool_call_id": block.tool_use_id,
                "content": content,
            })
        elif isinstance(block, TextBlock):
            other_parts.append({"type": "text", "text": block.text})

    out: list[dict[str, Any]] = []
    if results:
        out.extend(results)
    if other_parts:
        if len(other_parts) == 1 and other_parts[0].get("type") == "text":
            out.append({"role": "user", "content": other_parts[0]["text"]})
        else:
            out.append({"role": "user", "content": other_parts})
    if not out:
        out.append({"role": "user", "content": ""})
    return out


def _tool_to_openai(tool: CanonicalToolDef) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.input_schema,
        },
    }


def _tool_choice_to_openai(tc: dict[str, Any]) -> str | dict[str, Any]:
    tc_type = tc.get("type", "auto")
    if tc_type == "auto":
        return "auto"
    if tc_type == "none":
        return "none"
    if tc_type == "any":
        return "required"
    if tc_type == "tool":
        return {"type": "function", "function": {"name": tc.get("name", "")}}
    return "auto"


# ---------------------------------------------------------------------------
# OpenAI response → CanonicalResponse (non-streaming)
# ---------------------------------------------------------------------------


def openai_response_to_canonical(
    raw: dict[str, Any],
    *,
    model_override: str | None = None,
) -> CanonicalResponse:
    msg_id = raw.get("id", "")
    model = model_override or raw.get("model", "")

    choices = raw.get("choices", [])
    blocks: list[ContentBlock] = []
    stop_reason = StopReason.END_TURN

    if choices:
        choice = choices[0]
        message = choice.get("message", {})
        fr = choice.get("finish_reason", "stop")

        content_text = message.get("content")
        if content_text:
            blocks.append(TextBlock(text=content_text))

        tool_calls = message.get("tool_calls")
        if tool_calls:
            for tc in tool_calls:
                fn = tc.get("function", {})
                try:
                    inp = json.loads(fn.get("arguments", "{}"))
                except json.JSONDecodeError:
                    inp = {}
                blocks.append(ToolUseBlock(
                    id=tc.get("id", ""),
                    name=fn.get("name", ""),
                    input=inp,
                ))

        stop_reason = _map_finish_reason(fr)

    usage_raw = raw.get("usage", {})
    usage = Usage(
        input_tokens=usage_raw.get("prompt_tokens", 0),
        output_tokens=usage_raw.get("completion_tokens", 0),
        cache_read_input_tokens=usage_raw.get("prompt_tokens_details", {}).get("cached_tokens", 0),
    )

    return CanonicalResponse(
        id=msg_id,
        model=model,
        content=blocks,
        stop_reason=stop_reason,
        usage=usage,
    )


def _map_finish_reason(fr: str) -> StopReason:
    mapping = {
        "stop": StopReason.END_TURN,
        "tool_calls": StopReason.TOOL_USE,
        "length": StopReason.MAX_TOKENS,
        "content_filter": StopReason.END_TURN,
    }
    return mapping.get(fr, StopReason.END_TURN)


# ---------------------------------------------------------------------------
# OpenAI streaming chunk → partial canonical content (for building SSE)
# ---------------------------------------------------------------------------


def openai_stream_delta_to_blocks(
    delta: dict[str, Any],
    finish_reason: str | None,
) -> tuple[list[ContentBlock], StopReason | None]:
    """Extract content blocks from a single OpenAI streaming delta.

    Returns (blocks, stop_reason_or_none).
    """
    blocks: list[ContentBlock] = []
    sr: StopReason | None = None

    content = delta.get("content")
    if content:
        blocks.append(TextBlock(text=content))

    tool_calls = delta.get("tool_calls")
    if tool_calls:
        for tc in tool_calls:
            fn = tc.get("function", {})
            args_str = fn.get("arguments", "")
            try:
                inp = json.loads(args_str) if args_str and args_str.strip().endswith("}") else {}
            except json.JSONDecodeError:
                inp = {}
            if fn.get("name"):
                blocks.append(ToolUseBlock(
                    id=tc.get("id", ""),
                    name=fn.get("name", ""),
                    input=inp,
                ))

    if finish_reason:
        sr = _map_finish_reason(finish_reason)

    return blocks, sr
