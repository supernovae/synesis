"""Synesis Planner -- FastAPI entrypoint exposing an OpenAI-compatible API.

This service wraps the LangGraph orchestrator behind /v1/chat/completions
so Open WebUI (and any OpenAI-compatible client) can talk to the full
Supervisor -> Worker -> Critic pipeline. Direct to planner; no proxy required.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage
from pydantic import BaseModel, Field, model_validator

from .config import settings
from .conversation_memory import memory
from .graph import graph
from .injection_scanner import reduce_context_on_injection, scan_user_input
from .message_filter import is_ui_helper_message
from .history_summarizer import archive_to_l2, summarize_pivot_history
from .nodes.entry_classifier import detect_language_deterministic
from .state import RetrievalParams

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper()),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
# Suppress OpenAI/httpx DEBUG logs (full prompt dumps) unless we explicitly want them
if settings.log_level.upper() != "DEBUG":
    for name in ("openai", "httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
logger = logging.getLogger("synesis.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        "Synesis planner starting build=%s port=%s",
        settings.build_version,
        settings.port,
    )
    yield
    logger.info("Synesis planner shutting down")


app = FastAPI(
    title="Synesis Planner",
    description="Safety-II LLM orchestrator with Supervisor/Worker/Critic loop",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatMessage(BaseModel):
    """OpenAI-compatible message; content can be str or array of parts (multimodal)."""

    role: str
    content: str

    @model_validator(mode="before")
    @classmethod
    def normalize_content(cls, data: object) -> object:
        if isinstance(data, dict) and "content" in data:
            c = data["content"]
            if isinstance(c, list):
                texts = [x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text"]
                data = {**data, "content": " ".join(texts).strip() or ""}
        return data


class RetrievalOptions(BaseModel):
    """Per-request retrieval overrides sent alongside chat messages."""

    strategy: str = "hybrid"
    reranker: str = "flashrank"
    top_k: int = 5


class ChatCompletionRequest(BaseModel):
    model: str = "synesis-agent"
    messages: list[ChatMessage]
    temperature: float = 0.2
    max_tokens: int = 4096
    stream: bool = False
    user: str | None = None
    retrieval: RetrievalOptions | None = None

    model_config = {"extra": "ignore"}  # Open WebUI sends frequency_penalty, etc.


class Choice(BaseModel):
    index: int = 0
    message: ChatMessage
    finish_reason: str = "stop"


class Usage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class ChatCompletionResponse(BaseModel):
    id: str = Field(default_factory=lambda: f"chatcmpl-{uuid.uuid4().hex[:12]}")
    object: str = "chat.completion"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str = "synesis-agent"
    choices: list[Choice]
    usage: Usage


def _resolve_user_id(request_body: ChatCompletionRequest, http_request: Request) -> str:
    """Resolve user identity: request.user > API key hash > anonymous."""
    if request_body.user:
        return request_body.user.strip()[:128]

    auth = http_request.headers.get("authorization", "")
    if auth.startswith("Bearer ") and len(auth) > 7:
        token = auth[7:]
        return hashlib.sha256(token.encode()).hexdigest()[:16]

    return "anonymous"


def _sse_chunk(data: dict) -> str:
    """Format JSON as SSE data line."""
    return f"data: {json.dumps(data)}\n\n"


def _sse_status_chunk(data: dict) -> str:
    """Format status event with event: status for Open WebUI routing.
    Uses named SSE event so clients listening for 'status' receive it.
    """
    return f"event: status\ndata: {json.dumps(data)}\n\n"


# User-friendly status messages for progressive feedback during graph execution.
# Open WebUI format: {"type": "status", "data": {"description": "...", "done": false, "hidden": false}}
# Other clients ignore these lines; only Open WebUI displays them.
NODE_STATUS_MESSAGES: dict[str, str] = {
    "entry_classifier": "Analyzing request…",
    "supervisor": "Planning…",
    "planner": "Building execution plan…",
    "context_curator": "Gathering context…",
    "worker": "Generating code…",
    "patch_integrity_gate": "Validating code…",
    "sandbox": "Testing code…",
    "lsp_analyzer": "Analyzing types…",
    "critic": "Reviewing…",
    "respond": "Finishing…",
}


def _extract_content_and_metrics(
    result: dict,
    user_id: str,
    last_user_content: str,
) -> tuple[str, int]:
    """Extract response content from graph result; store in memory; return (content, total_tokens)."""
    messages = result.get("messages", [])
    last_message = messages[-1] if messages else None
    content = last_message.content if last_message else "No response generated."

    # Defensive fallback: Worker produced code but Respond saw empty (state merge loss)
    if "no output to show" in (content or ""):
        res_code = result.get("generated_code", "")
        res_ops = result.get("patch_ops", []) or []
        logger.warning(
            "no_output_detected result_generated_code_len=%d result_patch_ops=%d", len(res_code or ""), len(res_ops)
        )
    if "no output to show" in (content or "") and (result.get("generated_code") or result.get("patch_ops")):
        code = result.get("generated_code", "")
        patch_ops = result.get("patch_ops", []) or []
        lang = result.get("target_language", "python")
        expl = result.get("code_explanation", "")
        parts = []
        if code.strip():
            parts.append(f"```{lang}\n{code.strip()}\n```")
        elif patch_ops:
            for op in patch_ops:
                p = op.get("path", "") if isinstance(op, dict) else getattr(op, "path", "")
                t = (
                    op.get("text", "") or op.get("content", "")
                    if isinstance(op, dict)
                    else getattr(op, "text", "") or getattr(op, "content", "")
                )
                if p and (t or "").strip():
                    parts.append(f"**{p}**\n```{lang}\n{t.strip()}\n```")
        if expl:
            parts.append(f"\n**Approach:** {expl}")
        if parts:
            content = "\n\n".join(parts)
            logger.warning(
                "main_fallback_recovered_code result_code_len=%d patch_ops=%d", len(code or ""), len(patch_ops)
            )
        else:
            logger.warning(
                "main_fallback_no_recovery result_has_generated_code=%s result_has_patch_ops=%s",
                bool(code),
                bool(patch_ops),
            )

    if settings.memory_enabled:
        if last_user_content:
            memory.store_turn(user_id, "user", last_user_content)
        if content:
            memory.store_turn(user_id, "assistant", content)
        # Update last_active_language for next turn's context-stability check
        lang = result.get("target_language", "python")
        if lang:
            memory.set_last_active_language(user_id, lang)

    total_tokens = 0
    for trace in result.get("node_traces", []) or []:
        if hasattr(trace, "tokens_used"):
            total_tokens += trace.tokens_used

    return content, total_tokens


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest, http_request: Request):
    start = time.monotonic()

    user_id = _resolve_user_id(request, http_request)

    user_messages = [HumanMessage(content=m.content) for m in request.messages if m.role == "user"]

    if not user_messages:
        raise HTTPException(status_code=400, detail="No user messages provided")

    last_user_content = user_messages[-1].content if user_messages else ""

    # Retrieve conversation history for this user
    conversation_history: list[str] = []
    if settings.memory_enabled:
        conversation_history = memory.get_history(user_id)

    # Context-stability: detect language pivot (Python→JS→shell) to avoid contaminated history
    current_lang = detect_language_deterministic(last_user_content)
    last_lang = memory.get_last_active_language(user_id) if settings.memory_enabled else None
    is_pivot = bool(last_lang and current_lang != last_lang)
    pivot_summary = ""
    if is_pivot:
        run_id_pre = str(uuid.uuid4())  # for archive
        if settings.pivot_summary_enabled and conversation_history:
            interaction_mode = "do"  # Entry classifier sets later; mentor note needs it
            pivot_summary = await summarize_pivot_history(
                conversation_history, last_lang, current_lang, interaction_mode
            )
            archive_to_l2(run_id_pre, user_id, conversation_history)
        # Flush contaminated history — user switched task domain
        conversation_history = [f"[system]: Previous era: {pivot_summary}"] if pivot_summary else []
        user_messages = [HumanMessage(content=last_user_content)]  # only current request
        if settings.memory_enabled:
            memory.clear_user_history(user_id)
            memory.set_last_active_language(user_id, current_lang)
        logger.info(
            "context_pivot lang_switch",
            extra={"user_id": user_id, "from": last_lang, "to": current_lang},
        )

    retrieval_params = None
    if request.retrieval:
        retrieval_params = RetrievalParams(
            strategy=request.retrieval.strategy,
            reranker=request.retrieval.reranker,
            top_k=request.retrieval.top_k,
        )

    # Log task payload for debugging empty-task issues (proxy/request transformation)
    _task_preview = (last_user_content or "")[:80]
    logger.info(
        "chat_request task_len=%d preview=%r",
        len(last_user_content or ""),
        _task_preview,
        extra={"user_id": user_id},
    )

    # A) UI-helper filter: reject follow-up suggestions, title/tag generators before Supervisor
    if is_ui_helper_message(last_user_content):
        logger.info("message_filter_ui_helper", extra={"user_id": user_id})
        return ChatCompletionResponse(
            choices=[
                Choice(
                    message=ChatMessage(
                        role="assistant",
                        content="[UI helper request; no coding task to process.]",
                    ),
                    finish_reason="stop",
                )
            ],
            usage=Usage(),
        )

    # IDE/agent coordination: scan for prompt injection in user + conversation
    injection_detected = False
    injection_scan_result: dict[str, object] = {}
    if settings.injection_scan_enabled:
        injection_detected, injection_scan_result = scan_user_input(
            last_user_content,
            conversation_history,
        )
        if injection_detected:
            if settings.injection_action == "block":
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Suspicious content detected. If this was unintentional, rephrase your message and try again."
                    ),
                )
            elif settings.injection_action == "reduce" and last_user_content:
                last_user_content = reduce_context_on_injection(
                    last_user_content,
                    str(injection_scan_result.get("patterns_found", [])),
                )
                # Rebuild user_messages with redacted last message
                user_messages = [HumanMessage(content=m.content) for m in request.messages if m.role == "user"]
                if user_messages:
                    user_messages[-1] = HumanMessage(content=last_user_content)

    run_id = str(uuid.uuid4())
    # Ensure task_description is never empty at graph entry (avoids robotic needs_input)
    initial_state: dict[str, Any] = {
        "messages": user_messages,
        "task_description": (last_user_content or "").strip()[:500],
        "last_user_content": (last_user_content or "").strip()[:500],
        "max_iterations": settings.max_iterations,
        "injection_detected": injection_detected,
        "injection_scan_result": injection_scan_result,
        "run_id": run_id,
        "iteration_count": 0,
        "retrieval_params": retrieval_params,
        "user_id": user_id,
        "conversation_history": conversation_history,
        "is_pivot": is_pivot,
        "last_active_language": last_lang or "",
        "pivot_summary": pivot_summary,
        "token_budget_remaining": settings.max_tokens_per_request,
        "sandbox_minutes_used": 0.0,
        "lsp_calls_used": 0,
        "evidence_experiments_count": 0,
    }

    # Unified pending question: plan approval, needs_input, or clarification
    if settings.memory_enabled:
        pending = memory.get_and_clear_pending_question(user_id)
        if not pending:
            # Backward compat: migrate from legacy stores
            pending = memory.get_and_clear_pending_plan(user_id)
            if pending:
                pending["source_node"] = "planner"
            else:
                pending = memory.get_and_clear_pending_needs_input(user_id)
                if pending:
                    pending["source_node"] = "worker"

        if pending:
            source_node = pending.get("source_node", "worker")
            context = pending.get("context", pending)
            for key, val in context.items():
                if key != "source_node" and val is not None:
                    initial_state[key] = val
            if source_node == "worker":
                initial_state["user_answer_to_needs_input"] = last_user_content
                for k in (
                    "task_description",
                    "target_language",
                    "rag_context",
                    "execution_plan",
                    "assumptions",
                ):
                    if k in pending and pending[k] is not None:
                        initial_state[k] = pending[k]
            elif source_node == "supervisor":
                initial_state["user_answer_to_clarification"] = last_user_content
            elif source_node == "planner":
                for k in (
                    "execution_plan",
                    "task_description",
                    "target_language",
                    "rag_context",
                    "task_type",
                    "assumptions",
                    "failure_context",
                    "web_search_results",
                ):
                    if k in pending and pending[k] is not None:
                        initial_state[k] = pending[k]
            initial_state["pending_question_continue"] = True
            initial_state["pending_question_source"] = source_node if source_node != "planner" else "worker"

    if request.stream:
        # Streaming: run graph with progressive status events, then emit final content
        chat_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

        async def sse_generator() -> object:
            result = None
            try:
                async for chunk in graph.astream(initial_state, stream_mode="values"):
                    result = chunk
                    node = chunk.get("current_node", "")
                    if node and node in NODE_STATUS_MESSAGES:
                        yield _sse_status_chunk({
                            "type": "status",
                            "data": {
                                "description": NODE_STATUS_MESSAGES[node],
                                "done": False,
                                "hidden": False,
                            },
                        })
            except Exception as e:
                logger.exception("graph_execution_error")
                yield f"event: error\ndata: {json.dumps({'error': str(e)[:200]})}\n\n"
                yield "data: [DONE]\n\n"
                return

            if not result:
                yield f"event: error\ndata: {json.dumps({'error': 'Graph produced no result'})}\n\n"
                yield "data: [DONE]\n\n"
                return

            # Stop status animation before streaming content (Open WebUI done=true)
            yield _sse_status_chunk({
                "type": "status",
                "data": {"description": "", "done": True, "hidden": False},
            })
            content, total_tokens = _extract_content_and_metrics(
                result, user_id, last_user_content
            )
            yield _sse_chunk(
                {
                    "id": chat_id,
                    "object": "chat.completion.chunk",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": content},
                            "finish_reason": None,
                        }
                    ],
                }
            )
            yield _sse_chunk(
                {
                    "id": chat_id,
                    "object": "chat.completion.chunk",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                }
            )
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            sse_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Non-streaming: run graph once, then build response
    try:
        result = await graph.ainvoke(initial_state)
    except Exception as e:
        logger.exception("graph_execution_error")
        err_msg = str(e)[:200]  # Truncate for response
        detail = f"Graph execution failed: {err_msg}. Check planner logs and admin status page for model health."
        raise HTTPException(status_code=500, detail=detail) from e

    content, total_tokens = _extract_content_and_metrics(
        result, user_id, last_user_content
    )

    latency_ms = (time.monotonic() - start) * 1000
    logger.info(
        "request_completed",
        extra={
            "user_id": user_id,
            "latency_ms": latency_ms,
            "iterations": result.get("iteration_count", 0),
            "total_tokens": total_tokens,
            "has_error": bool(result.get("error")),
            "memory_turns": memory.get_turn_count(user_id) if settings.memory_enabled else 0,
        },
    )

    chat_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

    return ChatCompletionResponse(
        id=chat_id,
        model=request.model,
        choices=[
            Choice(
                message=ChatMessage(role="assistant", content=content),
            )
        ],
        usage=Usage(total_tokens=total_tokens),
    )


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": "synesis-agent",
                "object": "model",
                "owned_by": "synesis",
                "permission": [],
            }
        ],
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/health/readiness")
async def readiness():
    return {"status": "ready"}
