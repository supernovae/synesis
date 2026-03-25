"""Regression tests for Claude Code / Anthropic Messages compatibility layer.

Covers:
  - Detection precedence (5 ordered signals)
  - Claude Messages inbound → canonical → OpenAI bridge round-trip
  - Claude SSE event builder helpers
  - Non-streaming /v1/messages responses
  - Streaming /v1/messages event order
  - Tool use roundtrips (input_schema, tool_use, tool_result, tool_choice)
  - Custom model IDs and modelOverrides-style mapping
  - Missing / malformed anthropic-version handling
  - MCP tool-search policy modes
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from starlette.datastructures import Headers
from starlette.requests import Request

from app.compat.canonical import (
    CanonicalRequest,
    CanonicalResponse,
    CanonicalToolDef,
    StopReason,
    TextBlock,
    ToolUseBlock,
    Usage,
)
from app.compat.claude_adapter import (
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
from app.compat.claude_detect import (
    ClaudeCompatConfig,
    DetectionResult,
    ProtocolKind,
    detect_claude_request,
)
from app.compat.openai_bridge import (
    canonical_to_openai_payload,
    openai_response_to_canonical,
)
from app.compat.tool_search_policy import apply_tool_search_policy

FIXTURES = Path(__file__).parent / "fixtures" / "claude_code"


def _load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text())


def _make_request(headers: dict[str, str] | None = None) -> Request:
    scope: dict[str, Any] = {
        "type": "http",
        "method": "POST",
        "path": "/v1/messages",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
    }
    return Request(scope)


# ============================================================================
# Detection module tests
# ============================================================================


class TestDetectionPrecedence:
    """Ordered multi-signal detection — first match wins."""

    def test_signal_1_explicit_config_flag(self):
        config = ClaudeCompatConfig(enabled=True)
        req = _make_request()
        result = detect_claude_request(req, None, config)
        assert result.protocol == ProtocolKind.ANTHROPIC_MESSAGES
        assert result.signal == "explicit_config_flag"

    def test_signal_2_anthropic_version_header(self):
        config = ClaudeCompatConfig()
        req = _make_request({"anthropic-version": "2023-06-01"})
        result = detect_claude_request(req, None, config)
        assert result.protocol == ProtocolKind.ANTHROPIC_MESSAGES
        assert result.signal == "anthropic_version_header"
        assert result.anthropic_version == "2023-06-01"

    def test_signal_3_messages_request_shape(self):
        config = ClaudeCompatConfig()
        req = _make_request()
        body = {
            "model": "synesis-yarn",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        }
        result = detect_claude_request(req, body, config)
        assert result.protocol == ProtocolKind.ANTHROPIC_MESSAGES
        assert result.signal == "messages_request_shape"

    def test_signal_4_claude_model_id(self):
        config = ClaudeCompatConfig()
        req = _make_request()
        body = {"model": "claude-opus-4-6", "messages": []}
        result = detect_claude_request(req, body, config)
        assert result.protocol == ProtocolKind.ANTHROPIC_MESSAGES
        assert result.signal == "claude_model_id"

    def test_signal_4_custom_model_id(self):
        config = ClaudeCompatConfig(custom_model_ids={"my-gateway/claude-opus-4-6"})
        req = _make_request()
        body = {"model": "my-gateway/claude-opus-4-6", "messages": []}
        result = detect_claude_request(req, body, config)
        assert result.protocol == ProtocolKind.ANTHROPIC_MESSAGES
        assert result.signal == "claude_model_id"

    def test_signal_5_input_schema_tools(self):
        config = ClaudeCompatConfig()
        req = _make_request()
        body = {
            "model": "synesis-yarn",
            "messages": [],
            "tools": [{"name": "test", "input_schema": {"type": "object"}}],
        }
        result = detect_claude_request(req, body, config)
        assert result.protocol == ProtocolKind.ANTHROPIC_MESSAGES
        assert result.signal == "input_schema_tools"

    def test_default_openai(self):
        config = ClaudeCompatConfig()
        req = _make_request()
        body = {"model": "synesis-yarn", "messages": [{"role": "user", "content": "hi"}]}
        result = detect_claude_request(req, body, config)
        assert result.protocol == ProtocolKind.OPENAI_CHAT
        assert result.signal == "default"

    def test_anthropic_beta_preserved(self):
        config = ClaudeCompatConfig()
        req = _make_request({
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "interleaved-thinking-2025-05-14",
        })
        result = detect_claude_request(req, None, config)
        assert result.anthropic_beta == "interleaved-thinking-2025-05-14"


class TestClaudeCompatConfig:
    def test_is_known_claude_model_builtin(self):
        config = ClaudeCompatConfig()
        assert config.is_known_claude_model("claude-opus-4-6")
        assert config.is_known_claude_model("claude-sonnet-4-6")
        assert not config.is_known_claude_model("gpt-4")

    def test_is_known_claude_model_custom(self):
        config = ClaudeCompatConfig(custom_model_ids={"my-model"})
        assert config.is_known_claude_model("my-model")

    def test_resolve_model_with_override(self):
        config = ClaudeCompatConfig(model_overrides={
            "claude-opus-4-6": "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
        })
        assert config.resolve_model("claude-opus-4-6") == "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo"
        assert config.resolve_model("claude-sonnet-4-6") == "claude-sonnet-4-6"


# ============================================================================
# Claude adapter tests — inbound
# ============================================================================


class TestClaudeInboundAdapter:
    def test_simple_text_message(self):
        body = _load_fixture("non_streaming_request.json")
        canonical = claude_body_to_canonical(body, anthropic_version="2023-06-01")
        assert canonical.model == "claude-opus-4-6"
        assert canonical.max_tokens == 1024
        assert len(canonical.messages) == 1
        assert canonical.messages[0].role == "user"
        assert canonical.messages[0].content == "What is the capital of France?"
        assert canonical.anthropic_version == "2023-06-01"

    def test_tool_definitions_parsed(self):
        body = _load_fixture("tool_use_request.json")
        canonical = claude_body_to_canonical(body)
        assert canonical.tools is not None
        assert len(canonical.tools) == 1
        tool = canonical.tools[0]
        assert tool.name == "get_weather"
        assert "location" in tool.input_schema.get("properties", {})

    def test_multipart_tool_result(self):
        body = _load_fixture("tool_result_multipart.json")
        canonical = claude_body_to_canonical(body)
        assert len(canonical.messages) == 3
        # assistant message has content blocks
        assistant = canonical.messages[1]
        assert isinstance(assistant.content, list)
        assert len(assistant.content) == 2
        assert isinstance(assistant.content[0], TextBlock)
        assert isinstance(assistant.content[1], ToolUseBlock)
        # user message with tool_result
        user_tr = canonical.messages[2]
        assert isinstance(user_tr.content, list)

    def test_thinking_preserved(self):
        body = _load_fixture("thinking_request.json")
        canonical = claude_body_to_canonical(body)
        assert canonical.thinking is not None
        assert canonical.thinking["type"] == "enabled"
        assert canonical.thinking["budget_tokens"] == 10000

    def test_stream_flag(self):
        body = _load_fixture("streaming_request.json")
        canonical = claude_body_to_canonical(body)
        assert canonical.stream is True


# ============================================================================
# OpenAI bridge tests
# ============================================================================


class TestOpenAIBridge:
    def test_canonical_to_openai_payload_basic(self):
        body = _load_fixture("non_streaming_request.json")
        canonical = claude_body_to_canonical(body)
        payload = canonical_to_openai_payload(canonical)
        assert payload["model"] == "claude-opus-4-6"
        assert payload["max_tokens"] == 1024
        assert payload["stream"] is False
        msgs = payload["messages"]
        assert len(msgs) == 1
        assert msgs[0]["role"] == "user"
        assert msgs[0]["content"] == "What is the capital of France?"

    def test_tools_converted_to_function_parameters(self):
        body = _load_fixture("tool_use_request.json")
        canonical = claude_body_to_canonical(body)
        payload = canonical_to_openai_payload(canonical)
        assert "tools" in payload
        tool = payload["tools"][0]
        assert tool["type"] == "function"
        assert "parameters" in tool["function"]
        assert "input_schema" not in tool["function"]

    def test_tool_result_becomes_tool_role(self):
        body = _load_fixture("tool_result_multipart.json")
        canonical = claude_body_to_canonical(body)
        payload = canonical_to_openai_payload(canonical)
        msgs = payload["messages"]
        tool_msgs = [m for m in msgs if m.get("role") == "tool"]
        assert len(tool_msgs) == 1
        assert tool_msgs[0]["tool_call_id"] == "toolu_01abc"

    def test_tool_choice_mapping(self):
        from app.compat.openai_bridge import _tool_choice_to_openai
        assert _tool_choice_to_openai({"type": "auto"}) == "auto"
        assert _tool_choice_to_openai({"type": "none"}) == "none"
        assert _tool_choice_to_openai({"type": "any"}) == "required"
        result = _tool_choice_to_openai({"type": "tool", "name": "get_weather"})
        assert result == {"type": "function", "function": {"name": "get_weather"}}

    def test_openai_response_to_canonical(self):
        raw = {
            "id": "chatcmpl-123",
            "model": "qwen",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "Paris is the capital."},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 6, "total_tokens": 16},
        }
        resp = openai_response_to_canonical(raw, model_override="claude-opus-4-6")
        assert resp.model == "claude-opus-4-6"
        assert resp.stop_reason == StopReason.END_TURN
        assert len(resp.content) == 1
        assert isinstance(resp.content[0], TextBlock)
        assert resp.content[0].text == "Paris is the capital."
        assert resp.usage.input_tokens == 10
        assert resp.usage.output_tokens == 6

    def test_openai_response_tool_calls(self):
        raw = {
            "id": "chatcmpl-456",
            "model": "qwen",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "tc_1",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": '{"location":"SF"}'},
                    }],
                },
                "finish_reason": "tool_calls",
            }],
            "usage": {"prompt_tokens": 20, "completion_tokens": 10},
        }
        resp = openai_response_to_canonical(raw)
        assert resp.stop_reason == StopReason.TOOL_USE
        assert len(resp.content) == 1
        assert isinstance(resp.content[0], ToolUseBlock)
        assert resp.content[0].name == "get_weather"
        assert resp.content[0].input == {"location": "SF"}


# ============================================================================
# Claude adapter tests — outbound (response + SSE)
# ============================================================================


class TestClaudeOutboundAdapter:
    def test_canonical_to_claude_response(self):
        resp = CanonicalResponse(
            id="msg_test123",
            model="claude-opus-4-6",
            content=[TextBlock(text="The capital is Paris.")],
            stop_reason=StopReason.END_TURN,
            usage=Usage(input_tokens=10, output_tokens=6),
        )
        out = canonical_to_claude_response(resp)
        assert out["type"] == "message"
        assert out["id"] == "msg_test123"
        assert out["model"] == "claude-opus-4-6"
        assert out["stop_reason"] == "end_turn"
        assert len(out["content"]) == 1
        assert out["content"][0]["type"] == "text"
        assert out["usage"]["input_tokens"] == 10

    def test_tool_use_response(self):
        resp = CanonicalResponse(
            id="msg_test456",
            model="claude-opus-4-6",
            content=[
                TextBlock(text="Let me check."),
                ToolUseBlock(id="toolu_01", name="get_weather", input={"location": "SF"}),
            ],
            stop_reason=StopReason.TOOL_USE,
            usage=Usage(input_tokens=20, output_tokens=15),
        )
        out = canonical_to_claude_response(resp)
        assert out["stop_reason"] == "tool_use"
        assert len(out["content"]) == 2
        assert out["content"][1]["type"] == "tool_use"
        assert out["content"][1]["name"] == "get_weather"


class TestClaudeSSEBuilders:
    def test_message_start(self):
        event = build_message_start_event("msg_1", "claude-opus-4-6", Usage(input_tokens=10))
        assert "event: message_start" in event
        data = json.loads(event.split("data: ")[1])
        assert data["type"] == "message_start"
        assert data["message"]["id"] == "msg_1"
        assert data["message"]["model"] == "claude-opus-4-6"

    def test_ping(self):
        event = build_ping_event()
        assert "event: ping" in event

    def test_content_block_start_text(self):
        event = build_content_block_start(0, TextBlock(text=""))
        data = json.loads(event.split("data: ")[1])
        assert data["type"] == "content_block_start"
        assert data["index"] == 0
        assert data["content_block"]["type"] == "text"

    def test_content_block_start_tool(self):
        event = build_content_block_start(1, ToolUseBlock(id="t1", name="test", input={}))
        data = json.loads(event.split("data: ")[1])
        assert data["content_block"]["type"] == "tool_use"
        assert data["content_block"]["name"] == "test"

    def test_content_block_delta(self):
        event = build_content_block_delta(0, {"type": "text_delta", "text": "Hello"})
        data = json.loads(event.split("data: ")[1])
        assert data["type"] == "content_block_delta"
        assert data["delta"]["text"] == "Hello"

    def test_content_block_stop(self):
        event = build_content_block_stop(0)
        data = json.loads(event.split("data: ")[1])
        assert data["type"] == "content_block_stop"

    def test_message_delta(self):
        event = build_message_delta("end_turn", Usage(output_tokens=42))
        data = json.loads(event.split("data: ")[1])
        assert data["type"] == "message_delta"
        assert data["delta"]["stop_reason"] == "end_turn"
        assert data["usage"]["output_tokens"] == 42

    def test_message_stop(self):
        event = build_message_stop()
        assert "event: message_stop" in event

    def test_error_event(self):
        event = build_error_event("overloaded_error", "Too many requests")
        data = json.loads(event.split("data: ")[1])
        assert data["type"] == "error"
        assert data["error"]["type"] == "overloaded_error"


class TestMessageIdGeneration:
    def test_format(self):
        mid = generate_message_id()
        assert mid.startswith("msg_")
        assert len(mid) == 28  # "msg_" + 24 hex chars


# ============================================================================
# Model override tests
# ============================================================================


class TestModelOverrides:
    def test_override_applied_in_payload(self):
        config = ClaudeCompatConfig(model_overrides={
            "claude-opus-4-6": "Qwen/Qwen3-Coder",
        })
        body = _load_fixture("non_streaming_request.json")
        canonical = claude_body_to_canonical(body)
        canonical.model = config.resolve_model(canonical.model)
        payload = canonical_to_openai_payload(canonical)
        assert payload["model"] == "Qwen/Qwen3-Coder"

    def test_unknown_model_passes_through(self):
        config = ClaudeCompatConfig(custom_model_ids={"my-custom-model"})
        assert config.is_known_claude_model("my-custom-model")
        assert config.resolve_model("my-custom-model") == "my-custom-model"

    def test_custom_model_from_fixture(self):
        body = _load_fixture("custom_model_request.json")
        config = ClaudeCompatConfig(custom_model_ids={"my-gateway/claude-opus-4-6"})
        canonical = claude_body_to_canonical(body)
        assert config.is_known_claude_model(canonical.model)


# ============================================================================
# Tool search policy tests
# ============================================================================


class TestToolSearchPolicy:
    def test_disable_strips_defer_loading(self):
        tools = [
            {"name": "a", "input_schema": {}, "defer_loading": True},
            {"name": "b", "input_schema": {}},
        ]
        result = apply_tool_search_policy(tools, mode="disable", request_id="test")
        assert result is not None
        assert len(result) == 2
        assert "defer_loading" not in result[0]
        assert "defer_loading" not in result[1]

    def test_disable_strips_tool_references(self):
        tools = [
            {"name": "a", "content": [
                {"type": "tool_reference", "tool_name": "x"},
                {"type": "text", "text": "keep"},
            ]},
        ]
        result = apply_tool_search_policy(tools, mode="disable")
        assert result is not None
        content = result[0]["content"]
        assert len(content) == 1
        assert content[0]["type"] == "text"

    def test_passthrough_preserves_all(self):
        tools = [
            {"name": "a", "input_schema": {}, "defer_loading": True},
            {"name": "b", "content": [{"type": "tool_reference", "tool_name": "x"}]},
        ]
        result = apply_tool_search_policy(tools, mode="passthrough")
        assert result is not None
        assert result[0].get("defer_loading") is True
        assert result[1]["content"][0]["type"] == "tool_reference"

    def test_none_tools_returns_none(self):
        assert apply_tool_search_policy(None, mode="disable") is None

    def test_empty_list(self):
        assert apply_tool_search_policy([], mode="disable") == []


# ============================================================================
# anthropic-version handling tests
# ============================================================================


class TestAnthropicVersionHandling:
    def test_valid_version_passes(self):
        from app.compat.messages_endpoint import _validate_anthropic_version
        assert _validate_anthropic_version("2023-06-01") is None

    def test_missing_version_rejected(self):
        from app.compat.messages_endpoint import _validate_anthropic_version
        err = _validate_anthropic_version(None)
        assert err is not None
        assert "Missing" in err

    def test_malformed_version_rejected(self):
        from app.compat.messages_endpoint import _validate_anthropic_version
        err = _validate_anthropic_version("invalid")
        assert err is not None
        assert "Invalid" in err

    def test_future_version_passes(self):
        from app.compat.messages_endpoint import _validate_anthropic_version
        assert _validate_anthropic_version("2025-01-01") is None


# ============================================================================
# Full round-trip: fixture → canonical → openai → canonical → claude response
# ============================================================================


class TestFullRoundTrip:
    def test_non_streaming_roundtrip(self):
        body = _load_fixture("non_streaming_request.json")
        canonical = claude_body_to_canonical(body, anthropic_version="2023-06-01")
        openai_payload = canonical_to_openai_payload(canonical)

        # Simulate provider response
        provider_resp = {
            "id": "chatcmpl-xyz",
            "model": "Qwen/Qwen3-Coder",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "Paris."},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 12, "completion_tokens": 3},
        }
        canonical_resp = openai_response_to_canonical(provider_resp, model_override="claude-opus-4-6")
        claude_resp = canonical_to_claude_response(canonical_resp)

        assert claude_resp["type"] == "message"
        assert claude_resp["model"] == "claude-opus-4-6"
        assert claude_resp["stop_reason"] == "end_turn"
        assert claude_resp["content"][0]["text"] == "Paris."

    def test_tool_use_roundtrip(self):
        body = _load_fixture("tool_use_request.json")
        canonical = claude_body_to_canonical(body)
        openai_payload = canonical_to_openai_payload(canonical)

        assert openai_payload["tools"][0]["function"]["name"] == "get_weather"

        provider_resp = {
            "id": "chatcmpl-tc",
            "model": "qwen",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "Checking weather...",
                    "tool_calls": [{
                        "id": "tc_abc",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": '{"location":"San Francisco, CA"}'},
                    }],
                },
                "finish_reason": "tool_calls",
            }],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20},
        }
        canonical_resp = openai_response_to_canonical(provider_resp, model_override="claude-opus-4-6")
        claude_resp = canonical_to_claude_response(canonical_resp)

        assert claude_resp["stop_reason"] == "tool_use"
        blocks = claude_resp["content"]
        assert blocks[0]["type"] == "text"
        assert blocks[1]["type"] == "tool_use"
        assert blocks[1]["name"] == "get_weather"
        assert blocks[1]["input"]["location"] == "San Francisco, CA"
