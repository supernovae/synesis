"""Synesis Yarn Runtime — FastAPI entrypoint.

OpenAI-compatible API that routes through the Yarn memory buffer, tool
orchestrator, and model execution layer. Supports streaming SSE and
non-streaming responses. Cursor, Claude Code, Windsurf, and OpenCode
all see this as a standard OpenAI model endpoint.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .config import settings
from .escalation import bridge as escalation_bridge
from .escalation.detector import EscalationSignal, check_all as check_escalation
from .memory.buffer import MemoryBuffer
from .memory.compressor import build_summarize_messages, merge_replay
from .memory.delta_stitcher import estimate_cache_hit_tokens
from .memory.prefix_optimizer import validate_prefix_order
from .middleware.auth import resolve_auth
from .middleware.injection_scanner import scan_messages
from .middleware.rate_limiter import enforce_rate_limit
from .model import executor as model_executor
from .model.stream_handler import StreamChunk, ToolCallAccumulator, extract_chunk, parse_sse_line
from .model.usage_tracker import UsageAggregator, UsageRecord
from .session.manager import record_usage, resolve_or_create_session
from .session.models import AuthUser, SessionState
from .telemetry.metrics import record_escalation, record_request, record_tokens, record_tool_call
from .telemetry.traces import setup_logging, setup_otel
from .tools.orchestrator import ToolOrchestrator

logger = logging.getLogger("yarn.api")

# In-process session -> buffer map (hot cache; Redis is durable fallback)
_buffers: dict[str, MemoryBuffer] = {}
_orchestrator = ToolOrchestrator()

SYSTEM_PROMPT = (
    "You are Synesis Coder, an expert AI coding assistant. "
    "You have access to tools for code analysis, search, and more. "
    "Be concise, accurate, and helpful. Write clean, production-quality code. "
    "When you need information from the codebase or external sources that "
    "you don't have, use the synesis_escalate tool to request help from "
    "the Synesis knowledge pipeline."
)


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[override]
    setup_logging()
    setup_otel()
    await _orchestrator.initialize()
    logger.info(
        "Yarn runtime started (provider=%s, model=%s)",
        settings.provider.value,
        settings.model,
    )
    yield
    from .session import redis_store
    from .tools import mcp_client
    from .model import providers

    await redis_store.close()
    await mcp_client.close()
    await escalation_bridge.close()
    await providers.close_all()
    logger.info("Yarn runtime stopped")


app = FastAPI(
    title="Synesis Yarn Runtime",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Request / Response Models
# ---------------------------------------------------------------------------


class ChatMessage(BaseModel):
    role: str
    content: str | None = None
    name: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None


class ChatCompletionRequest(BaseModel):
    model: str = "synesis-yarn"
    messages: list[ChatMessage]
    stream: bool = True
    temperature: float | None = None
    max_tokens: int | None = None
    tools: list[dict[str, Any]] | None = None
    tool_choice: str | dict[str, Any] | None = None
    user: str | None = None
    conversation_id: str | None = None

    model_config = {"extra": "allow"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_buffer(session_key: str) -> MemoryBuffer:
    if session_key not in _buffers:
        _buffers[session_key] = MemoryBuffer(
            max_tokens=settings.memory_window_tokens,
            pinned_budget=settings.memory_pinned_budget_tokens,
        )
    return _buffers[session_key]


def _build_sse_chunk(
    chunk_id: str,
    model: str,
    content: str = "",
    tool_calls: list[dict[str, Any]] | None = None,
    finish_reason: str | None = None,
    usage: dict[str, int] | None = None,
) -> str:
    delta: dict[str, Any] = {"role": "assistant"}
    if content:
        delta["content"] = content
    if tool_calls:
        delta["tool_calls"] = tool_calls

    data: dict[str, Any] = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    if usage:
        data["usage"] = usage

    return f"data: {json.dumps(data)}\n\n"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/health/readiness")
async def readiness():
    return {"status": "ready"}


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": "synesis-yarn",
                "object": "model",
                "created": 1700000000,
                "owned_by": "synesis",
            },
        ],
    }


@app.get("/v1/mcp/tools")
async def list_mcp_tools():
    return {"tools": _orchestrator.list_tools()}


@app.post("/v1/mcp/tools/call")
async def call_mcp_tool(request: Request):
    body = await request.json()
    name = body.get("name", "")
    arguments = body.get("arguments", {})

    call = {"id": str(uuid.uuid4()), "function": {"name": name, "arguments": json.dumps(arguments)}}
    result = await _orchestrator.execute_tool_call(call)
    return {"content": [{"type": "text", "text": result.content}]}


@app.get("/metrics")
async def metrics():
    from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
    return JSONResponse(
        content=generate_latest().decode(),
        media_type=CONTENT_TYPE_LATEST,
    )


@app.post("/v1/chat/completions")
async def chat_completions(body: ChatCompletionRequest, request: Request):
    """Main endpoint — the agentic loop."""
    start_time = time.monotonic()
    request_id = f"yarn-{uuid.uuid4().hex[:12]}"

    # --- Auth ---
    auth_user = await resolve_auth(request)

    # --- Session ---
    conversation_id = (
        body.conversation_id
        or request.headers.get("x-conversation-id", "")
        or request.headers.get("x-chat-id", "")
    )
    session = await resolve_or_create_session(
        auth_user, conversation_id=conversation_id
    )
    enforce_rate_limit(session)

    # --- Memory buffer ---
    buf = _get_buffer(session.session_key)

    if not buf._pinned:
        buf.set_system_prompt(SYSTEM_PROMPT)

    # --- Client messages ---
    client_messages = [m.model_dump(exclude_none=True) for m in body.messages]

    # Injection scan
    client_messages, injection_detected = scan_messages(client_messages)
    if injection_detected:
        logger.warning("Injection detected in request %s", request_id)

    # Extract the latest user message and append to buffer
    user_content = ""
    for msg in reversed(client_messages):
        if msg.get("role") == "user":
            user_content = msg.get("content", "")
            break

    if user_content:
        buf.append_user(user_content)

    # --- Tool setup ---
    tools = body.tools or _orchestrator.list_tools()
    if tools and not any(t.get("_yarn_pin") == "tools" for t in buf._pinned):
        buf.set_tool_definitions(tools)

    # --- Stream vs non-stream ---
    if body.stream:
        return StreamingResponse(
            _stream_agentic_loop(
                buf=buf,
                tools=tools,
                session=session,
                request_id=request_id,
                model=body.model,
                temperature=body.temperature,
                max_tokens=body.max_tokens,
                start_time=start_time,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Request-Id": request_id,
            },
        )
    else:
        return await _non_streaming_loop(
            buf=buf,
            tools=tools,
            session=session,
            request_id=request_id,
            model=body.model,
            temperature=body.temperature,
            max_tokens=body.max_tokens,
            start_time=start_time,
        )


# ---------------------------------------------------------------------------
# Agentic Loops
# ---------------------------------------------------------------------------


async def _stream_agentic_loop(
    buf: MemoryBuffer,
    tools: list[dict[str, Any]],
    session: SessionState,
    request_id: str,
    model: str,
    temperature: float | None,
    max_tokens: int | None,
    start_time: float,
):
    """The hot loop: model -> tool calls -> model -> ... -> content stream."""
    usage_agg = UsageAggregator()
    tool_loop_count = 0
    accumulated_content = ""

    while True:
        context = buf.get_context()

        # Prefix order validation (debug)
        warnings = validate_prefix_order(context)
        if warnings:
            logger.warning("Prefix order issues: %s", warnings)

        # Estimate cache tokens for tracking
        est_cached = estimate_cache_hit_tokens(buf)

        # Stream model response
        tool_accumulator = ToolCallAccumulator()
        chunk_content = ""
        finish_reason = None
        has_tool_calls = False

        async for chunk in model_executor.run_model(
            context, tools,
            temperature=temperature,
            max_tokens=max_tokens,
        ):
            if chunk.content:
                chunk_content += chunk.content
                yield _build_sse_chunk(request_id, model, content=chunk.content)

            if chunk.tool_calls:
                tool_accumulator.feed(chunk.tool_calls)
                has_tool_calls = True

            if chunk.finish_reason:
                finish_reason = chunk.finish_reason
                if chunk.finish_reason == "tool_calls" and tool_accumulator.has_pending:
                    chunk.tool_calls = tool_accumulator.flush()
                    has_tool_calls = True

            if chunk.raw.get("_usage_record"):
                usage_agg.add(chunk.raw["_usage_record"])

        # Process completed tool calls
        completed_calls = tool_accumulator.flush() if tool_accumulator.has_pending else []
        if has_tool_calls and completed_calls:
            buf.append_model("", tool_calls=completed_calls)

            for call in completed_calls:
                tool_loop_count += 1
                result = await _orchestrator.execute_tool_call(call)
                record_tool_call(result.name, not result.is_error)

                buf.append_tool_result(
                    result.tool_call_id, result.name, result.content
                )

                # Check escalation
                sig = check_escalation(buf, tool_loop_count, result)
                if sig.should_escalate:
                    logger.info("Escalating: %s", sig.reason)
                    record_escalation(sig.reason)
                    session.escalation_count += 1

                    async for line in escalation_bridge.escalate_to_langchain(
                        buf.get_context(),
                        user=session.user_id,
                        conversation_id=session.conversation_id,
                    ):
                        yield line.decode("utf-8", errors="replace")

                    yield "data: [DONE]\n\n"
                    elapsed = time.monotonic() - start_time
                    record_request("escalated", settings.provider.value, elapsed)
                    await record_usage(
                        session,
                        usage_agg.total_tokens_in,
                        usage_agg.total_tokens_out,
                        usage_agg.total_tokens_cached,
                    )
                    return

            continue

        # Content response (no tool calls) — we're done
        if chunk_content:
            accumulated_content += chunk_content
            buf.append_model(accumulated_content)

        yield _build_sse_chunk(
            request_id, model,
            finish_reason="stop",
            usage={
                "prompt_tokens": usage_agg.total_tokens_in,
                "completion_tokens": usage_agg.total_tokens_out,
                "total_tokens": usage_agg.total_tokens_in + usage_agg.total_tokens_out,
            },
        )
        yield "data: [DONE]\n\n"
        break

    # --- Post-request bookkeeping ---
    elapsed = time.monotonic() - start_time
    record_request("success", settings.provider.value, elapsed)
    record_tokens(
        usage_agg.total_tokens_in,
        usage_agg.total_tokens_out,
        usage_agg.total_tokens_cached,
        settings.provider.value,
    )
    await record_usage(
        session,
        usage_agg.total_tokens_in,
        usage_agg.total_tokens_out,
        usage_agg.total_tokens_cached,
    )

    # --- Eviction / compression check ---
    evicted = buf.get_evicted_turns()
    if evicted:
        logger.info("Compressing %d evicted turns", len(evicted))
        # Fire-and-forget compression using a cheap model call
        _schedule_compression(buf, evicted, session)


def _schedule_compression(
    buf: MemoryBuffer,
    evicted: list[dict[str, Any]],
    session: SessionState,
) -> None:
    """Schedule background compression of evicted turns."""
    import asyncio

    async def _compress():
        try:
            existing = ""
            for m in buf._pinned:
                if m.get("_yarn_pin") == "replay":
                    existing = m.get("content", "").replace("[Session Memory]\n", "")
                    break

            messages = build_summarize_messages(evicted, existing)
            result = await model_executor.run_model_sync(
                messages, temperature=0.1, max_tokens=1024
            )

            choices = result.get("choices", [])
            if choices:
                summary = choices[0].get("message", {}).get("content", "")
                if summary:
                    merged = merge_replay(existing, summary)
                    buf.set_memory_replay(merged)
                    logger.info("Memory replay updated (%d chars)", len(merged))
        except Exception:
            logger.exception("Background compression failed")

    asyncio.create_task(_compress())


async def _non_streaming_loop(
    buf: MemoryBuffer,
    tools: list[dict[str, Any]],
    session: SessionState,
    request_id: str,
    model: str,
    temperature: float | None,
    max_tokens: int | None,
    start_time: float,
) -> JSONResponse:
    """Non-streaming variant of the agentic loop."""
    usage_agg = UsageAggregator()
    tool_loop_count = 0

    for _ in range(settings.escalation_max_tool_loops + 1):
        context = buf.get_context()

        result = await model_executor.run_model_sync(
            context, tools,
            temperature=temperature,
            max_tokens=max_tokens,
        )

        if result.get("error"):
            return JSONResponse(
                status_code=502,
                content={"error": {"message": result["error"], "type": "model_error"}},
            )

        choices = result.get("choices", [])
        if not choices:
            break

        choice = choices[0]
        message = choice.get("message", {})
        finish_reason = choice.get("finish_reason", "stop")

        # Track usage
        if result.get("usage"):
            u = result["usage"]
            record = UsageRecord(
                provider=settings.provider.value,
                model=model,
                tokens_in=u.get("prompt_tokens", 0),
                tokens_out=u.get("completion_tokens", 0),
                tokens_cached=u.get("prompt_tokens_details", {}).get("cached_tokens", 0),
            )
            usage_agg.add(record)

        tool_calls = message.get("tool_calls")
        if tool_calls and finish_reason == "tool_calls":
            buf.append_model("", tool_calls=tool_calls)

            for call in tool_calls:
                tool_loop_count += 1
                tr = await _orchestrator.execute_tool_call(call)
                record_tool_call(tr.name, not tr.is_error)
                buf.append_tool_result(tr.tool_call_id, tr.name, tr.content)

                sig = check_escalation(buf, tool_loop_count, tr)
                if sig.should_escalate:
                    esc_result = await escalation_bridge.escalate_sync(
                        buf.get_context(),
                        user=session.user_id,
                    )
                    session.escalation_count += 1
                    return JSONResponse(content=esc_result)

            continue

        # Content response
        content = message.get("content", "")
        buf.append_model(content)

        elapsed = time.monotonic() - start_time
        record_request("success", settings.provider.value, elapsed)
        await record_usage(
            session,
            usage_agg.total_tokens_in,
            usage_agg.total_tokens_out,
            usage_agg.total_tokens_cached,
        )

        return JSONResponse(content={
            "id": request_id,
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }],
            "usage": {
                "prompt_tokens": usage_agg.total_tokens_in,
                "completion_tokens": usage_agg.total_tokens_out,
                "total_tokens": usage_agg.total_tokens_in + usage_agg.total_tokens_out,
            },
        })

    return JSONResponse(
        status_code=500,
        content={"error": {"message": "Tool loop limit exceeded", "type": "server_error"}},
    )
