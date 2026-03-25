"""Multi-signal detector for Claude Code / Anthropic-style traffic.

Detection precedence (checked in order, first match wins):
  1. Explicit configured route or compatibility flag
  2. anthropic-version header present
  3. Claude Messages API request shape (top-level ``max_tokens`` + ``messages``
     without OpenAI ``choices``/``n`` keys)
  4. Claude-style model IDs (``claude-*`` or configured custom IDs)
  5. Claude-style tools using ``input_schema`` instead of ``function.parameters``

We intentionally do NOT rely primarily on User-Agent.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from starlette.requests import Request

logger = logging.getLogger("yarn.compat.detect")

_CLAUDE_MODEL_RE = re.compile(r"^claude-", re.IGNORECASE)


class ProtocolKind(str, Enum):
    ANTHROPIC_MESSAGES = "anthropic_messages"
    OPENAI_CHAT = "openai_chat"


@dataclass(frozen=True)
class DetectionResult:
    """Outcome of running the detection pipeline on a single request."""

    protocol: ProtocolKind
    signal: str  # human-readable name of the signal that matched
    anthropic_version: str | None = None
    anthropic_beta: str | None = None


@dataclass
class ClaudeCompatConfig:
    """Runtime-configurable knobs for Claude compatibility detection.

    Populated from ``Settings`` at startup; hot-reloadable fields use
    mutable defaults so the detector can pick up changes without restart.
    """

    enabled: bool = False
    custom_model_ids: set[str] = field(default_factory=set)
    model_overrides: dict[str, str] = field(default_factory=dict)
    tool_search_mode: str = "disable"  # "passthrough" | "disable"

    def is_known_claude_model(self, model_id: str) -> bool:
        if _CLAUDE_MODEL_RE.match(model_id):
            return True
        return model_id in self.custom_model_ids or model_id in self.model_overrides

    def resolve_model(self, model_id: str) -> str:
        """Map a Claude/custom model ID to the downstream provider ID."""
        return self.model_overrides.get(model_id, model_id)


# ---------------------------------------------------------------------------
# Detection pipeline
# ---------------------------------------------------------------------------


def detect_claude_request(
    request: Request,
    body: dict[str, Any] | None,
    config: ClaudeCompatConfig,
) -> DetectionResult:
    """Run ordered detection signals and return the first match.

    ``body`` may be *None* when detection is called before body parsing
    (e.g. on a route that unconditionally serves Anthropic semantics).
    """
    av = _extract_anthropic_version(request.headers)
    ab = request.headers.get("anthropic-beta")

    # 1. Explicit flag
    if config.enabled:
        return DetectionResult(
            protocol=ProtocolKind.ANTHROPIC_MESSAGES,
            signal="explicit_config_flag",
            anthropic_version=av,
            anthropic_beta=ab,
        )

    # 2. anthropic-version header
    if av:
        return DetectionResult(
            protocol=ProtocolKind.ANTHROPIC_MESSAGES,
            signal="anthropic_version_header",
            anthropic_version=av,
            anthropic_beta=ab,
        )

    if body is not None:
        # 3. Claude Messages API shape: top-level ``max_tokens`` without
        #    OpenAI-specific keys (``n``, ``frequency_penalty``, ``logprobs``).
        if _looks_like_messages_shape(body):
            return DetectionResult(
                protocol=ProtocolKind.ANTHROPIC_MESSAGES,
                signal="messages_request_shape",
                anthropic_version=av,
                anthropic_beta=ab,
            )

        # 4. Claude-style model ID
        model = body.get("model", "")
        if isinstance(model, str) and config.is_known_claude_model(model):
            return DetectionResult(
                protocol=ProtocolKind.ANTHROPIC_MESSAGES,
                signal="claude_model_id",
                anthropic_version=av,
                anthropic_beta=ab,
            )

        # 5. Tools with ``input_schema`` (Anthropic) vs ``function.parameters`` (OpenAI)
        if _has_input_schema_tools(body):
            return DetectionResult(
                protocol=ProtocolKind.ANTHROPIC_MESSAGES,
                signal="input_schema_tools",
                anthropic_version=av,
                anthropic_beta=ab,
            )

    return DetectionResult(protocol=ProtocolKind.OPENAI_CHAT, signal="default")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _extract_anthropic_version(headers: Mapping[str, str]) -> str | None:
    val = headers.get("anthropic-version") or headers.get("Anthropic-Version")
    return val if val else None


def _looks_like_messages_shape(body: dict[str, Any]) -> bool:
    """Heuristic: the body looks like Anthropic Messages, not OpenAI Chat."""
    if "messages" not in body:
        return False
    has_anthropic_keys = "max_tokens" in body and "model" in body
    has_openai_keys = any(k in body for k in ("n", "frequency_penalty", "logprobs", "logit_bias"))
    if has_anthropic_keys and not has_openai_keys:
        msgs = body.get("messages", [])
        if msgs and isinstance(msgs, list) and isinstance(msgs[0], dict):
            first = msgs[0]
            content = first.get("content")
            if isinstance(content, list) and content:
                block = content[0]
                if isinstance(block, dict) and block.get("type") in ("text", "image", "tool_use", "tool_result"):
                    return True
    return False


def _has_input_schema_tools(body: dict[str, Any]) -> bool:
    """Check if any tool definition uses Anthropic's ``input_schema`` key."""
    tools = body.get("tools")
    if not isinstance(tools, list):
        return False
    for tool in tools:
        if isinstance(tool, dict) and "input_schema" in tool:
            return True
    return False
