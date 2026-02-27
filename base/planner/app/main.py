"""Synesis Planner -- FastAPI entrypoint exposing an OpenAI-compatible API.

This service wraps the LangGraph orchestrator behind /v1/chat/completions
so LiteLLM (and any OpenAI-compatible client) can talk to the full
Supervisor -> Worker -> Critic pipeline.
"""

from __future__ import annotations

import hashlib
import json
import logging
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
from .state import RetrievalParams

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper()),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("synesis.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Synesis planner starting", extra={"port": settings.port})
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
                texts = [
                    x.get("text", "")
                    for x in c
                    if isinstance(x, dict) and x.get("type") == "text"
                ]
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


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest, http_request: Request):
    start = time.monotonic()

    user_id = _resolve_user_id(request, http_request)

    user_messages = [HumanMessage(content=m.content) for m in request.messages if m.role == "user"]

    if not user_messages:
        raise HTTPException(status_code=400, detail="No user messages provided")

    # Retrieve conversation history for this user
    conversation_history: list[str] = []
    if settings.memory_enabled:
        conversation_history = memory.get_history(user_id)

    retrieval_params = None
    if request.retrieval:
        retrieval_params = RetrievalParams(
            strategy=request.retrieval.strategy,
            reranker=request.retrieval.reranker,
            top_k=request.retrieval.top_k,
        )

    last_user_content = user_messages[-1].content if user_messages else ""

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
    initial_state = {
        "messages": user_messages,
        "max_iterations": settings.max_iterations,
        "injection_detected": injection_detected,
        "injection_scan_result": injection_scan_result,
        "run_id": run_id,
        "iteration_count": 0,
        "retrieval_params": retrieval_params,
        "user_id": user_id,
        "conversation_history": conversation_history,
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

    try:
        result = await graph.ainvoke(initial_state)
    except Exception as e:
        logger.exception("graph_execution_error")
        err_msg = str(e)[:200]  # Truncate for response
        detail = f"Graph execution failed: {err_msg}. Check planner logs and admin status page for model health."
        raise HTTPException(status_code=500, detail=detail) from e

    messages = result.get("messages", [])
    last_message = messages[-1] if messages else None
    content = last_message.content if last_message else "No response generated."

    # Store turns in conversation memory
    if settings.memory_enabled:
        last_user_content = user_messages[-1].content if user_messages else ""
        if last_user_content:
            memory.store_turn(user_id, "user", last_user_content)
        if content:
            memory.store_turn(user_id, "assistant", content)

    total_tokens = 0
    traces = result.get("node_traces", [])
    for trace in traces:
        if hasattr(trace, "tokens_used"):
            total_tokens += trace.tokens_used

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

    if request.stream:
        # Emit SSE format (OpenAI-compatible): role+content chunk, then finish chunk, then [DONE]
        async def sse_generator() -> object:
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
