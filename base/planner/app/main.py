"""Synesis Planner -- FastAPI entrypoint exposing an OpenAI-compatible API.

This service wraps the LangGraph orchestrator behind /v1/chat/completions
so Open WebUI (and any OpenAI-compatible client) can talk to the full
Supervisor -> Worker -> Critic pipeline. Direct to planner; no proxy required.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, ClassVar

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from langchain_core.messages import HumanMessage
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import BaseModel, Field, model_validator

from .api_metrics import (
    record_chat_error,
    record_chat_success,
    record_graph_iterations,
    record_node_confidence,
    record_tokens,
)
from .config import settings
from .conversation_memory import memory
from .entry_classifier_engine import get_scoring_engine
from .graph import graph
from .history_summarizer import archive_to_l2, summarize_pivot_history
from .injection_scanner import reduce_context_on_injection, scan_user_input
from .message_filter import classify_ui_helper_type
from .nodes.entry_classifier import detect_language_deterministic
from .pending_drift import pending_reply_diverges
from .rag_client import submit_user_knowledge
from .state import RetrievalParams
from .streaming_events import StatusQueueCallback

# /why, /reclassify, and /test command patterns
_WHY_PATTERN = re.compile(r"^\s*\/why\s*$", re.IGNORECASE)
_RECLASSIFY_PATTERN = re.compile(r"^\s*\/reclassify\s+(trivial|small|complex)\s*$", re.IGNORECASE)
_TEST_PATTERN = re.compile(r"^\s*\/test\s*$", re.IGNORECASE)

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
    from .entry_classifier_engine import get_scoring_engine
    from .intent_config_linter import lint_intent_config

    logger.info(
        "Synesis planner starting build=%s port=%s",
        settings.build_version,
        settings.port,
    )
    get_scoring_engine()
    issues = lint_intent_config()
    if issues:
        for msg in issues:
            logger.warning("intent_config: %s", msg)
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
    """OpenAI-compatible message; content can be str, null, or array of parts (multimodal/tool)."""

    role: str
    content: str = ""

    @model_validator(mode="before")
    @classmethod
    def normalize_content(cls, data: object) -> object:
        if isinstance(data, dict):
            c = data.get("content")
            if c is None:
                data = {**data, "content": ""}
            elif isinstance(c, list):
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
    max_tokens: int | None = None
    max_completion_tokens: int | None = None
    stream: bool = False
    user: str | None = None
    retrieval: RetrievalOptions | None = None
    conversation_id: str | None = None

    model_config = {"extra": "ignore"}  # Open WebUI sends frequency_penalty, etc.

    @property
    def effective_max_tokens(self) -> int:
        """Prefer max_completion_tokens (OpenAI spec); fall back to max_tokens."""
        return self.max_completion_tokens or self.max_tokens or 4096


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
    run_id: str | None = None  # For feedback association (echo in POST /v1/feedback)


def _is_coding_client(http_request: Request) -> bool:
    """Detect Cursor, Claude Code, or other coding IDE/agent. Enables code bias for ambiguous requests."""
    ua = (http_request.headers.get("user-agent") or "").lower()
    x_client = (http_request.headers.get("x-client") or "").lower()
    x_app = (http_request.headers.get("x-app") or "").lower()
    for needle in ("cursor", "claude.code", "claude-code", "vscode", "codeium", "windsurf"):
        if needle in ua or needle in x_client or needle in x_app:
            return True
    return False


def _resolve_user_id(request_body: ChatCompletionRequest, http_request: Request) -> str:
    """Resolve user identity: Open WebUI header > request body > API key hash > anonymous."""
    owui_user = (http_request.headers.get("x-openwebui-user-id") or "").strip()
    if owui_user:
        return owui_user[:128]
    if request_body.user:
        return request_body.user.strip()[:128]
    auth = http_request.headers.get("authorization", "")
    if auth.startswith("Bearer ") and len(auth) > 7:
        token = auth[7:]
        return hashlib.sha256(token.encode()).hexdigest()[:16]
    return "anonymous"


def _resolve_conversation_id(request_body: ChatCompletionRequest, http_request: Request) -> str | None:
    """Resolve conversation scope: body > Open WebUI header > generic headers > None.
    When present, memory (history, pending plans) is scoped per conversation — avoids drift across chats."""
    if request_body.conversation_id and request_body.conversation_id.strip():
        return request_body.conversation_id.strip()[:128]
    header = (
        http_request.headers.get("x-openwebui-chat-id")
        or http_request.headers.get("x-conversation-id")
        or http_request.headers.get("x-chat-id")
        or ""
    ).strip()
    return header[:128] if header else None


def _memory_scope_key(user_id: str, conversation_id: str | None) -> str:
    """Key for conversation-scoped memory. When conversation_id present, isolates per chat."""
    if not conversation_id:
        return user_id
    return f"{user_id}:{conversation_id}"


def _sse_chunk(data: dict) -> str:
    """Format JSON as SSE data line."""
    return f"data: {json.dumps(data)}\n\n"


def _sse_content_delta(chat_id: str, delta: dict, run_id: str = "") -> str:
    """Format a single content-delta SSE chunk (OpenAI streaming format)."""
    payload: dict[str, Any] = {
        "id": chat_id,
        "object": "chat.completion.chunk",
        "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
    }
    if run_id:
        payload["run_id"] = run_id
    return f"data: {json.dumps(payload)}\n\n"


def _sse_debug_chatter_event(node: str, label: str, content: str) -> str:
    """Format debug_chatter event for plan/router/critic/executor outputs. Open WebUI can render as labeled block."""
    return f"event: debug_chatter\ndata: {json.dumps({'node': node, 'label': label, 'content': content})}\n\n"


def _format_debug_chatter(chunk: dict) -> list[tuple[str, str, str]]:
    """Extract (node, label, content) for debug chatter from a graph chunk."""
    out: list[tuple[str, str, str]] = []
    node = chunk.get("current_node", "")

    if node == "entry_classifier":
        task_size = chunk.get("task_size", "")
        intent = chunk.get("intent_class", "")
        output_type = chunk.get("output_type", "")
        plan_req = chunk.get("plan_required", False)
        out.append(
            (
                "entry_classifier",
                "Router (Entry Classifier)",
                f"task_size={task_size} intent={intent} output_type={output_type} plan_required={plan_req}",
            )
        )

    elif node == "strategic_advisor":
        ctx = chunk.get("platform_context", "")
        domain = chunk.get("active_domain_refs") or []
        out.append(("strategic_advisor", "Router (Strategic Advisor)", f"platform={ctx} domains={domain}"))

    elif node == "supervisor":
        next_n = chunk.get("next_node", "")
        route = chunk.get("supervisor_route_reasoning", "")[:150]
        out.append(("supervisor", "Router (Supervisor)", f"next_node={next_n} {route}"))

    elif node == "planner":
        exec_plan = chunk.get("execution_plan") or {}
        steps = exec_plan.get("steps", []) if isinstance(exec_plan, dict) else []
        lines = [f"{i + 1}. {s.get('action', s) if isinstance(s, dict) else s}" for i, s in enumerate(steps)]
        out.append(("planner", "Execution Plan", "\n".join(lines) if lines else "(no steps)"))

    elif node == "worker":
        code = (chunk.get("generated_code") or "")[:800]
        expl = (chunk.get("code_explanation") or "")[:200]
        if code or expl:
            out.append(("worker", "Executor", f"{expl}\n\n```\n{code}\n```" if code else expl))

    elif node == "critic":
        approved = chunk.get("critic_approved", True)
        feedback = (chunk.get("critic_feedback") or "")[:300]
        what_ifs = chunk.get("what_if_analyses") or []
        summary = f"approved={approved}"
        if feedback:
            summary += f" | {feedback}"
        if what_ifs:
            summary += f" | {len(what_ifs)} what-if(s)"
        out.append(("critic", "Critic", summary))

    return out


def _sse_status_chunk(data: dict) -> str:
    """Format status event with event: status for Open WebUI routing.
    Uses named SSE event so clients listening for 'status' receive it.
    """
    return f"event: status\ndata: {json.dumps(data)}\n\n"


# User-friendly status messages for progressive feedback during graph execution.
# Open WebUI format: {"type": "status", "data": {"description": "...", "done": false, "hidden": false}}
# Other clients ignore these lines; only Open WebUI displays them.
# strategic_advisor = Domain Aligner (conceptual). Internal node name; display alias for docs/UX.
DOMAIN_ALIGNER_NODE = "strategic_advisor"
NODE_DISPLAY_NAMES: dict[str, str] = {
    DOMAIN_ALIGNER_NODE: "Domain Aligner",
    "entry_classifier": "Entry Classifier",
    "supervisor": "Supervisor",
    "context_curator": "Context Curator",
    "worker": "Worker",
    "patch_integrity_gate": "Patch Integrity Gate",
    "critic": "Critic",
}
# Adaptive Rigor: tier-matched status messages for Open WebUI
NODE_STATUS_MESSAGES: dict[str, str] = {
    "entry_classifier": "Analyzing request…",
    "strategic_advisor": "Detecting domain…",
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

# Tier-specific overrides for Adaptive Rigor UX
STATUS_TRIVIAL: dict[str, str] = {
    "entry_classifier": "Analyzing…",
    "worker": "Generating your code…",
}
STATUS_SMALL: dict[str, str] = {
    "worker": "Generating code…",
}
STATUS_COMPLEX: dict[str, str] = {
    "entry_classifier": "Complex task detected. Building execution plan…",
    "strategic_advisor": "Complex task detected. Building execution plan…",
    "planner": "Architecting solution…",
    "worker": "Architecting solution…",
}


def _status_for_node(node: str, task_size: str, deliverable_type: str = "") -> str:
    """Return tier-matched status message for Open WebUI."""
    # explain_only (plans, documents) → "Creating your plan…" instead of "Generating code…"
    if node == "worker" and deliverable_type == "explain_only":
        return "Creating your plan…"
    if task_size == "trivial" and node in STATUS_TRIVIAL:
        return STATUS_TRIVIAL[node]
    if task_size == "small" and node in STATUS_SMALL:
        return STATUS_SMALL[node]
    if task_size == "complex" and node in STATUS_COMPLEX:
        return STATUS_COMPLEX[node]
    return NODE_STATUS_MESSAGES.get(node, "")


class _ExtractorState:
    SCANNING = 0
    IN_VALUE = 1
    DONE = 2


class StreamingCodeExtractor:
    """Incremental JSON extractor for the ``"code"`` field value.

    Feed raw LLM tokens (which form a JSON object) and receive decoded
    string fragments from the ``code`` field as they arrive.  The extractor
    handles standard JSON string escapes (``\\n``, ``\\"``, ``\\\\``,
    ``\\uXXXX``, etc.).  If the token stream never enters the ``code``
    field the caller falls back to the post-loop ``_extract_content_and_metrics``
    path.
    """

    def __init__(self) -> None:
        self._state = _ExtractorState.SCANNING
        self._buf = ""
        self._escape = False

    # Compile once; matches `"code"` followed by optional whitespace + colon + optional whitespace + opening quote.
    _KEY_RE = re.compile(r'"code"\s*:\s*"')

    def feed(self, token: str) -> list[str]:
        """Return decoded content fragments (may be empty)."""
        if self._state == _ExtractorState.DONE:
            return []

        out: list[str] = []
        self._buf += token

        if self._state == _ExtractorState.SCANNING:
            m = self._KEY_RE.search(self._buf)
            if m is None:
                if len(self._buf) > 4096:
                    self._buf = self._buf[-256:]
                return []
            self._buf = self._buf[m.end() :]
            self._state = _ExtractorState.IN_VALUE

        if self._state == _ExtractorState.IN_VALUE:
            decoded, remaining = self._decode_value(self._buf)
            self._buf = remaining
            if decoded:
                out.append(decoded)

        return out

    _SIMPLE_ESCAPES: ClassVar[dict[str, str]] = {
        "n": "\n",
        "t": "\t",
        "r": "\r",
        "\\": "\\",
        '"': '"',
        "/": "/",
        "b": "\b",
        "f": "\f",
    }

    def _decode_value(self, s: str) -> tuple[str, str]:
        """Decode JSON string content, return (decoded_text, leftover_buffer)."""
        out: list[str] = []
        i = 0
        while i < len(s):
            if self._escape:
                self._escape = False
                ch = s[i]
                if ch in self._SIMPLE_ESCAPES:
                    out.append(self._SIMPLE_ESCAPES[ch])
                    i += 1
                elif ch == "u":
                    if i + 4 < len(s):
                        hex_str = s[i + 1 : i + 5]
                        try:
                            out.append(chr(int(hex_str, 16)))
                        except ValueError:
                            out.append(f"\\u{hex_str}")
                        i += 5
                    else:
                        return "".join(out), "\\" + s[i:]
                else:
                    out.append(ch)
                    i += 1
                continue

            ch = s[i]
            if ch == "\\":
                if i + 1 >= len(s):
                    return "".join(out), s[i:]
                self._escape = True
                i += 1
            elif ch == '"':
                self._state = _ExtractorState.DONE
                return "".join(out), ""
            else:
                out.append(ch)
                i += 1

        return "".join(out), ""


def _extract_content_and_metrics(
    result: dict,
    user_id: str,
    last_user_content: str,
    run_id: str = "",
    memory_scope: str | None = None,
    model: str = "synesis-agent",
) -> tuple[str, int]:
    """Extract response content from graph result; store in memory; return (content, total_tokens).
    memory_scope: key for conversation-scoped memory (user_id or user_id:conversation_id)."""
    scope = memory_scope or user_id
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
            memory.store_turn(scope, "user", last_user_content)
        if content:
            memory.store_turn(scope, "assistant", content)
        # Update last_active_language and last_context for next turn's pivot detection
        lang = result.get("target_language", "python")
        if lang in ("", "infer"):
            lang = "markdown" if result.get("deliverable_type") == "explain_only" else "python"
        if lang:
            memory.set_last_active_language(scope, lang)
        memory.set_last_context(
            scope,
            result.get("output_type", "code"),
            result.get("active_domain_refs") or [],
        )

    # Store run context for feedback association (Phase 5)
    if run_id:
        from .feedback_store import store_run_context

        store_run_context(
            run_id=run_id,
            user_id=user_id,
            message_snippet=(last_user_content or "")[:200],
            response_snippet=(content or "")[:200],
            classification_reasons=result.get("classification_reasons") or [],
            score_breakdown=result.get("score_breakdown") or {},
            task_size=result.get("task_size") or "",
        )

    total_tokens = 0
    for trace in result.get("node_traces", []) or []:
        if hasattr(trace, "tokens_used"):
            total_tokens += trace.tokens_used
        node_name = trace.get("node_name", "") if isinstance(trace, dict) else getattr(trace, "node_name", "")
        confidence = trace.get("confidence", 0) if isinstance(trace, dict) else getattr(trace, "confidence", 0) or 0
        if node_name:
            record_node_confidence(node_name, confidence)

    record_graph_iterations(result.get("iteration_count", 1))
    record_tokens(model, total_tokens)
    return content, total_tokens


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest, http_request: Request):
    start = time.monotonic()

    user_id = _resolve_user_id(request, http_request)
    conversation_id = _resolve_conversation_id(request, http_request)
    memory_scope = _memory_scope_key(user_id, conversation_id)

    user_messages = [HumanMessage(content=m.content) for m in request.messages if m.role == "user"]

    if not user_messages:
        raise HTTPException(status_code=400, detail="No user messages provided")

    last_user_content = user_messages[-1].content if user_messages else ""
    task_size_override: str | None = None

    # A) UI-helper filter: reject follow-up suggestions, title/tag generators EARLY
    # Must run before pivot detection to prevent UI meta-requests from triggering
    # false context pivots and flushing conversation memory.
    ui_helper_type = classify_ui_helper_type(last_user_content)
    if ui_helper_type is not None:
        logger.info("message_filter_ui_helper", extra={"user_id": user_id, "helper_type": ui_helper_type})
        if ui_helper_type == "title":
            helper_content = "New Chat"
        elif ui_helper_type == "tags" or ui_helper_type == "follow_ups":
            helper_content = "[]"
        else:
            helper_content = ""
        return ChatCompletionResponse(
            choices=[
                Choice(
                    message=ChatMessage(role="assistant", content=helper_content),
                    finish_reason="stop",
                )
            ],
            usage=Usage(),
        )

    # Retrieve conversation history (scoped by conversation_id when provided)
    conversation_history: list[str] = []
    if settings.memory_enabled:
        conversation_history = memory.get_history(memory_scope)

    # Context-stability: detect pivot from language OR user context (documents vs code, domain switch)
    # Only meaningful when there IS prior conversation history to pivot from.
    current_lang = detect_language_deterministic(last_user_content)
    last_lang = memory.get_last_active_language(memory_scope) if settings.memory_enabled else None
    lang_pivot = bool(last_lang and current_lang != last_lang and conversation_history)

    last_ctx = memory.get_last_context(memory_scope) if settings.memory_enabled else None
    context_pivot = False
    domain_soft_shift = False
    pivot_to_label = ""
    _SHORT_FOLLOWUP_LIMIT = 50
    if last_ctx and conversation_history:
        engine = get_scoring_engine()
        current_analysis = engine.analyze(last_user_content[:800])
        curr_output_type = current_analysis.get("output_type", "code")
        curr_domains = set(str(d).strip().lower() for d in (current_analysis.get("active_domains") or []) if d)
        last_output_type, last_domains = last_ctx[0], set(str(d).strip().lower() for d in (last_ctx[1] or []) if d)

        output_type_changed = curr_output_type != last_output_type
        domains_differ = bool(curr_domains.symmetric_difference(last_domains))
        domains_have_overlap = bool(curr_domains & last_domains)

        # Guard 1: Short messages (< 50 chars) are almost always conversational
        # follow-ups, not topic switches. Skip domain-based pivot.
        is_short_followup = len(last_user_content.strip()) < _SHORT_FOLLOWUP_LIMIT

        if output_type_changed:
            context_pivot = True
            pivot_to_label = f"{last_output_type}→{curr_output_type}"
        elif domains_differ and not is_short_followup:
            # Guard 2: Same output_type — only hard-pivot when zero domain overlap.
            if not domains_have_overlap:
                context_pivot = True
            else:
                # Guard 3: Partial domain change with overlap → soft shift (keep history).
                domain_soft_shift = True

        if not context_pivot and (domains_differ or is_short_followup):
            logger.debug(
                "context_pivot_skipped",
                extra={
                    "reason": "short_followup" if is_short_followup else "domain_overlap",
                    "msg_len": len(last_user_content.strip()),
                    "curr_output": curr_output_type,
                    "last_output": last_output_type,
                    "overlap": sorted(curr_domains & last_domains)[:3],
                    "diff": sorted(curr_domains.symmetric_difference(last_domains))[:5],
                },
            )

    is_pivot = lang_pivot or context_pivot
    pivot_summary = ""
    if is_pivot:
        run_id_pre = str(uuid.uuid4())
        if settings.pivot_summary_enabled and conversation_history:
            interaction_mode = "do"
            # Determine pivot_type and era labels for taxonomy-aware summarizer
            if lang_pivot:
                pivot_type = "language"
                from_era = last_lang or "unknown"
                to_era = current_lang or "unknown"
                active_domain_refs_for_summary = last_ctx[1] if last_ctx else None
            elif context_pivot and last_ctx and curr_output_type != last_output_type:
                pivot_type = "output_type"
                from_era = last_output_type
                to_era = curr_output_type
                active_domain_refs_for_summary = last_ctx[1]
            else:
                pivot_type = "domain"
                from_era = ", ".join(sorted(last_domains)[:3]) if last_ctx and last_domains else "previous"
                to_era = ", ".join(sorted(curr_domains)[:3]) if curr_domains else "current"
                active_domain_refs_for_summary = last_ctx[1] if last_ctx else None
            pivot_summary = await summarize_pivot_history(
                conversation_history,
                from_era,
                to_era,
                interaction_mode,
                pivot_type=pivot_type,
                active_domain_refs=active_domain_refs_for_summary,
            )
            if context_pivot and pivot_to_label:
                pivot_summary = (pivot_summary + " " if pivot_summary else "") + f"Context: {pivot_to_label}."
        if conversation_history:
            archive_to_l2(run_id_pre, user_id, conversation_history)
        # Flush contaminated history — user switched task domain
        conversation_history = [f"[system]: Previous era: {pivot_summary}"] if pivot_summary else []
        user_messages = [HumanMessage(content=last_user_content)]  # only current request
        if settings.memory_enabled:
            memory.clear_user_history(memory_scope)
            memory.set_last_active_language(memory_scope, current_lang)
        logger.info(
            "context_pivot",
            extra={
                "user_id": user_id,
                "lang_pivot": lang_pivot,
                "context_pivot": context_pivot,
                "from_lang": last_lang,
                "to_lang": current_lang,
                "pivot_to": pivot_to_label,
            },
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
        "chat_request task_len=%d preview=%r memory_scope=%s",
        len(last_user_content or ""),
        _task_preview,
        memory_scope,
        extra={"user_id": user_id, "conversation_id": conversation_id},
    )

    # B) /why — explain classification of previous user message (no graph run)
    if _WHY_PATTERN.match(last_user_content or ""):
        text_to_explain = ""
        for m in reversed(request.messages):
            if m.role == "user" and m.content and m.content != last_user_content:
                text_to_explain = m.content.strip()
                break
        if not text_to_explain:
            text_to_explain = last_user_content or "(no previous message)"
        engine = get_scoring_engine()
        analysis = engine.analyze(text_to_explain)
        reasons = analysis.get("classification_reasons") or []
        breakdown = analysis.get("score_breakdown") or {}
        task_size = analysis.get("task_size", "small")
        score = analysis.get("score", 0)
        complexity = analysis.get("complexity_score", 0)
        risk = analysis.get("risk_score", 0)
        lines = [
            f"**Classification:** `{task_size}` (score={score})",
            f"**Axes:** complexity={complexity} | risk={risk}",
            "",
            "**Reasons:**",
            *([f"- {r}" for r in reasons] if reasons else ["- (no keyword hits)"]),
            "",
            "**Score breakdown:**",
            *([f"- {k}: {v:+d}" for k, v in sorted(breakdown.items())] if breakdown else ["- (empty)"]),
        ]
        content = "\n".join(lines)
        logger.info("why_command", extra={"user_id": user_id, "score": score, "task_size": task_size})
        return ChatCompletionResponse(
            choices=[
                Choice(
                    message=ChatMessage(role="assistant", content=content),
                    finish_reason="stop",
                )
            ],
            usage=Usage(),
        )

    # C) /reclassify — force task_size override for previous message (run graph with override)
    reclassify_match = _RECLASSIFY_PATTERN.match(last_user_content or "")
    if reclassify_match:
        override_val = reclassify_match.group(1).lower()
        # Use previous user message as the actual task
        prev_content = ""
        for m in reversed(request.messages):
            if m.role == "user" and m.content and m.content.strip() != (last_user_content or "").strip():
                prev_content = m.content.strip()
                break
        if prev_content:
            task_size_override = override_val
            last_user_content = prev_content
            user_messages = [HumanMessage(content=prev_content)]
            logger.info(
                "reclassify_override",
                extra={"user_id": user_id, "override": task_size_override, "original_preview": prev_content[:60]},
            )
        else:
            # No previous message — return hint
            logger.info("reclassify_no_prev", extra={"user_id": user_id})
            return ChatCompletionResponse(
                choices=[
                    Choice(
                        message=ChatMessage(
                            role="assistant",
                            content="`/reclassify` applies to your previous message. Send a task first, then use `/reclassify small` or `/reclassify complex` to override its classification.",
                        ),
                        finish_reason="stop",
                    )
                ],
                usage=Usage(),
            )

    # D) /test — force sandbox execution for previous message
    force_sandbox = False
    if _TEST_PATTERN.match(last_user_content or ""):
        prev_content = ""
        for m in reversed(request.messages):
            if m.role == "user" and m.content and m.content.strip() != (last_user_content or "").strip():
                prev_content = m.content.strip()
                break
        if prev_content:
            force_sandbox = True
            last_user_content = prev_content
            user_messages = [HumanMessage(content=prev_content)]
            logger.info("test_command", extra={"user_id": user_id, "preview": prev_content[:60]})
        else:
            logger.info("test_no_prev", extra={"user_id": user_id})
            return ChatCompletionResponse(
                choices=[
                    Choice(
                        message=ChatMessage(
                            role="assistant",
                            content="`/test` runs your previous code through the sandbox. Send a coding task first, then use `/test`.",
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
    coding_client = _is_coding_client(http_request)
    # Ensure task_description is never empty at graph entry (avoids robotic needs_input)
    initial_state: dict[str, Any] = {
        "messages": user_messages,
        "task_description": (last_user_content or "").strip()[:500],
        "task_size_override": task_size_override,
        "coding_client_detected": coding_client,
        "last_user_content": (last_user_content or "").strip()[:500],
        "max_iterations": settings.max_iterations,
        "injection_detected": injection_detected,
        "injection_scan_result": injection_scan_result,
        "run_id": run_id,
        "iteration_count": 0,
        "retrieval_params": retrieval_params,
        "user_id": user_id,
        "memory_scope": memory_scope,
        "conversation_history": conversation_history,
        "is_pivot": is_pivot,
        "domain_soft_shift": domain_soft_shift,
        "last_active_language": last_lang or "",
        "pivot_summary": pivot_summary,
        "token_budget_remaining": settings.max_tokens_per_request,
        "sandbox_minutes_used": 0.0,
        "lsp_calls_used": 0,
        "evidence_experiments_count": 0,
        "force_sandbox": force_sandbox,
    }

    # Unified pending question: plan approval, needs_input, or clarification (scoped by conversation)
    if settings.memory_enabled:
        pending = memory.get_and_clear_pending_question(memory_scope)
        if not pending:
            # Backward compat: migrate from legacy stores
            pending = memory.get_and_clear_pending_plan(memory_scope)
            if pending:
                pending["source_node"] = "planner"
            else:
                pending = memory.get_and_clear_pending_needs_input(memory_scope)
                if pending:
                    pending["source_node"] = "worker"

        if pending:
            logger.info(
                "pending_restored",
                extra={
                    "user_id": user_id,
                    "memory_scope": memory_scope,
                    "source_node": pending.get("source_node"),
                    "pending_output_type": pending.get("output_type"),
                },
            )
            # Task drift: reply diverges from pending (new requirements, different direction)
            if pending_reply_diverges(pending, last_user_content):
                logger.info(
                    "pending_drift_detected",
                    extra={"user_id": user_id, "reply_len": len(last_user_content or "")},
                )
                pending = None
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
                    "output_type",
                    "deliverable_type",
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
                    "output_type",
                    "deliverable_type",
                ):
                    if k in pending and pending[k] is not None:
                        initial_state[k] = pending[k]
            initial_state["pending_question_continue"] = True
            initial_state["pending_question_source"] = source_node if source_node != "planner" else "worker"

    if request.stream:
        chat_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

        if settings.streaming_events_enabled:
            # ── astream_events(v2): token-level streaming + inline node status ──

            _KNOWN_NODES = frozenset(
                {
                    "entry_classifier",
                    "strategic_advisor",
                    "supervisor",
                    "planner",
                    "context_curator",
                    "worker",
                    "patch_integrity_gate",
                    "sandbox",
                    "lsp_analyzer",
                    "critic",
                    "respond",
                }
            )

            async def sse_generator() -> object:
                yield _sse_status_chunk(
                    {"type": "status", "data": {"description": "Processing…", "done": False, "hidden": False}}
                )
                await asyncio.sleep(0)

                accumulated_state: dict[str, Any] = dict(initial_state)
                stream_content = True
                extractor = StreamingCodeExtractor()
                content_streamed = False
                sent_role = False
                task_size_val = ""
                deliverable_val = ""
                thinking_phases: list[str] = []
                thinking_block_emitted = False
                first_content_logged = False
                token_count_estimate = 0
                t_start = time.monotonic()
                # Diagnostic counters for reasoning vs content tokens
                _diag_stream_events = 0
                _diag_reasoning_chunks = 0
                _diag_content_chunks = 0
                _diag_empty_chunks = 0
                _diag_first_reasoning_ms: int | None = None
                _diag_first_content_ms: int | None = None
                _reasoning_buf = ""
                _last_reasoning_status = ""

                try:
                    async for event in graph.astream_events(
                        initial_state,
                        version="v2",
                        config={"recursion_limit": 50},
                    ):
                        kind = event["event"]
                        name = event.get("name", "")
                        meta = event.get("metadata", {})
                        lg_node = meta.get("langgraph_node", "")

                        # ── Node started → status SSE + accumulate thinking phases ──
                        if kind == "on_chain_start" and (name in _KNOWN_NODES or lg_node in _KNOWN_NODES):
                            node_label = name if name in _KNOWN_NODES else lg_node
                            desc = _status_for_node(node_label, task_size_val, deliverable_val)
                            if desc:
                                thinking_phases.append(desc)
                                yield _sse_status_chunk(
                                    {"type": "status", "data": {"description": desc, "done": False, "hidden": False}}
                                )
                                await asyncio.sleep(0)

                        # ── Node ended → accumulate state, emit plan steps ──
                        elif kind == "on_chain_end" and (name in _KNOWN_NODES or lg_node in _KNOWN_NODES):
                            output = event.get("data", {}).get("output")
                            if isinstance(output, dict):
                                for k, v in output.items():
                                    if k == "messages":
                                        if name == "respond":
                                            accumulated_state["messages"] = v
                                    else:
                                        accumulated_state[k] = v

                                if "task_size" in output:
                                    task_size_val = output["task_size"]
                                if "deliverable_type" in output:
                                    deliverable_val = output["deliverable_type"]

                                # Emit planner reasoning + plan steps as status + thinking
                                if name == "planner":
                                    exec_plan = output.get("execution_plan") or {}
                                    if isinstance(exec_plan, dict):
                                        reasoning = ""
                                        node_traces = output.get("node_traces", []) or []
                                        for t in node_traces:
                                            if isinstance(t, dict) and t.get("reasoning"):
                                                reasoning = str(t["reasoning"]).strip()
                                                break
                                            if hasattr(t, "reasoning") and t.reasoning:
                                                reasoning = str(t.reasoning).strip()
                                                break
                                        if not reasoning and exec_plan.get("reasoning"):
                                            reasoning = str(exec_plan.get("reasoning", "")).strip()
                                        if reasoning:
                                            short = reasoning[:80] + "…" if len(reasoning) > 80 else reasoning
                                            thinking_phases.append(f"\n\n**Plan:** {short}")
                                            yield _sse_status_chunk(
                                                {
                                                    "type": "status",
                                                    "data": {
                                                        "description": f"Plan: {short}",
                                                        "done": False,
                                                        "hidden": False,
                                                    },
                                                }
                                            )
                                            await asyncio.sleep(0)
                                        steps = exec_plan.get("steps", [])
                                        for i, s in enumerate(steps, 1):
                                            act = s.get("action", str(s)) if isinstance(s, dict) else str(s)
                                            if act:
                                                thinking_phases.append(f"{i}. {act}")
                                                yield _sse_status_chunk(
                                                    {
                                                        "type": "status",
                                                        "data": {"description": act, "done": False, "hidden": False},
                                                    }
                                                )
                                                await asyncio.sleep(0)

                        # ── Token streaming from worker LLM ──
                        elif kind == "on_chat_model_stream" and lg_node == "worker" and stream_content:
                            chunk_obj = event.get("data", {}).get("chunk")
                            if not chunk_obj:
                                continue
                            _diag_stream_events += 1
                            elapsed_now = int((time.monotonic() - t_start) * 1000)

                            if _diag_stream_events == 1:
                                _ak = getattr(chunk_obj, "additional_kwargs", {}) or {}
                                logger.info(
                                    "sse_first_worker_chunk_diag",
                                    extra={
                                        "elapsed_ms": elapsed_now,
                                        "content_sample": (chunk_obj.content or "")[:80],
                                        "has_reasoning_attr": hasattr(chunk_obj, "reasoning_content"),
                                        "reasoning_attr_val": (getattr(chunk_obj, "reasoning_content", None) or "")[:80],
                                        "ak_keys": sorted(_ak.keys())[:10],
                                        "ak_reasoning": (_ak.get("reasoning_content", "") or "")[:80],
                                        "chunk_type": type(chunk_obj).__name__,
                                    },
                                )

                            # Extract reasoning_content (DeepSeek R1 thinking tokens).
                            # Check multiple locations: langchain-openai >= 0.3.14 puts it
                            # on the chunk directly; older versions may put it in additional_kwargs;
                            # some versions drop it entirely (langchain-ai/langchain#34706).
                            rc = ""
                            if hasattr(chunk_obj, "reasoning_content") and chunk_obj.reasoning_content:
                                rc = chunk_obj.reasoning_content
                            elif hasattr(chunk_obj, "additional_kwargs"):
                                rc = (chunk_obj.additional_kwargs or {}).get("reasoning_content", "")
                            if rc:
                                _diag_reasoning_chunks += 1
                                if _diag_first_reasoning_ms is None:
                                    _diag_first_reasoning_ms = elapsed_now
                                    logger.info(
                                        "sse_first_reasoning_token",
                                        extra={
                                            "elapsed_ms": elapsed_now,
                                            "node": lg_node,
                                            "sample": rc[:120],
                                        },
                                    )
                                    # Immediate "Thinking..." status so the user sees feedback right away
                                    yield _sse_status_chunk(
                                        {
                                            "type": "status",
                                            "data": {
                                                "description": "Thinking…",
                                                "done": False,
                                                "hidden": False,
                                            },
                                        }
                                    )
                                    await asyncio.sleep(0)
                                _reasoning_buf += rc
                                # Extract headline-like phrases for live status updates
                                while "\n" in _reasoning_buf:
                                    line, _reasoning_buf = _reasoning_buf.split("\n", 1)
                                    line = line.strip()
                                    if not line or len(line) < 5:
                                        continue
                                    is_heading = (
                                        line.startswith("#")
                                        or line.startswith("**")
                                        or line.startswith("- ")
                                        or (line[0].isupper() and line.endswith(":"))
                                        or (line[0].isdigit() and ". " in line[:5])
                                        # Broader: any line > 20 chars starting with uppercase
                                        or (len(line) > 20 and line[0].isupper())
                                    )
                                    if is_heading and line != _last_reasoning_status:
                                        _last_reasoning_status = line
                                        short = line.lstrip("#*- ").strip().rstrip(":")
                                        if short and len(short) > 3:
                                            thinking_phases.append(f"  \u2192 {short}")
                                            yield _sse_status_chunk(
                                                {
                                                    "type": "status",
                                                    "data": {
                                                        "description": f"Thinking: {short[:80]}",
                                                        "done": False,
                                                        "hidden": False,
                                                    },
                                                }
                                            )
                                            await asyncio.sleep(0)

                            # Extract actual content tokens
                            content_tok = chunk_obj.content if hasattr(chunk_obj, "content") else ""
                            if content_tok:
                                _diag_content_chunks += 1
                                if _diag_first_content_ms is None:
                                    _diag_first_content_ms = elapsed_now
                                    logger.info(
                                        "sse_first_content_token",
                                        extra={
                                            "elapsed_ms": elapsed_now,
                                            "reasoning_chunks": _diag_reasoning_chunks,
                                            "node": lg_node,
                                        },
                                    )
                                # Explain-only: stream raw markdown tokens directly (no JSON extractor)
                                if deliverable_val == "explain_only":
                                    fragments = [content_tok]
                                else:
                                    fragments = extractor.feed(content_tok)
                                for fragment in fragments:
                                    if not fragment:
                                        continue
                                    if not thinking_block_emitted and thinking_phases:
                                        thinking_block_emitted = True
                                        elapsed_s = time.monotonic() - t_start
                                        phases_text = "\n".join(thinking_phases)
                                        thinking_html = (
                                            f'<details type="thinking" done="true">\n'
                                            f"<summary>Thought for {elapsed_s:.0f} seconds</summary>\n"
                                            f"{phases_text}\n"
                                            f"</details>\n\n"
                                        )
                                        yield _sse_content_delta(
                                            chat_id,
                                            {"role": "assistant", "content": thinking_html},
                                            run_id=run_id,
                                        )
                                        sent_role = True
                                    delta: dict[str, str] = {"content": fragment}
                                    if not sent_role:
                                        delta["role"] = "assistant"
                                        sent_role = True
                                    content_streamed = True
                                    token_count_estimate += 1
                                    if not first_content_logged:
                                        first_content_logged = True
                                        logger.info(
                                            "sse_first_content_delta",
                                            extra={"elapsed_ms": elapsed_now},
                                        )
                                    yield _sse_content_delta(chat_id, delta, run_id=run_id)
                            elif not rc:
                                _diag_empty_chunks += 1

                except Exception as e:
                    logger.exception("graph_execution_error")
                    record_chat_error(time.monotonic() - start)
                    yield f"event: error\ndata: {json.dumps({'error': str(e)[:200]})}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                if not accumulated_state.get("messages"):
                    yield f"event: error\ndata: {json.dumps({'error': 'Graph produced no result'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                # Stop status animation
                yield _sse_status_chunk({"type": "status", "data": {"description": "", "done": True, "hidden": False}})

                if content_streamed:
                    _extract_content_and_metrics(
                        accumulated_state,
                        user_id,
                        last_user_content,
                        run_id=run_id,
                        memory_scope=memory_scope,
                        model=request.model,
                    )
                    record_chat_success(time.monotonic() - start)
                else:
                    content, _ = _extract_content_and_metrics(
                        accumulated_state,
                        user_id,
                        last_user_content,
                        run_id=run_id,
                        memory_scope=memory_scope,
                        model=request.model,
                    )
                    record_chat_success(time.monotonic() - start)
                    thinking_prefix = ""
                    if not thinking_block_emitted and thinking_phases:
                        elapsed_s = time.monotonic() - t_start
                        phases_text = "\n".join(thinking_phases)
                        thinking_prefix = (
                            f'<details type="thinking" done="true">\n'
                            f"<summary>Thought for {elapsed_s:.0f} seconds</summary>\n"
                            f"{phases_text}\n"
                            f"</details>\n\n"
                        )
                    yield _sse_content_delta(
                        chat_id,
                        {"role": "assistant", "content": thinking_prefix + content},
                        run_id=run_id,
                    )

                total_elapsed_ms = int((time.monotonic() - t_start) * 1000)
                logger.info(
                    "sse_stream_complete",
                    extra={
                        "elapsed_ms": total_elapsed_ms,
                        "streamed": content_streamed,
                        "token_count_estimate": token_count_estimate,
                        "stream_events": _diag_stream_events,
                        "reasoning_chunks": _diag_reasoning_chunks,
                        "content_chunks": _diag_content_chunks,
                        "empty_chunks": _diag_empty_chunks,
                        "first_reasoning_ms": _diag_first_reasoning_ms,
                        "first_content_ms": _diag_first_content_ms,
                    },
                )

                yield _sse_chunk(
                    {
                        "id": chat_id,
                        "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                        "run_id": run_id,
                    }
                )
                yield "data: [DONE]\n\n"

        else:
            # ── Fallback: buffered astream(values) + StatusQueueCallback ──

            status_queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=128)
            status_callback = StatusQueueCallback(status_queue)

            async def sse_generator() -> object:
                yield _sse_status_chunk(
                    {"type": "status", "data": {"description": "Processing…", "done": False, "hidden": False}}
                )

                result = None
                heartbeat_task = None
                try:
                    config = {
                        "recursion_limit": 50,
                        "callbacks": [status_callback],
                    }

                    async def _heartbeat(queue: asyncio.Queue, interval: float = 5.0) -> None:
                        """Emit periodic keep-alive so proxies and Open WebUI see activity."""
                        while True:
                            await asyncio.sleep(interval)
                            with contextlib.suppress(asyncio.QueueFull):
                                queue.put_nowait("")

                    heartbeat_task = asyncio.create_task(_heartbeat(status_queue))

                    async for chunk in graph.astream(initial_state, stream_mode="values", config=config):
                        while True:
                            try:
                                cb_desc = status_queue.get_nowait()
                            except asyncio.QueueEmpty:
                                break
                            if cb_desc:
                                yield _sse_status_chunk(
                                    {
                                        "type": "status",
                                        "data": {"description": cb_desc, "done": False, "hidden": False},
                                    }
                                )

                        result = chunk
                        node = chunk.get("current_node", "")
                        task_size = chunk.get("task_size", "")
                        deliverable_type = chunk.get("deliverable_type", "")
                        exec_plan = chunk.get("execution_plan") or {}
                        steps = exec_plan.get("steps", []) if isinstance(exec_plan, dict) else []
                        emitted_plan = False
                        if node == "planner" and isinstance(exec_plan, dict):
                            node_traces = chunk.get("node_traces", []) or []
                            reasoning = ""
                            for t in node_traces:
                                if isinstance(t, dict) and t.get("reasoning"):
                                    reasoning = str(t["reasoning"]).strip()
                                    break
                                if hasattr(t, "reasoning") and t.reasoning:
                                    reasoning = str(t.reasoning).strip()
                                    break
                            if not reasoning and exec_plan.get("reasoning"):
                                reasoning = str(exec_plan.get("reasoning", "")).strip()
                            if reasoning:
                                short = reasoning[:80] + "…" if len(reasoning) > 80 else reasoning
                                yield _sse_status_chunk(
                                    {
                                        "type": "status",
                                        "data": {"description": f"Plan: {short}", "done": False, "hidden": False},
                                    }
                                )
                                emitted_plan = True
                            for s in steps:
                                act = s.get("action", str(s)) if isinstance(s, dict) else str(s)
                                if act:
                                    yield _sse_status_chunk(
                                        {
                                            "type": "status",
                                            "data": {"description": act, "done": False, "hidden": False},
                                        }
                                    )
                                    emitted_plan = True
                        if node:
                            desc = _status_for_node(node, task_size or "", deliverable_type or "")
                            if emitted_plan and node == "planner":
                                desc = ""
                            if desc:
                                yield _sse_status_chunk(
                                    {
                                        "type": "status",
                                        "data": {"description": desc, "done": False, "hidden": False},
                                    }
                                )
                        if getattr(settings, "stream_debug_chatter", False) and chunk:
                            for n, label, content in _format_debug_chatter(chunk):
                                if content:
                                    yield _sse_debug_chatter_event(n, label, content)
                except Exception as e:
                    logger.exception("graph_execution_error")
                    record_chat_error(time.monotonic() - start)
                    yield f"event: error\ndata: {json.dumps({'error': str(e)[:200]})}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                finally:
                    if heartbeat_task:
                        heartbeat_task.cancel()

                if not result:
                    yield f"event: error\ndata: {json.dumps({'error': 'Graph produced no result'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                yield _sse_status_chunk({"type": "status", "data": {"description": "", "done": True, "hidden": False}})
                content, _ = _extract_content_and_metrics(
                    result, user_id, last_user_content, run_id=run_id, memory_scope=memory_scope, model=request.model
                )
                record_chat_success(time.monotonic() - start)
                yield _sse_content_delta(
                    chat_id,
                    {"role": "assistant", "content": content},
                    run_id=run_id,
                )
                yield _sse_chunk(
                    {
                        "id": chat_id,
                        "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                        "run_id": run_id,
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
        config = {"recursion_limit": 50}
        result = await graph.ainvoke(initial_state, config=config)
    except Exception as e:
        logger.exception("graph_execution_error")
        record_chat_error(time.monotonic() - start)
        err_msg = str(e)[:200]  # Truncate for response
        detail = f"Graph execution failed: {err_msg}. Check planner logs and admin status page for model health."
        raise HTTPException(status_code=500, detail=detail) from e

    content, total_tokens = _extract_content_and_metrics(
        result, user_id, last_user_content, run_id=run_id, memory_scope=memory_scope, model=request.model
    )

    latency_ms = (time.monotonic() - start) * 1000
    record_chat_success(latency_ms / 1000)
    logger.info(
        "request_completed",
        extra={
            "user_id": user_id,
            "conversation_id": conversation_id,
            "latency_ms": latency_ms,
            "iterations": result.get("iteration_count", 0),
            "total_tokens": total_tokens,
            "has_error": bool(result.get("error")),
            "memory_turns": memory.get_turn_count(memory_scope) if settings.memory_enabled else 0,
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
        run_id=run_id,
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


class FeedbackSubmitRequest(BaseModel):
    """Feedback from Open WebUI or webhook — thumbs up/down with association."""

    message_id: str = Field(..., description="Client message ID (e.g. from Open WebUI)")
    run_id: str = Field(..., description="Synesis run_id from response")
    vote: str = Field(..., description="up or down")
    user_id: str = ""
    model: str = ""


@app.post("/v1/feedback")
async def feedback_submit(req: FeedbackSubmitRequest):
    """Store thumbs up/down for tuning. Associates with run context (classification_reasons, etc.)."""
    from .feedback_store import FeedbackEntry, get_feedback_store, get_run_context_cache

    cache = get_run_context_cache()
    ctx = cache.get(req.run_id)
    store = get_feedback_store()
    if req.vote.lower() not in ("up", "down"):
        raise HTTPException(status_code=400, detail="vote must be 'up' or 'down'")
    entry = FeedbackEntry(
        message_id=req.message_id,
        run_id=req.run_id,
        vote=req.vote.lower(),
        user_id=req.user_id or (ctx.get("user_id", "") if ctx else ""),
        model=req.model or "synesis-agent",
        message_snippet=ctx.get("message_snippet", "") if ctx else "",
        response_snippet=ctx.get("response_snippet", "") if ctx else "",
        classification_reasons=ctx.get("classification_reasons", []) if ctx else [],
        score_breakdown=ctx.get("score_breakdown", {}) if ctx else {},
        task_size=ctx.get("task_size", "") if ctx else "",
        timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
    store.store(entry)
    logger.info(
        "feedback_stored",
        extra={"message_id": req.message_id[:16], "run_id": req.run_id[:8], "vote": req.vote},
    )
    return {"status": "stored", "run_id": req.run_id}


@app.get("/v1/feedback")
async def feedback_list(
    vote: str | None = None,
    limit: int = 50,
    offset: int = 0,
):
    """List stored feedback for admin/tuning. Filter by vote=up|down."""
    from .feedback_store import get_feedback_store

    store = get_feedback_store()
    entries = store.list_entries(vote=vote, limit=limit, offset=offset)
    return {
        "object": "list",
        "data": [
            {
                "message_id": e.message_id,
                "run_id": e.run_id,
                "vote": e.vote,
                "user_id": e.user_id,
                "model": e.model,
                "message_snippet": e.message_snippet,
                "response_snippet": e.response_snippet,
                "classification_reasons": e.classification_reasons,
                "score_breakdown": e.score_breakdown,
                "task_size": e.task_size,
                "timestamp": e.timestamp,
            }
            for e in entries
        ],
    }


class KnowledgeSubmitRequest(BaseModel):
    """User-submitted knowledge to fill gaps. Self-heal flow."""

    domain: str = Field(..., description="Domain (e.g. openshift, python, generalist)")
    content: str = Field(..., min_length=1, description="Markdown or plain text content")


@app.post("/v1/knowledge/submit")
async def knowledge_submit(req: KnowledgeSubmitRequest):
    """Submit user knowledge to synesis_catalog. Fills gaps from knowledge backlog review."""
    chunk_id = await submit_user_knowledge(
        domain=req.domain.strip() or "generalist",
        content=req.content.strip(),
        source="user_submitted",
    )
    if chunk_id:
        return {"chunk_id": chunk_id, "status": "ingested"}
    raise HTTPException(status_code=500, detail="Failed to submit knowledge")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/health/readiness")
async def readiness():
    return {"status": "ready"}


@app.get("/metrics")
async def metrics():
    """Prometheus metrics for retrieval, executor, web search, etc."""
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST,
    )
