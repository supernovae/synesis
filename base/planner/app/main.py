"""Synesis Planner -- FastAPI entrypoint exposing an OpenAI-compatible API.

This service wraps the LangGraph orchestrator behind /v1/chat/completions
so LiteLLM (and any OpenAI-compatible client) can talk to the full
Supervisor -> Worker -> Critic pipeline.
"""

from __future__ import annotations

import hashlib
import time
import uuid
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from langchain_core.messages import HumanMessage

from .graph import graph
from .config import settings
from .state import RetrievalParams
from .conversation_memory import memory

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
    role: str
    content: str


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


@app.post("/v1/chat/completions", response_model=ChatCompletionResponse)
async def chat_completions(request: ChatCompletionRequest, http_request: Request):
    if request.stream:
        raise HTTPException(status_code=400, detail="Streaming not yet supported")

    start = time.monotonic()

    user_id = _resolve_user_id(request, http_request)

    user_messages = [
        HumanMessage(content=m.content)
        for m in request.messages
        if m.role == "user"
    ]

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

    initial_state = {
        "messages": user_messages,
        "max_iterations": settings.max_iterations,
        "iteration_count": 0,
        "retrieval_params": retrieval_params,
        "user_id": user_id,
        "conversation_history": conversation_history,
    }

    try:
        result = await graph.ainvoke(initial_state)
    except Exception as e:
        logger.exception("graph_execution_error")
        raise HTTPException(status_code=500, detail=f"Graph execution failed: {e}")

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

    return ChatCompletionResponse(
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
