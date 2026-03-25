"""POST /v1/messages — Claude Messages API endpoint for Synesis Yarn.

This module implements the Anthropic Messages API surface, preserving Claude
semantics end-to-end and only converting to OpenAI at the provider boundary.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse

from ..middleware.auth import extract_bearer_token, resolve_auth
from ..model import executor as model_executor
from ..model.stream_handler import ToolCallAccumulator
from ..model.tiers import TierRegistry
from ..model.usage_tracker import UsageRecord
from .canonical import CanonicalRequest, TextBlock, ToolUseBlock, Usage
from .claude_adapter import (
    build_content_block_delta,
    build_content_block_start,
    build_content_block_stop,
    build_error_event,
    build_message_delta,
    build_message_start_event,
    build_message_stop,
    build_ping_event,
    canonical_to_claude_response,
    claude_body_to_canonical,
    generate_message_id,
)
from .claude_detect import ClaudeCompatConfig
from .openai_bridge import (
    canonical_to_openai_payload,
    openai_response_to_canonical,
)
from .tool_search_policy import apply_tool_search_policy

logger = logging.getLogger("yarn.compat.messages")


def _claude_error(status_code: int, error_type: str, message: str) -> JSONResponse:
    """Return a Claude-style error envelope."""
    return JSONResponse(
        status_code=status_code,
        content={"type": "error", "error": {"type": error_type, "message": message}},
    )


def _validate_anthropic_version(version: str | None) -> str | None:
    """Validate the anthropic-version header; return error message or None."""
    if not version:
        return "Missing required header: anthropic-version"
    if not version.startswith("20"):
        return f"Invalid anthropic-version: {version}"
    return None


async def handle_messages(
    request: Request,
    compat_config: ClaudeCompatConfig,
    registry: TierRegistry,
) -> JSONResponse | StreamingResponse:
    """Main handler for ``POST /v1/messages``."""
    request_id = f"msg-{uuid.uuid4().hex[:12]}"
    start_time = time.monotonic()

    await resolve_auth(request)
    _ = extract_bearer_token(request)

    try:
        body = await request.json()
    except Exception:
        return _claude_error(400, "invalid_request_error", "Invalid JSON body")

    av = request.headers.get("anthropic-version")
    ab = request.headers.get("anthropic-beta")

    version_err = _validate_anthropic_version(av)
    if version_err:
        logger.warning("anthropic-version validation failed: %s", version_err)
        return _claude_error(400, "invalid_request_error", version_err)

    if "model" not in body:
        return _claude_error(400, "invalid_request_error", "Missing required field: model")
    if "max_tokens" not in body:
        return _claude_error(400, "invalid_request_error", "Missing required field: max_tokens")
    if "messages" not in body or not isinstance(body.get("messages"), list):
        return _claude_error(400, "invalid_request_error", "Missing required field: messages")

    # --- Resolve tier from Claude model ID ---
    client_model = body.get("model", "")
    try:
        tier = registry.resolve_claude(client_model)
    except ValueError as exc:
        return _claude_error(400, "invalid_request_error", str(exc))

    logger.info(
        "claude_messages_inbound",
        extra={
            "request_id": request_id,
            "model": client_model,
            "tier": tier.name,
            "message_count": len(body.get("messages", [])),
            "has_tools": bool(body.get("tools")),
            "has_thinking": bool(body.get("thinking")),
            "stream": body.get("stream", False),
            "anthropic_version": av,
            "anthropic_beta": ab,
        },
    )

    canonical = claude_body_to_canonical(body, anthropic_version=av, anthropic_beta=ab)
    canonical.model = tier.backend_model

    if canonical.tools:
        raw_tools = [
            {"name": t.name, "input_schema": t.input_schema, "description": t.description,
             **({"defer_loading": True} if t.defer_loading else {}),
             **({"cache_control": t.cache_control} if t.cache_control else {})}
            for t in canonical.tools
        ]
        apply_tool_search_policy(
            raw_tools, mode=compat_config.tool_search_mode, request_id=request_id,
        )

    openai_payload = canonical_to_openai_payload(canonical)

    if canonical.stream:
        return StreamingResponse(
            _stream_claude_response(
                tier=tier,
                canonical=canonical,
                openai_payload=openai_payload,
                request_id=request_id,
                original_model=client_model,
                start_time=start_time,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Request-Id": request_id,
            },
        )

    return await _non_stream_response(
        tier=tier,
        canonical=canonical,
        openai_payload=openai_payload,
        request_id=request_id,
        original_model=client_model,
        start_time=start_time,
    )


# ---------------------------------------------------------------------------
# Non-streaming
# ---------------------------------------------------------------------------


async def _non_stream_response(
    tier: Any,
    canonical: CanonicalRequest,
    openai_payload: dict[str, Any],
    request_id: str,
    original_model: str,
    start_time: float,
) -> JSONResponse:
    from ..model import providers

    try:
        result = await providers.chat(
            tier,
            openai_payload["messages"],
            openai_payload.get("tools"),
            temperature=openai_payload.get("temperature"),
            max_tokens=openai_payload.get("max_tokens"),
            tool_choice=openai_payload.get("tool_choice"),
        )
    except Exception as exc:
        logger.exception("Provider call failed for %s", request_id)
        return _claude_error(502, "api_error", f"Upstream provider error: {exc}")

    canonical_resp = openai_response_to_canonical(result, model_override=original_model)
    if not canonical_resp.id:
        canonical_resp.id = generate_message_id()

    claude_resp = canonical_to_claude_response(canonical_resp)

    elapsed = time.monotonic() - start_time
    logger.info(
        "claude_messages_response",
        extra={
            "request_id": request_id,
            "elapsed_ms": round(elapsed * 1000),
            "stop_reason": claude_resp.get("stop_reason"),
            "output_tokens": claude_resp.get("usage", {}).get("output_tokens", 0),
        },
    )

    return JSONResponse(content=claude_resp)


# ---------------------------------------------------------------------------
# Streaming
# ---------------------------------------------------------------------------


async def _stream_claude_response(
    tier: Any,
    canonical: CanonicalRequest,
    openai_payload: dict[str, Any],
    request_id: str,
    original_model: str,
    start_time: float,
):
    """Stream upstream OpenAI SSE, re-frame as Claude Messages SSE events."""
    msg_id = generate_message_id()
    usage = Usage()
    block_index = 0
    active_text_block = False
    active_tool_block = False
    tool_accumulator = ToolCallAccumulator()
    accumulated_tool_json: dict[int, str] = {}

    yield build_message_start_event(msg_id, original_model, usage)
    yield build_ping_event()

    stop_reason = "end_turn"

    try:
        async for chunk in model_executor.run_model(
            tier,
            openai_payload["messages"],
            openai_payload.get("tools"),
            temperature=openai_payload.get("temperature"),
            max_tokens=openai_payload.get("max_tokens"),
            tool_choice=openai_payload.get("tool_choice"),
        ):
            if chunk.content:
                if not active_text_block:
                    yield build_content_block_start(block_index, TextBlock(text=""))
                    active_text_block = True

                yield build_content_block_delta(
                    block_index,
                    {"type": "text_delta", "text": chunk.content},
                )

            if chunk.tool_calls:
                if active_text_block:
                    yield build_content_block_stop(block_index)
                    block_index += 1
                    active_text_block = False

                tool_accumulator.feed(chunk.tool_calls)
                for tc in chunk.tool_calls:
                    tc_idx = tc.get("index", 0)
                    tc_id = tc.get("id", "")
                    fn = tc.get("function", {})
                    fn_name = fn.get("name", "")
                    fn_args = fn.get("arguments", "")

                    if tc_id and fn_name:
                        yield build_content_block_start(
                            block_index,
                            ToolUseBlock(id=tc_id, name=fn_name, input={}),
                        )
                        active_tool_block = True
                        accumulated_tool_json[tc_idx] = ""

                    if fn_args and tc_idx in accumulated_tool_json:
                        accumulated_tool_json[tc_idx] += fn_args
                        yield build_content_block_delta(
                            block_index,
                            {"type": "input_json_delta", "partial_json": fn_args},
                        )

            if chunk.finish_reason:
                if chunk.finish_reason == "tool_calls":
                    stop_reason = "tool_use"
                    tool_accumulator.flush()
                    if active_tool_block:
                        yield build_content_block_stop(block_index)
                        block_index += 1
                        active_tool_block = False
                elif chunk.finish_reason == "stop":
                    stop_reason = "end_turn"
                elif chunk.finish_reason == "length":
                    stop_reason = "max_tokens"

            if chunk.raw.get("_usage_record"):
                rec: UsageRecord = chunk.raw["_usage_record"]
                usage.input_tokens += rec.tokens_in
                usage.output_tokens += rec.tokens_out

            raw_usage = chunk.raw.get("usage") or (chunk.usage if isinstance(chunk.usage, dict) else None)
            if raw_usage and isinstance(raw_usage, dict):
                usage.input_tokens = raw_usage.get("prompt_tokens", usage.input_tokens)
                usage.output_tokens = raw_usage.get("completion_tokens", usage.output_tokens)

    except Exception as exc:
        logger.exception("Stream error for %s", request_id)
        yield build_error_event("api_error", str(exc))
        return

    if active_text_block:
        yield build_content_block_stop(block_index)
    if active_tool_block:
        yield build_content_block_stop(block_index)

    yield build_message_delta(stop_reason, usage)
    yield build_message_stop()

    elapsed = time.monotonic() - start_time
    logger.info(
        "claude_messages_stream_done",
        extra={
            "request_id": request_id,
            "elapsed_ms": round(elapsed * 1000),
            "stop_reason": stop_reason,
            "output_tokens": usage.output_tokens,
        },
    )
