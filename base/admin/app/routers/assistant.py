"""Admin LLM assistant — trace analysis, summarization, and review (configurable model)."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from ..auth import CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SESSION_COOKIE_NAME, UserInfo, get_current_user
from ..deps import ASSISTANT_MODEL, INTERNAL_SERVICE_TOKEN, PLANNER_URL
from ..rbac import Role, can_access_trace, resolve_role
from ..services import trace_store
from ..services.admin_mcp_ts_client import (
    invoke_admin_mcp_tool,
    list_admin_mcp_tools,
    openai_function_tools_from_admin_mcp_catalog,
)

logger = logging.getLogger("synesis.admin.assistant")

router = APIRouter(prefix="/api/v1/assistant", tags=["assistant"])

MAX_ASSISTANT_TOOL_ROUNDS = 8

TRACE_UUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")

ADMIN_SYSTEM_PROMPT = """You are the Synesis Admin Assistant. You help operators understand
system behavior, analyze traces, debug issues, and tune configuration.
Be concise and actionable. When analyzing data provided in context,
cite specific numbers and suggest next steps.

You have tools that call the live Admin API (same RBAC as the signed-in user): traces
(including decision analytics), usage/cost summaries and hourly ``usage_time_series``,
``unified_usage_snapshot``, Yarn ops (``yarn_overview``, ``yarn_sessions``, ``yarn_performance``, …),
transition calibration (``yarn_transition_quality``, ``yarn_transition_incident_brief``),
live transition watch/tail (``yarn_transition_watch``, ``yarn_transition_events_tail``),
optimization watcher reports (``yarn_optimization_watcher``, ``yarn_optimization_ai_brief``),
service health, model roles, and (for privileged users) cache metrics, circuit breakers, ingestion, etc.
When the user asks about current costs, usage, health, or live data, call the
appropriate tools instead of guessing. Prefer ``unified_usage_snapshot`` for
cost/spend questions when a broad picture is needed; use ``usage_time_series`` for
trends; use Yarn tools for IDE session utilization and performance.
When debugging transition quality, prefer ``yarn_transition_incident_brief`` first,
then drill into ``yarn_transition_events_tail`` and ``yarn_transition_watch``.
When debugging cache rate or prefix stability, prefer ``yarn_optimization_watcher``
first and use ``yarn_optimization_ai_brief`` when the operator asks for synthesis.
If the prompt contains a trace ID and context includes an Admin MCP get_trace
result, treat that context as live trace data and summarize it directly."""

SUPPORT_SYSTEM_PROMPT = """You are the Synesis Support Assistant. You help authenticated
users with account-safe guidance, usage questions, and product assistance.
You do not perform admin operations, trace analysis, or privileged diagnostics.
Be concise, practical, and explicit about any limits.

When usage or account metrics are needed, call user-safe tools instead of guessing."""

SUPPORT_ALLOWED_TOOL_NAMES = {
    "authz_stats",
    "compaction_metrics",
    "governance_effective",
    "provider_catalog",
    "synesis_search",
    "synesis_classify_intent",
    "synesis_retrieval_gaps",
    "token_fga_explain",
    "yarn_runtime_preferences",
    "yarn_user_usage",
}


class AssistantChatBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(..., min_length=1, max_length=20000)
    context: str = Field("", max_length=200000)
    trace_id: str | None = Field(None, min_length=1, max_length=128)
    span_index: int | None = Field(None, ge=0, le=10000)


def _trace_context_text(trace: dict, span_index: int | None = None) -> str:
    """Build a concise text representation of a trace (or one span) for assistant context."""
    if span_index is not None and 0 <= span_index < len(trace.get("spans") or []):
        span = trace["spans"][span_index]
        parts = [
            f"Span {span_index + 1}: {span.get('intent') or span.get('node_name', '')}",
            f"Latency: {span.get('latency_ms', 0):.0f}ms",
            f"Tokens: {span.get('tokens_used', 0)}",
        ]
        for i, call in enumerate(span.get("llm_calls") or []):
            parts.append(f"\nLLM call {i + 1}: {call.get('model', '')}")
            parts.append(f"  Tokens: {call.get('prompt_tokens', 0)} in / {call.get('completion_tokens', 0)} out")
            if call.get("prompt_full"):
                parts.append(f"  Prompt:\n{call['prompt_full'][:8000]}")
            elif call.get("prompt_snippet"):
                parts.append(f"  Prompt (snippet):\n{call['prompt_snippet']}")
            if call.get("completion_full"):
                parts.append(f"  Completion:\n{call['completion_full'][:8000]}")
            elif call.get("completion_snippet"):
                parts.append(f"  Completion (snippet):\n{call['completion_snippet']}")
        return "\n".join(parts)
    # Full trace summary
    parts = [
        f"Trace {trace.get('trace_id', '')}",
        f"Query: {trace.get('query_snippet', '')}",
        f"Duration: {trace.get('total_duration_ms', 0):.0f}ms, Tokens: {trace.get('total_tokens', 0)}",
        f"Difficulty: {trace.get('difficulty', 0)}, Error: {trace.get('has_error', False)}",
    ]
    if trace.get("phase_timings"):
        parts.append("Phase timings: " + json.dumps(trace["phase_timings"]))
    if trace.get("critic_scores"):
        parts.append("Critic: " + json.dumps(trace["critic_scores"]))
    if trace.get("evidence_summary"):
        parts.append("Evidence: " + json.dumps(trace["evidence_summary"]))
    parts.append("\nSpans:")
    for i, s in enumerate(trace.get("spans") or []):
        intent = s.get("intent") or s.get("node_name", "")
        parts.append(f"  {i + 1}. {intent} — {s.get('latency_ms', 0):.0f}ms, {s.get('tokens_used', 0)} tok")
    return "\n".join(parts)


def _planner_headers(auth_header: str = "", org_headers: dict[str, str] | None = None) -> dict[str, str]:
    h: dict[str, str] = {"Content-Type": "application/json"}
    if auth_header:
        h["Authorization"] = auth_header
    elif INTERNAL_SERVICE_TOKEN:
        h["Authorization"] = f"Bearer {INTERNAL_SERVICE_TOKEN}"
        h["x-synesis-service-token"] = INTERNAL_SERVICE_TOKEN
        h["x-synesis-service-name"] = "synesis-admin"
    if org_headers:
        h.update(org_headers)
    return h


def _message_content_text(msg: dict[str, Any]) -> str | None:
    """Normalize assistant message content (string or multimodal list) to plain text."""
    c = msg.get("content")
    if c is None:
        return None
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts: list[str] = []
        for block in c:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
        return "\n".join(parts) if parts else None
    return str(c)


def _tool_result_error(tool_name: str, reason: str) -> str:
    return json.dumps({"error": "invalid_tool_call", "tool": tool_name, "reason": reason})


def _parse_tool_call_arguments(raw_args: Any) -> tuple[dict[str, Any] | None, str | None]:
    if raw_args is None:
        return {}, None
    try:
        parsed = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
    except json.JSONDecodeError:
        return None, "invalid_json_arguments"
    if parsed is None:
        return {}, None
    if not isinstance(parsed, dict):
        return None, "non_object_arguments"
    return parsed, None


def _tool_schemas_by_name(tools: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for tool in tools:
        if tool.get("type") != "function":
            continue
        fn = tool.get("function")
        if not isinstance(fn, dict):
            continue
        name = fn.get("name")
        parameters = fn.get("parameters")
        if isinstance(name, str) and name.strip() and isinstance(parameters, dict):
            out[name.strip()] = parameters
    return out


def _json_schema_type_matches(value: Any, expected_type: str) -> bool:
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "boolean":
        return isinstance(value, bool)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "object":
        return isinstance(value, dict)
    return False


def _validate_tool_arg_value(key: str, value: Any, schema: dict[str, Any]) -> str | None:
    expected_type = schema.get("type")
    if isinstance(expected_type, list):
        if not any(isinstance(item, str) and _json_schema_type_matches(value, item) for item in expected_type):
            return f"invalid_type:{key}"
    elif isinstance(expected_type, str):
        if not _json_schema_type_matches(value, expected_type):
            return f"invalid_type:{key}"

    enum_values = schema.get("enum")
    if isinstance(enum_values, list) and value not in enum_values:
        return f"invalid_enum:{key}"

    if isinstance(value, list):
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for idx, item in enumerate(value):
                reason = _validate_tool_arg_value(f"{key}.{idx}", item, item_schema)
                if reason:
                    return reason
    if isinstance(value, dict):
        reason = _validate_tool_arguments_against_schema(value, schema, path=key)
        if reason:
            return reason
    return None


def _validate_tool_arguments_against_schema(
    args: dict[str, Any],
    schema: dict[str, Any],
    *,
    path: str = "",
) -> str | None:
    if schema.get("type") != "object":
        return "invalid_tool_schema"
    raw_properties = schema.get("properties")
    properties = raw_properties if isinstance(raw_properties, dict) else {}
    required = {key for key in schema.get("required", []) if isinstance(key, str)}

    for key in args:
        if key not in properties:
            return f"unknown_argument:{path + '.' if path else ''}{key}"
    for key in required:
        if key not in args or args[key] is None:
            return f"missing_required:{path + '.' if path else ''}{key}"
    for key, value in args.items():
        property_schema = properties.get(key)
        if isinstance(property_schema, dict):
            reason = _validate_tool_arg_value(path + "." + key if path else key, value, property_schema)
            if reason:
                return reason
    return None


def _is_trace_id_char(ch: str) -> bool:
    return ch.isalnum() or ch in "._:-"


def _extract_labeled_trace_id(raw: str) -> str | None:
    lower = raw.lower()
    start = lower.find("trace")
    if start < 0:
        return None
    pos = start + len("trace")
    if lower[pos : pos + 3] in {" id", "-id", "_id"}:
        pos += 3
    while pos < len(raw) and (raw[pos].isspace() or raw[pos] in ":=#"):
        pos += 1
    for word in ("for", "is", "of"):
        end = pos + len(word)
        if lower[pos:end] == word and (end >= len(raw) or raw[end].isspace()):
            pos = end
            while pos < len(raw) and raw[pos].isspace():
                pos += 1
            break
    while pos < len(raw) and not raw[pos].isalnum():
        pos += 1
    end = pos
    while end < len(raw) and _is_trace_id_char(raw[end]) and end - pos < 128:
        end += 1
    candidate = raw[pos:end].strip(".,;)'\"`[]{}<>")
    return candidate if len(candidate) >= 8 else None


def _extract_trace_lookup_id(text: str) -> str | None:
    """Extract an explicit trace identifier from operator prompts."""
    raw = (text or "").strip()
    if "trace" not in raw.lower():
        return None
    uuid_match = TRACE_UUID_RE.search(raw)
    if uuid_match:
        return uuid_match.group(0)
    return _extract_labeled_trace_id(raw)


def _trace_lookup_context_from_admin_mcp(trace_id: str, tool_text: str) -> str:
    try:
        payload = json.loads(tool_text)
    except json.JSONDecodeError:
        return f"Admin MCP get_trace returned non-JSON for trace_id={trace_id}:\n{tool_text[:4000]}"

    if isinstance(payload, dict) and payload.get("error"):
        return f"Admin MCP get_trace failed for trace_id={trace_id}: {json.dumps(payload, default=str)[:4000]}"
    if isinstance(payload, dict):
        return (
            "Admin MCP get_trace result for the requested trace. Use this live "
            "trace data as authoritative context:\n"
            f"{_trace_context_text(payload)}"
        )
    return (
        f"Admin MCP get_trace returned an unexpected payload for trace_id={trace_id}:\n"
        f"{json.dumps(payload, default=str)[:4000]}"
    )


async def _load_prompt_trace_context_via_admin_mcp(
    user_message: str,
    auth_header: str,
    org_headers: dict[str, str],
    *,
    session_cookie: str,
    csrf_cookie: str,
    csrf_token: str,
) -> str | None:
    trace_lookup_id = _extract_trace_lookup_id(user_message)
    if not trace_lookup_id:
        return None
    if not (auth_header.lower().startswith("bearer ") or session_cookie):
        return f"Trace ID {trace_lookup_id} was detected, but no delegated admin session was available."

    tool_text = await invoke_admin_mcp_tool(
        auth_header,
        org_headers,
        "get_trace",
        {"trace_id": trace_lookup_id},
        session_cookie=session_cookie,
        csrf_cookie=csrf_cookie,
        csrf_token=csrf_token,
    )
    return _trace_lookup_context_from_admin_mcp(trace_lookup_id, tool_text)


async def _assistant_chat_impl(
    data: AssistantChatBody,
    _user: UserInfo = Depends(get_current_user),
    request: Request | None = None,
    *,
    support_mode: bool,
):
    """Send a message to the LLM. Optionally pass trace_id (and span_index) to load trace as context.

    When the model supports function calling, the assistant runs an MCP tool loop
    (same handlers as Admin MCP / synesis-admin-mcp-ts) under the caller's JWT.
    """
    user_message = data.message
    context = data.context
    trace_id = data.trace_id
    span_index = data.span_index

    auth_header = (request.headers.get("authorization") if request else "") or ""
    session_cookie = (request.cookies.get(SESSION_COOKIE_NAME) if request else "") or ""
    csrf_cookie = (request.cookies.get(CSRF_COOKIE_NAME) if request else "") or ""
    csrf_token = (request.headers.get(CSRF_HEADER_NAME) or request.headers.get("x-csrf-token") or "") if request else ""
    org_headers: dict[str, str] = {}
    if request:
        for header_name in ("x-synesis-org-id", "x-active-org-id"):
            value = (request.headers.get(header_name) or "").strip()
            if value:
                org_headers[header_name] = value

    if trace_id and support_mode:
        context = (context or "") + "\n\n(trace_id context is only available in Admin Assistant mode.)"
    elif trace_id:
        record = await trace_store.get_trace(trace_id)
        if record and not can_access_trace(_user, record):
            record = None
        if record:
            context = _trace_context_text(record, span_index if span_index is not None else None)
        else:
            context = (context or "") + "\n\n(Loaded trace_id not found.)"
    elif not support_mode:
        prompt_trace_context = await _load_prompt_trace_context_via_admin_mcp(
            user_message,
            auth_header,
            org_headers,
            session_cookie=session_cookie,
            csrf_cookie=csrf_cookie,
            csrf_token=csrf_token,
        )
        if prompt_trace_context:
            context = f"{context}\n\n{prompt_trace_context}".strip()
    elif context:
        pass  # use provided context

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SUPPORT_SYSTEM_PROMPT if support_mode else ADMIN_SYSTEM_PROMPT}
    ]
    if context:
        messages.append({"role": "user", "content": f"Context:\n{context}\n\n---\n\n{user_message}"})
    else:
        messages.append({"role": "user", "content": user_message})

    tools = []
    if auth_header.lower().startswith("bearer ") or session_cookie:
        try:
            catalog = await list_admin_mcp_tools(
                auth_header,
                org_headers,
                session_cookie=session_cookie,
                csrf_cookie=csrf_cookie,
                csrf_token=csrf_token,
            )
            tools = openai_function_tools_from_admin_mcp_catalog(
                catalog,
                allowed_tool_names=SUPPORT_ALLOWED_TOOL_NAMES if support_mode else None,
            )
        except PermissionError:
            tools = []
        except Exception:
            logger.warning("assistant_admin_mcp_catalog_failed", exc_info=True)
            tools = []
    tool_rounds = 0
    total_usage_tokens = 0
    last_model = ASSISTANT_MODEL
    tools_enabled = bool(tools)
    tool_schemas = _tool_schemas_by_name(tools)

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            for _ in range(32):
                payload: dict[str, Any] = {
                    "model": ASSISTANT_MODEL,
                    "messages": messages,
                    "max_tokens": 2048,
                    "temperature": 0.3,
                }
                if tools and tools_enabled:
                    payload["tools"] = tools
                    payload["tool_choice"] = "auto"

                resp = await client.post(
                    f"{PLANNER_URL.rstrip('/')}/v1/chat/completions",
                    json=payload,
                    headers=_planner_headers(auth_header, org_headers),
                )
                resp.raise_for_status()
                result = resp.json()
                choice = result["choices"][0]
                msg = choice["message"]
                usage = result.get("usage") or {}
                total_usage_tokens += int(usage.get("total_tokens", 0) or 0)
                last_model = result.get("model", ASSISTANT_MODEL)

                tool_calls = msg.get("tool_calls") or []
                if tool_calls and tools_enabled:
                    if tool_rounds >= MAX_ASSISTANT_TOOL_ROUNDS:
                        tools_enabled = False
                        messages.append(
                            {
                                "role": "assistant",
                                "content": msg.get("content"),
                                "tool_calls": tool_calls,
                            }
                        )
                        messages.append(
                            {
                                "role": "user",
                                "content": (
                                    "Do not call more tools. Summarize and answer using the tool "
                                    "results already in this conversation."
                                ),
                            }
                        )
                        continue

                    tool_rounds += 1
                    messages.append(
                        {
                            "role": "assistant",
                            "content": msg.get("content"),
                            "tool_calls": tool_calls,
                        }
                    )
                    for tc in tool_calls:
                        fn = tc.get("function") if isinstance(tc, dict) else {}
                        if not isinstance(fn, dict):
                            fn = {}
                        tname = str(fn.get("name", "") or "").strip()
                        raw_args = fn.get("arguments", "{}")
                        args, parse_error = _parse_tool_call_arguments(raw_args)
                        schema = tool_schemas.get(tname)
                        validation_error = (
                            "unknown_tool"
                            if not tname or schema is None
                            else parse_error or _validate_tool_arguments_against_schema(args or {}, schema)
                        )
                        if validation_error:
                            logger.warning(
                                "assistant_tool_call_rejected tool=%s reason=%s",
                                tname or "missing",
                                validation_error,
                            )
                            tool_text = _tool_result_error(tname or "missing", validation_error)
                        elif auth_header.lower().startswith("bearer ") or session_cookie:
                            tool_text = await invoke_admin_mcp_tool(
                                auth_header,
                                org_headers,
                                tname,
                                args or {},
                                session_cookie=session_cookie,
                                csrf_cookie=csrf_cookie,
                                csrf_token=csrf_token,
                            )
                        else:
                            tool_text = json.dumps({"error": "missing_admin_session", "tool": tname})
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tc.get("id", ""),
                                "content": tool_text,
                            }
                        )
                    continue

                if tool_calls and not tools_enabled:
                    messages.append(
                        {
                            "role": "assistant",
                            "content": msg.get("content"),
                            "tool_calls": tool_calls,
                        }
                    )
                    messages.append(
                        {
                            "role": "user",
                            "content": "Tools are disabled. Answer in plain text using prior messages only.",
                        }
                    )
                    continue

                text = _message_content_text(msg)
                return {
                    "response": text or "",
                    "tokens": total_usage_tokens,
                    "model": last_model,
                    "tool_rounds": tool_rounds,
                }

            return {
                "response": "Assistant stopped after too many turns; try a narrower question.",
                "tokens": total_usage_tokens,
                "model": last_model,
                "tool_rounds": tool_rounds,
            }
    except Exception as exc:
        logger.warning("assistant_chat_failed", exc_info=True)
        return {
            "response": f"Failed to reach LLM ({type(exc).__name__}). Check admin service logs for details.",
            "tokens": 0,
            "model": "",
            "tool_rounds": tool_rounds,
        }


@router.post("/chat")
async def assistant_chat(
    request: Request,
    data: AssistantChatBody = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    """Admin assistant chat endpoint (org_admin+)."""
    if resolve_role(_user) < Role.org_admin:
        raise HTTPException(status_code=403, detail="Admin assistant requires org_admin role or higher")
    return await _assistant_chat_impl(data=data, _user=_user, request=request, support_mode=False)


@router.post("/support/chat")
async def support_assistant_chat(
    request: Request,
    data: AssistantChatBody = Body(...),
    _user: UserInfo = Depends(get_current_user),
):
    """Support assistant endpoint for authenticated user context."""
    if resolve_role(_user) < Role.user:
        raise HTTPException(status_code=403, detail="Authentication required")
    return await _assistant_chat_impl(data=data, _user=_user, request=request, support_mode=True)
