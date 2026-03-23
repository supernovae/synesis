"""Synesis Planner -- FastAPI entrypoint exposing an OpenAI-compatible API.

This service wraps the LangGraph orchestrator behind /v1/chat/completions
so Open WebUI (and any OpenAI-compatible client) can talk to the full
Supervisor -> Worker -> Critic pipeline. Direct to planner; no proxy required.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import os
import re
import resource
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

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
    record_memory_after_request,
    record_node_confidence,
    record_prompt_cache_hit,
    record_prompt_cache_miss,
    record_prompt_cache_size,
    record_run_critic_turn_kind,
    record_tokens,
)
from .config import settings
from .conversation_memory import memory
from .entry_classifier_engine import get_scoring_engine
from .failure_store import record_error
from .graph import flush_tracer, get_graph_config, graph, snapshot_tracer_usage, upgrade_checkpointer_to_redis
from .history_summarizer import archive_to_l2, summarize_pivot_history
from .injection_scanner import reduce_context_on_injection, scan_model_output, scan_text, scan_user_input
from .message_filter import classify_ui_helper_type
from .nodes.entry_classifier import detect_language_deterministic
from .pending_drift import pending_reply_diverges
from .rag_client import build_metadata_filter, retrieve_context, submit_user_knowledge
from .run_context import compute_trace_links, derive_critic_turn_kind
from .short_followup_context import pick_richer_conversation_transcript, prior_transcript_from_request_messages
from .state import RetrievalParams
from .stream_fixer import StreamingBlockFixer
from .streaming_events import StatusQueueCallback, emit_sub_phase, set_sub_phase_queue
from .synesis_tracer import get_synesis_tracer

# /why and /reclassify command patterns
_WHY_PATTERN = re.compile(r"^\s*\/why\s*$", re.IGNORECASE)
_RECLASSIFY_PATTERN = re.compile(r"^\s*\/reclassify\s+(easy|medium|hard)\s*$", re.IGNORECASE)


from synesis_telemetry import configure_logging, get_logger
from synesis_telemetry import set_request_context as _set_telemetry_ctx

configure_logging(service="synesis-planner", level=settings.log_level)
logger = get_logger("synesis.api")

_background_tasks: set[asyncio.Task] = set()

# ---------------------------------------------------------------------------
# Prompt-level response cache (identical prompt+model → cached response)
# ---------------------------------------------------------------------------
_prompt_cache: dict[str, tuple[float, str]] = {}  # key → (expires_at, response_text)

_WS_RUN = re.compile(r"\s+")


def _normalize_prompt(prompt: str) -> str:
    """Normalize whitespace so trivial formatting differences don't miss cache."""
    return _WS_RUN.sub(" ", prompt.strip()).lower()


def _prompt_cache_key(prompt: str, model: str) -> str:
    raw = f"{_normalize_prompt(prompt)}\x00{model}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _prompt_cache_get(user_id: str, prompt: str, model: str) -> str | None:
    if not settings.prompt_cache_enabled:
        return None
    key = _prompt_cache_key(prompt, model)
    entry = _prompt_cache.get(key)
    if entry is None:
        record_prompt_cache_miss()
        return None
    expires_at, text = entry
    if time.monotonic() > expires_at:
        _prompt_cache.pop(key, None)
        record_prompt_cache_miss()
        record_prompt_cache_size(len(_prompt_cache))
        return None
    record_prompt_cache_hit()
    return text


def _prompt_cache_put(user_id: str, prompt: str, model: str, response: str) -> None:
    if not settings.prompt_cache_enabled or not response:
        return
    if len(_prompt_cache) >= settings.prompt_cache_max_entries:
        oldest_key = next(iter(_prompt_cache))
        _prompt_cache.pop(oldest_key, None)
    key = _prompt_cache_key(prompt, model)
    _prompt_cache[key] = (time.monotonic() + settings.prompt_cache_ttl_seconds, response)
    record_prompt_cache_size(len(_prompt_cache))


def _get_rss_mib() -> float:
    """Return current process RSS in MiB (for metrics and logging)."""
    rss_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if os.uname().sysname == "Darwin":
        return rss_kb / (1024 * 1024)
    return rss_kb / 1024


def _get_cgroup_mib() -> float:
    """Return cgroup memory usage in MiB if available, else 0."""
    for path in ("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"):
        try:
            with open(path) as f:
                return int(f.read().strip()) / (1024 * 1024)
        except OSError:
            continue
    return 0.0


def _log_rss(label: str) -> float:
    """Log current RSS in MiB and return the value for delta tracking."""
    rss_mib = _get_rss_mib()
    cgroup_mib = _get_cgroup_mib()
    logger.info(
        "startup_memory_checkpoint",
        extra={"label": label, "rss_mib": round(rss_mib, 1), "cgroup_mib": round(cgroup_mib, 1)},
    )
    return rss_mib


def _sample_memory_and_log(
    label: str,
    rss_mib: float | None = None,
    cgroup_mib: float | None = None,
    state: dict[str, Any] | None = None,
) -> tuple[float, float]:
    """Sample RSS/cgroup (or use provided), optionally log state size; return (rss_mib, cgroup_mib)."""
    if rss_mib is None:
        rss_mib = _get_rss_mib()
    if cgroup_mib is None:
        cgroup_mib = _get_cgroup_mib()
    extra: dict[str, Any] = {"label": label, "rss_mib": round(rss_mib, 1), "cgroup_mib": round(cgroup_mib, 1)}
    if state:
        packets = state.get("evidence_packets") or []
        traces = state.get("node_traces") or []
        msgs = state.get("messages") or []
        extra["state_evidence_packets"] = len(packets)
        extra["state_node_traces"] = len(traces)
        extra["state_messages"] = len(msgs)
    logger.info("request_memory_sample", extra=extra)
    return (rss_mib, cgroup_mib)


def _load_approved_conflict_groups() -> None:
    """Load admin-approved conflict groups from Postgres into the cohesion fast-path map."""
    import os

    db_url = os.getenv("SYNESIS_TRACE_DATABASE_URL", settings.trace_database_url)
    if not db_url:
        return
    try:
        import psycopg2

        dsn = db_url.replace("postgresql+asyncpg://", "postgresql://")
        conn = psycopg2.connect(dsn, connect_timeout=5)
        cur = conn.cursor()
        cur.execute(
            "SELECT group_name, members, exclusion_map FROM discovered_conflict_groups WHERE status = 'approved'"
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()

        if rows:
            from .cohesion import _merge_db_conflict_groups

            db_groups = [{"group_name": r[0], "members": r[1], "exclusion_map": r[2] or {}} for r in rows]
            _merge_db_conflict_groups(db_groups)
            logger.info("conflict_groups_loaded_from_db", extra={"count": len(rows)})
    except Exception:
        logger.debug("conflict_groups_db_load_failed", exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .entry_classifier_engine import get_scoring_engine
    from .intent_config_linter import lint_intent_config
    from .taxonomy_config_linter import lint_taxonomy_config
    from .taxonomy_prompt_factory import _load_config as _load_taxonomy_config

    logger.info(
        "Synesis planner starting build=%s port=%s",
        settings.build_version,
        settings.port,
    )
    _log_rss("lifespan_start")

    get_scoring_engine()
    _log_rss("after_scoring_engine")

    _load_taxonomy_config()
    _log_rss("after_taxonomy_load")

    intent_issues = lint_intent_config()
    if intent_issues:
        for msg in intent_issues:
            logger.warning("intent_config: %s", msg)
    taxonomy_issues = lint_taxonomy_config()
    if taxonomy_issues:
        for msg in taxonomy_issues:
            logger.warning("taxonomy_config: %s", msg)
    if settings.query_normalizer_enabled:
        from .query_normalizer import build_and_init_normalizer

        normalizer = build_and_init_normalizer()
        logger.info(
            "query_normalizer_ready",
            extra={"lexicon_size": len(normalizer._lexicon)},
        )
    _log_rss("after_normalizer")

    # Load admin-approved conflict groups into the fast-path map
    if settings.domain_profiling_enabled and settings.trace_database_url:
        try:
            _load_approved_conflict_groups()
        except Exception:
            logger.debug("conflict_groups_db_load_skipped", exc_info=True)

    logger.info(
        "sse_status_format",
        extra={
            "format": "event_key_wrapper",
            "openwebui_compatible": True,
            "streaming_events_enabled": settings.streaming_events_enabled,
        },
    )

    await upgrade_checkpointer_to_redis()
    _log_rss("after_checkpointer_upgrade")

    from .rag_client import init_milvus_pool

    await init_milvus_pool()
    _log_rss("after_milvus_pool_init")

    if settings.retrieval_cache_warm_on_startup:
        from .retrieval_cache import warm_cache

        task = asyncio.create_task(warm_cache())
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
        logger.info("warm_cache_scheduled")
    else:
        logger.info("warm_cache_disabled")

    _log_rss("lifespan_ready")
    yield
    logger.info("Synesis planner shutting down")


app = FastAPI(
    title="Synesis Planner",
    description="Synesis LLM orchestrator with Router/Worker/Critic loop",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip() for o in settings.cors_origins.split(",")
    ],  # nosemgrep: python.fastapi.security.wildcard-cors.wildcard-cors
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatMessage(BaseModel):
    """OpenAI-compatible message; content can be str, null, or array of parts (multimodal/tool)."""

    role: str
    content: str = ""

    @model_validator(mode="before")
    @classmethod
    def normalize_content(_cls, data: object) -> object:
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


class OutputControlsRequest(BaseModel):
    """Per-request output behavior overrides (all optional)."""

    precise: bool | None = None
    show_assumptions: bool | None = None
    clarify_first: bool | None = None


class StreamOptions(BaseModel):
    include_usage: bool = False


class ChatCompletionRequest(BaseModel):
    model: str = "synesis-agent"
    messages: list[ChatMessage]
    temperature: float = 0.2
    max_tokens: int | None = None
    max_completion_tokens: int | None = None
    stream: bool = False
    stream_options: StreamOptions | None = None
    user: str | None = None
    retrieval: RetrievalOptions | None = None
    conversation_id: str | None = None
    output_controls: OutputControlsRequest | None = None

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
    """OpenAI-compatible usage object returned on /v1/chat/completions.

    Token counts are aggregated from span-level LLM calls recorded by the
    SynesisTracer (same source as admin trace records).  Cost data is *not*
    included here — use the admin ``/api/v1/usage`` endpoints for estimated
    vs actual cost breakdowns.
    """

    prompt_tokens: int = Field(0, description="Sum of prompt tokens across all LLM calls in the pipeline")
    completion_tokens: int = Field(0, description="Sum of completion tokens across all LLM calls in the pipeline")
    total_tokens: int = Field(0, description="prompt_tokens + completion_tokens (pipeline total)")
    cached_prompt_tokens: int = Field(0, description="Tokens served from KV-cache (subset of prompt_tokens)")


class ChatCompletionResponse(BaseModel):
    id: str = Field(default_factory=lambda: f"chatcmpl-{uuid.uuid4().hex[:12]}")
    object: str = "chat.completion"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str = "synesis-agent"
    choices: list[Choice]
    usage: Usage
    run_id: str | None = None  # For feedback association (echo in POST /v1/feedback)
    pipeline_trace: dict[str, Any] | None = None


def _is_coding_client(http_request: Request) -> bool:
    """Detect Cursor, Claude Code, or other coding IDE/agent. Enables code bias for ambiguous requests."""
    ua = (http_request.headers.get("user-agent") or "").lower()
    x_client = (http_request.headers.get("x-client") or "").lower()
    x_app = (http_request.headers.get("x-app") or "").lower()
    for needle in ("cursor", "claude.code", "claude-code", "vscode", "codeium", "windsurf"):
        if needle in ua or needle in x_client or needle in x_app:
            return True
    return False


def _service_tokens() -> list[str]:
    out: list[str] = []
    one = settings.internal_service_token.strip()
    if one:
        out.append(one)
    many = settings.internal_service_tokens.strip()
    if many:
        out.extend([t.strip() for t in many.split(",") if t.strip()])
    return out


def _extract_bearer_token(http_request: Request) -> str:
    auth = (http_request.headers.get("authorization") or "").strip()
    if auth.startswith("Bearer ") and len(auth) > 7:
        return auth[7:].strip()
    return ""


def _is_trusted_service_bearer(token: str) -> bool:
    if not token:
        return False
    for candidate in _service_tokens():
        if hmac.compare_digest(token, candidate):
            return True
    if (
        settings.trust_model_api_key_for_forwarded_identity
        and not settings.strict_forwarded_identity_mode
        and settings.model_api_key
    ):
        if hmac.compare_digest(token, settings.model_api_key):
            return True
    return False


def _enforce_auth_and_header_trust(http_request: Request) -> tuple[str, bool]:
    bearer = _extract_bearer_token(http_request)
    if settings.planner_require_bearer_auth and not bearer:
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    trust_forwarded = bool(settings.trust_forwarded_identity_headers and _is_trusted_service_bearer(bearer))
    if settings.strict_forwarded_identity_mode and settings.trust_forwarded_identity_headers:
        has_forwarded = bool(
            http_request.headers.get("x-openwebui-user-id")
            or http_request.headers.get("x-openwebui-user-email")
            or http_request.headers.get("x-synesis-org-id")
            or http_request.headers.get("x-synesis-org-name")
            or http_request.headers.get("x-openwebui-chat-id")
        )
        if has_forwarded and not trust_forwarded:
            raise HTTPException(status_code=403, detail="Untrusted forwarded identity headers")
    return bearer, trust_forwarded


def _resolve_user_id(
    request_body: ChatCompletionRequest,
    http_request: Request,
    *,
    bearer_token: str,
    trust_forwarded_identity: bool,
) -> str:
    """Resolve user identity: Open WebUI header > request body > API key hash > anonymous."""
    owui_user = (http_request.headers.get("x-openwebui-user-id") or "").strip()
    if trust_forwarded_identity and owui_user:
        return owui_user[:128]
    if request_body.user:
        return request_body.user.strip()[:128]
    if bearer_token:
        return hashlib.sha256(bearer_token.encode()).hexdigest()[:16]
    return "anonymous"


def _resolve_user_email(http_request: Request, *, trust_forwarded_identity: bool) -> str:
    """Extract user email from Open WebUI forwarded headers (shared with Keycloak)."""
    if not trust_forwarded_identity:
        return ""
    return (http_request.headers.get("x-openwebui-user-email") or "").strip()[:256]


def _resolve_user_org(http_request: Request, *, trust_forwarded_identity: bool) -> tuple[str, str]:
    """Extract organization id/name from forwarded headers.

    Returns (org_id, org_name). Both empty when user has no org membership.
    """
    if not trust_forwarded_identity:
        return "", ""
    org_id = (http_request.headers.get("x-synesis-org-id") or "").strip()[:128]
    org_name = (http_request.headers.get("x-synesis-org-name") or "").strip()[:256]
    return org_id, org_name


def _resolve_conversation_id(
    request_body: ChatCompletionRequest,
    http_request: Request,
    *,
    trust_forwarded_identity: bool,
) -> str | None:
    """Resolve conversation scope: body > Open WebUI header > generic headers > None.
    When present, memory (history, pending plans) is scoped per conversation — avoids drift across chats."""
    if request_body.conversation_id and request_body.conversation_id.strip():
        return request_body.conversation_id.strip()[:128]
    header = (
        (http_request.headers.get("x-openwebui-chat-id") if trust_forwarded_identity else "")
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
    """Format debug_chatter event for plan/router/critic/writer outputs. Open WebUI can render as labeled block."""
    return f"event: debug_chatter\ndata: {json.dumps({'node': node, 'label': label, 'content': content})}\n\n"


def _format_debug_chatter(chunk: dict) -> list[tuple[str, str, str]]:
    """Extract (node, label, content) for debug chatter from a graph chunk."""
    out: list[tuple[str, str, str]] = []
    node = chunk.get("current_node", "")

    if node in ("entry_classifier", "entry_pipeline"):
        task_size = chunk.get("task_size", "")
        intent = chunk.get("intent_class", "")
        is_code_task = chunk.get("is_code_task", False)
        plan_req = chunk.get("plan_required", False)
        ctx = chunk.get("platform_context", "")
        domain = chunk.get("active_domain_refs") or []
        out.append(
            (
                "entry_pipeline",
                "Entry Pipeline",
                f"task_size={task_size} intent={intent} is_code_task={is_code_task} "
                f"plan_required={plan_req} platform={ctx} domains={domain}",
            )
        )

    elif node == "strategic_advisor":
        ctx = chunk.get("platform_context", "")
        domain = chunk.get("active_domain_refs") or []
        out.append(("strategic_advisor", "Router (Strategic Advisor)", f"platform={ctx} domains={domain}"))

    elif node == "router":
        next_n = chunk.get("next_node", "")
        packets = chunk.get("evidence_packets") or []
        out.append(("router", "Router", f"next_node={next_n} packets={len(packets)}"))

    elif node == "planner":
        exec_plan = chunk.get("execution_plan") or {}
        steps = exec_plan.get("steps", []) if isinstance(exec_plan, dict) else []
        lines = [f"{i + 1}. {s.get('action', s) if isinstance(s, dict) else s}" for i, s in enumerate(steps)]
        out.append(("planner", "Execution Plan", "\n".join(lines) if lines else "(no steps)"))

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
    """Format status event for Open WebUI routing.

    Open WebUI middleware parses each SSE data: line as JSON and checks for
    an "event" key. If found, it routes the payload to the Socket.IO event
    emitter which drives the status indicator above the chat.

    IMPORTANT: Do NOT use SSE named events (event: status\\n) — Open WebUI
    ignores those. The "event" key must be in the JSON payload itself.
    See: github.com/open-webui/open-webui/discussions/19254
    """
    return f"data: {json.dumps({'event': data})}\n\n"


def _emit_phase(
    description: str,
    done: bool = False,
    hidden: bool = False,
    detail: str | None = None,
) -> str:
    """Emit a phase/status event to Open WebUI.

    Thin wrapper over _sse_status_chunk for the common case of status updates.
    All phase emissions should use this helper for consistency.
    If detail is set, it is included so clients can show it within the phase block
    (e.g. subtext under the main description) without stacking separate events.
    """
    data: dict[str, Any] = {"description": description, "done": done, "hidden": hidden}
    if detail:
        data["detail"] = detail
    return _sse_status_chunk({"type": "status", "data": data})


class ThinkTagParser:
    """State machine for parsing <think>...</think> tags from streaming content.

    When vLLM sends reasoning as raw <think> tags in content (i.e. without
    --reasoning-parser), this splits the stream into reasoning vs content.
    Handles tags that span chunk boundaries via internal buffering.
    Also serves as belt-and-suspenders fallback when langchain-openai drops
    the reasoning_content field (langchain-ai/langchain#34706).
    """

    OPEN_TAG = "<think>"
    CLOSE_TAG = "</think>"

    def __init__(self) -> None:
        self._state = "scanning"  # scanning | thinking | done | passthrough
        self._buffer = ""

    def feed(self, token: str) -> tuple[str, str]:
        """Feed a content token. Returns (reasoning_text, content_text).
        At most one will be non-empty per call. Both empty means buffering.
        """
        if self._state == "passthrough":
            return ("", token)

        if self._state == "done":
            return ("", token)

        if self._state == "scanning":
            return self._scan(token)

        if self._state == "thinking":
            return self._process_thinking(token)

        return ("", token)

    def _scan(self, token: str) -> tuple[str, str]:
        self._buffer += token
        if self._buffer.startswith(self.OPEN_TAG):
            self._state = "thinking"
            remaining = self._buffer[len(self.OPEN_TAG) :]
            self._buffer = ""
            if remaining:
                return self._process_thinking(remaining)
            return ("", "")
        if len(self._buffer) >= len(self.OPEN_TAG):
            self._state = "passthrough"
            content = self._buffer
            self._buffer = ""
            return ("", content)
        if not self.OPEN_TAG.startswith(self._buffer):
            self._state = "passthrough"
            content = self._buffer
            self._buffer = ""
            return ("", content)
        return ("", "")

    def _process_thinking(self, token: str) -> tuple[str, str]:
        self._buffer += token
        close_idx = self._buffer.find(self.CLOSE_TAG)
        if close_idx >= 0:
            reasoning = self._buffer[:close_idx]
            content = self._buffer[close_idx + len(self.CLOSE_TAG) :]
            self._buffer = ""
            self._state = "done"
            content = content.lstrip("\n")
            return (reasoning, content)
        safe_len = len(self._buffer) - (len(self.CLOSE_TAG) - 1)
        if safe_len > 0:
            reasoning = self._buffer[:safe_len]
            self._buffer = self._buffer[safe_len:]
            return (reasoning, "")
        return ("", "")

    def flush(self) -> tuple[str, str]:
        """Flush remaining buffer. Call when stream ends."""
        if self._state == "thinking":
            reasoning = self._buffer
            self._buffer = ""
            return (reasoning, "")
        if self._state == "scanning":
            content = self._buffer
            self._buffer = ""
            return ("", content)
        return ("", "")

    @property
    def is_thinking(self) -> bool:
        return self._state in ("scanning", "thinking")

    @property
    def had_thinking(self) -> bool:
        return self._state in ("thinking", "done")


# User-friendly status messages for progressive feedback during graph execution.
# Open WebUI format: {"type": "status", "data": {"description": "...", "done": false, "hidden": false}}
# Other clients ignore these lines; only Open WebUI displays them.
# strategic_advisor = Domain Aligner (conceptual). Internal node name; display alias for docs/UX.
DOMAIN_ALIGNER_NODE = "strategic_advisor"

# Phase-based status: collapse many fast nodes into meaningful user-facing phases.
# Each node maps to a phase label.  Only phase transitions emit a new status event.
_NODE_TO_PHASE: dict[str, str] = {
    "entry_pipeline": "Analyzing request\u2026",
    "entry_classifier": "Analyzing request\u2026",
    "strategic_advisor": "Analyzing request\u2026",
    "frame_extractor": "Analyzing request\u2026",
    "planner": "Building plan\u2026",
    "plan_gate": "Validating plan\u2026",
    "router": "Gathering evidence\u2026",
    "writer": "Composing response\u2026",
    "critic": "Evaluating quality\u2026",
    "final_scrubber": "Polishing\u2026",
    "respond": "Finalizing\u2026",
}

# Heartbeat interval: re-emit status with elapsed time during long phases
_HEARTBEAT_AFTER_S = 5.0


def _resolve_node_from_event(event: dict[str, Any]) -> str | None:
    """Resolve graph node name from astream_events payload.

    LangGraph may put the node in metadata.langgraph_node or in name; name may
    be wrapped (e.g. with_telemetry_node). Prefer exact match, then substring.
    """
    meta = event.get("metadata") or {}
    lg_node = (meta.get("langgraph_node") or "").strip()
    if lg_node and lg_node in _NODE_TO_PHASE:
        return lg_node
    name = (event.get("name") or "").strip()
    if name in _NODE_TO_PHASE:
        return name
    name_lower = name.lower()
    for node in _NODE_TO_PHASE:
        if node in name_lower or node.replace("_", "") in name_lower.replace("_", ""):
            return node
    return None


def _phase_for_node(node: str) -> str:
    """Return the user-facing phase label for a node."""
    return _NODE_TO_PHASE.get(node, "")


def _phase_detail_hint(phase_label: str) -> str:
    """Short subtext for the current phase (shown as detail in same status event).

    Gives clarification within the phase block without stacking extra events.
    """
    p = (phase_label or "").lower()
    if "analyzing" in p or "request" in p:
        return "Interpreting intent and constraints"
    if "gathering" in p or "evidence" in p:
        return "Searching sources and ranking relevance"
    if "building" in p or "plan" in p:
        return "Mapping requirements to sections"
    if "composing" in p or "response" in p:
        return "Synthesizing evidence into narrative"
    if "evaluating" in p or "quality" in p:
        return "Checking coverage and grounding"
    if "polishing" in p:
        return "Final clarity and formatting"
    if "finalizing" in p:
        return "Preparing response"
    return ""


def _router_phase(input_data: dict) -> str:
    """Build a status label from router input state.

    Summarises what the router is doing: initial evidence gathering,
    section-specific retrieval, or refinement.  Also emits individual
    query descriptions as sub-phase morsels so the user sees each topic.
    """
    requests = input_data.get("evidence_requests") or []
    if not requests:
        return "Gathering evidence\u2026"

    for req in requests[:6]:
        desc = (req.get("description") or req.get("query") or "")[:60]
        if desc:
            emit_sub_phase(f"Researching: {desc}")

    if len(requests) == 1:
        q = (requests[0].get("description") or requests[0].get("query") or "")[:50]
        return f"Gathering evidence: {q}\u2026" if q else "Gathering evidence\u2026"
    return f"Gathering evidence ({len(requests)} topics)\u2026"


def _enrich_phase(base_phase: str, node: str, frame: dict) -> str:
    """Enrich a phase description with TaskFrame context.

    Adds lightweight counts and domain labels — never domain-specific content.
    Also emits individual topic morsels as sub-phases so the user sees what
    the system is working on during long planning/research phases.
    Falls back to the base phase if no frame data is available.
    """
    if not frame:
        return base_phase

    deliverables = [t.get("description", "") for t in (frame.get("tasks") or [])]
    domain_tags = frame.get("domain_tags") or []
    domain = domain_tags[0] if domain_tags else ""
    requirements = frame.get("goals") or []

    if node == "planner" and deliverables:
        for d in deliverables[:6]:
            short = d[:60] + "\u2026" if len(d) > 60 else d
            if short:
                emit_sub_phase(f"Planning: {short}")
        return f"Building plan for {len(deliverables)} deliverables\u2026"
    if node == "router":
        n = len(deliverables) or len(requirements)
        if n:
            return f"Gathering evidence ({n} topics)\u2026"
        if domain:
            return f"Gathering evidence: {domain.replace('_', ' ')}\u2026"
    if node == "critic" and (requirements or deliverables):
        n = len(requirements) + len(deliverables)
        return f"Evaluating {n} requirements\u2026"

    return base_phase


# StreamingCodeExtractor removed — Worker now produces plain markdown.
# All content tokens stream directly to the client.


def _build_pipeline_trace(state: dict[str, Any]) -> dict[str, Any]:
    """Build a structured pipeline trace from final graph state for observability.

    Returned dict is safe to serialize as JSON and embed in SSE or response metadata.
    """
    trace: dict[str, Any] = {}

    lock = state.get("cohesion_lock") or {}
    if lock:
        trace["cohesion_lock"] = {
            "entity": lock.get("entity", ""),
            "theory": lock.get("theory", ""),
            "exclude_signals": (lock.get("exclude_signals") or [])[:8],
        }

    node_traces = state.get("node_traces") or []
    if node_traces:
        trace["nodes"] = []
        for nt in node_traces:
            name = nt.get("node_name", "") if isinstance(nt, dict) else getattr(nt, "node_name", "")
            conf = nt.get("confidence", 0) if isinstance(nt, dict) else getattr(nt, "confidence", 0)
            latency = nt.get("latency_ms", 0) if isinstance(nt, dict) else getattr(nt, "latency_ms", 0)
            if name:
                trace["nodes"].append({"node": name, "confidence": conf, "latency_ms": latency})

    packets = state.get("evidence_packets") or []
    if packets:
        total_sources = 0
        total_snippets = 0
        for p in packets:
            sources = p.get("sources", []) if isinstance(p, dict) else getattr(p, "sources", [])
            snippets = p.get("snippets", []) if isinstance(p, dict) else getattr(p, "snippets", [])
            total_sources += len(sources)
            total_snippets += len(snippets)
        trace["evidence"] = {
            "packets": len(packets),
            "total_sources": total_sources,
            "total_snippets": total_snippets,
        }

    taxonomy_meta = state.get("taxonomy_metadata") or {}
    if taxonomy_meta:
        trace["taxonomy"] = {
            "key": taxonomy_meta.get("taxonomy_key", ""),
            "complexity": taxonomy_meta.get("complexity_score", 0),
            "output_style": taxonomy_meta.get("output_style", ""),
        }

    trace["task_size"] = state.get("task_size", "")
    trace["iteration_count"] = state.get("iteration_count", 1)

    if state.get("retrieval_degraded"):
        trace["retrieval"] = {
            "degraded": True,
            "notes": state.get("retrieval_degradation_notes", ""),
        }

    return trace


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

    # Guard: only use content from assistant (AI) messages.  If the graph
    # was interrupted before producing a response, the last message may
    # still be the user's HumanMessage — echoing it back would be a bug.
    if last_message and getattr(last_message, "type", "") == "ai":
        content = last_message.content
    elif last_message:
        logger.warning(
            "extract_content_not_ai_message",
            extra={"msg_type": getattr(last_message, "type", "unknown"), "run_id": run_id},
        )
        content = "I encountered an issue while processing your request. Please try again."
    else:
        content = "No response generated."

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
        lang = result.get("target_language") or "markdown"
        expl = result.get("code_explanation", "")
        is_code_task = result.get("is_code_task", False)
        parts = []
        if code.strip():
            if is_code_task:
                parts.append(f"```{lang}\n{code.strip()}\n```")
            else:
                parts.append(code.strip())
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

    # Output guardrail: detect signs of injection compliance before delivery
    if content and settings.injection_scan_enabled:
        output_scan = scan_model_output(content)
        if output_scan.detected:
            logger.warning(
                "output_guardrail_triggered",
                extra={
                    "patterns": output_scan.patterns_found[:5],
                    "excerpt": output_scan.excerpt[:200],
                    "run_id": run_id,
                },
            )

    if settings.memory_enabled:
        if last_user_content:
            memory.store_turn(scope, "user", last_user_content)
        if content:
            memory.store_turn(scope, "assistant", content)
        lang = result.get("target_language") or "markdown"
        if lang in ("", "infer"):
            lang = "markdown"
        if lang:
            memory.set_last_active_language(scope, lang)
        memory.set_last_context(
            scope,
            result.get("is_code_task", False),
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
        if isinstance(trace, dict):
            total_tokens += trace.get("tokens_used", 0)
        elif hasattr(trace, "tokens_used"):
            total_tokens += trace.tokens_used
        node_name = trace.get("node_name", "") if isinstance(trace, dict) else getattr(trace, "node_name", "")
        confidence = trace.get("confidence", 0) if isinstance(trace, dict) else getattr(trace, "confidence", 0) or 0
        if node_name:
            record_node_confidence(node_name, confidence)

    record_graph_iterations(result.get("iteration_count", 1))
    record_tokens(model, total_tokens)
    record_run_critic_turn_kind(str(result.get("critic_turn_kind") or "final"))
    return content, total_tokens


def _build_final_usage(tracer_usage: dict[str, int] | None = None, node_traces_total: int = 0) -> dict[str, int]:
    """Build the OpenAI-compatible usage dict for the final response.

    Prefers tracer-sourced breakdown (same aggregation written to the Postgres
    trace record).  Falls back to node_traces total when the tracer is
    unavailable or returned zeros.

    Open WebUI reads ``prompt_tokens`` / ``completion_tokens``; if only an
    aggregate exists (e.g. node_traces without tracer breakdown), attribute the
    total to ``completion_tokens`` so UIs do not show all zeros.
    """
    u = tracer_usage or snapshot_tracer_usage()
    pt = int(u.get("prompt_tokens", 0) or 0)
    ct = int(u.get("completion_tokens", 0) or 0)
    cached = int(u.get("cached_prompt_tokens", 0) or 0)
    total = int(u.get("total_tokens", 0) or 0)
    if total <= 0:
        total = pt + ct
    if total <= 0:
        total = int(node_traces_total or 0)
    if total > 0 and pt == 0 and ct == 0:
        ct = total
    return {
        "prompt_tokens": pt,
        "completion_tokens": ct,
        "total_tokens": total,
        "cached_prompt_tokens": cached,
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest, http_request: Request):
    start = time.monotonic()
    _sample_memory_and_log("request_start")

    bearer_token, trust_forwarded_identity = _enforce_auth_and_header_trust(http_request)
    if not trust_forwarded_identity and (
        http_request.headers.get("x-openwebui-user-id")
        or http_request.headers.get("x-openwebui-user-email")
        or http_request.headers.get("x-synesis-org-id")
        or http_request.headers.get("x-synesis-org-name")
    ):
        logger.warning("ignored_untrusted_forwarded_identity_headers")
    user_id = _resolve_user_id(
        request,
        http_request,
        bearer_token=bearer_token,
        trust_forwarded_identity=trust_forwarded_identity,
    )
    user_email = _resolve_user_email(http_request, trust_forwarded_identity=trust_forwarded_identity)
    org_id, org_name = _resolve_user_org(http_request, trust_forwarded_identity=trust_forwarded_identity)
    conversation_id = _resolve_conversation_id(
        request,
        http_request,
        trust_forwarded_identity=trust_forwarded_identity,
    )
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

    # Retrieve conversation history (scoped by conversation_id when provided), merged with the
    # client-provided transcript. UIs send full threads in ``messages``; L1 memory may be empty,
    # wrong scope, or truncated — without assistant lines, quiz answers like "b)" look context-free.
    conversation_history: list[str] = []
    if settings.memory_enabled:
        conversation_history = memory.get_history(memory_scope)
    client_prior = prior_transcript_from_request_messages(request.messages)
    conversation_history = pick_richer_conversation_transcript(conversation_history, client_prior)

    # Context-stability: detect pivot from language OR user context (documents vs code, domain switch)
    # Only meaningful when there IS prior conversation history to pivot from.
    current_lang = detect_language_deterministic(last_user_content)
    last_lang = memory.get_last_active_language(memory_scope) if settings.memory_enabled else None
    lang_pivot = bool(last_lang and current_lang != "infer" and current_lang != last_lang and conversation_history)

    last_ctx = memory.get_last_context(memory_scope) if settings.memory_enabled else None
    context_pivot = False
    domain_soft_shift = False
    pivot_to_label = ""
    _SHORT_FOLLOWUP_LIMIT = 50
    if last_ctx and conversation_history:
        engine = get_scoring_engine()
        current_analysis = engine.analyze(last_user_content[:800])
        curr_is_code_task = current_analysis.get("is_code_task", False)
        curr_domains = set(str(d).strip().lower() for d in (current_analysis.get("active_domains") or []) if d)
        last_is_code_task, last_domains = last_ctx[0], set(str(d).strip().lower() for d in (last_ctx[1] or []) if d)

        deliverable_changed = curr_is_code_task != last_is_code_task
        domains_differ = bool(curr_domains.symmetric_difference(last_domains))
        domains_have_overlap = bool(curr_domains & last_domains)

        # Guard 1: Short messages (< 50 chars) are almost always conversational
        # follow-ups, not topic switches. Skip domain-based pivot.
        is_short_followup = len(last_user_content.strip()) < _SHORT_FOLLOWUP_LIMIT

        if deliverable_changed and not is_short_followup:
            context_pivot = True
            pivot_to_label = f"{'text' if not last_is_code_task else 'single_file'}→{'text' if not curr_is_code_task else 'single_file'}"
        elif domains_differ and not is_short_followup:
            # Guard 2: Same sandbox mode — only hard-pivot when zero domain overlap.
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
                    "curr_is_code_task": curr_is_code_task,
                    "last_is_code_task": last_is_code_task,
                    "overlap": sorted(curr_domains & last_domains)[:3],
                    "diff": sorted(curr_domains.symmetric_difference(last_domains))[:5],
                },
            )

    is_pivot = lang_pivot or context_pivot
    pivot_summary = ""
    if is_pivot:
        run_id_pre = str(uuid.uuid4())
        if settings.pivot_summary_enabled and conversation_history:
            # Determine pivot_type and era labels for taxonomy-aware summarizer
            if lang_pivot:
                pivot_type = "language"
                from_era = last_lang or "unknown"
                to_era = current_lang or "unknown"
                active_domain_refs_for_summary = last_ctx[1] if last_ctx else None
            elif context_pivot and last_ctx and curr_is_code_task != last_is_code_task:
                pivot_type = "deliverable"
                from_era = "code" if last_is_code_task else "text"
                to_era = "code" if curr_is_code_task else "text"
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
        task_size = analysis.get("task_size", "medium")
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
    _set_telemetry_ctx(run_id=run_id, user_id=user_id)
    coding_client = _is_coding_client(http_request)
    initial_state: dict[str, Any] = {
        "messages": user_messages,
        "task_description": (last_user_content or "").strip()[:6000],
        "task_size_override": task_size_override,
        "coding_client_detected": coding_client,
        "last_user_content": (last_user_content or "").strip()[:6000],
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
        "conversation_id": conversation_id or "",
        "request_max_tokens": request.effective_max_tokens,
    }
    if request.output_controls:
        oc = request.output_controls
        initial_state["output_controls"] = {
            k: v
            for k, v in {
                "precise": oc.precise,
                "show_assumptions": oc.show_assumptions,
                "clarify_first": oc.clarify_first,
            }.items()
            if v is not None
        }

    # Unified pending question: plan approval, needs_input, or clarification (scoped by conversation)
    pending_used: dict[str, Any] | None = None
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
                    pending["source_node"] = "writer"

        if pending:
            logger.info(
                "pending_restored",
                extra={
                    "user_id": user_id,
                    "memory_scope": memory_scope,
                    "source_node": pending.get("source_node"),
                    "pending_is_code_task": pending.get("is_code_task"),
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
            pending_used = pending
            source_node = pending.get("source_node", "writer")
            context = pending.get("context", pending)
            for key, val in context.items():
                if key != "source_node" and val is not None:
                    initial_state[key] = val
            if source_node in ("executor", "writer"):
                initial_state["user_answer_to_needs_input"] = last_user_content
                for k in (
                    "task_description",
                    "target_language",
                    "execution_plan",
                    "assumptions",
                    "is_code_task",
                ):
                    if k in pending and pending[k] is not None:
                        initial_state[k] = pending[k]
            elif source_node == "planner_clarification":
                initial_state["user_answer_to_clarification"] = last_user_content
                initial_state["iteration_count"] = 1
            elif source_node == "router":
                initial_state["user_answer_to_clarification"] = last_user_content
            elif source_node == "planner":
                for k in (
                    "execution_plan",
                    "task_description",
                    "target_language",
                    "task_type",
                    "assumptions",
                    "failure_context",
                    "is_code_task",
                ):
                    if k in pending and pending[k] is not None:
                        initial_state[k] = pending[k]
            initial_state["pending_question_continue"] = True
            initial_state["pending_question_source"] = source_node

    _parent_tid, _root_tid, _trace_root = compute_trace_links(
        run_id=run_id,
        conversation_id=conversation_id,
        pending=pending_used,
    )
    initial_state["trace_root_id"] = _trace_root
    initial_state["critic_turn_kind"] = derive_critic_turn_kind(initial_state)

    _tracer = get_synesis_tracer()
    if _tracer is not None:
        _tracer.start_trace(
            trace_id=run_id,
            user_id=user_id,
            user_email=user_email,
            org_id=org_id,
            org_name=org_name,
            query=(last_user_content or "")[:500],
        )
        _tracer.set_session_links(
            conversation_id=conversation_id or "",
            parent_trace_id=_parent_tid or "",
            root_trace_id=_root_tid or run_id,
        )

    # Prompt-level cache: return cached response for identical (user + prompt + model)
    cached_response = _prompt_cache_get(user_id, last_user_content or "", request.model)
    if cached_response is not None:
        logger.info(
            "prompt_cache_hit",
            extra={"user_id": user_id, "run_id": run_id, "model": request.model},
        )
        if _tracer is not None:
            _tracer.mark_short_circuit("prompt_cache_hit")
            _tracer.record_phase_timing("prompt_cache", (time.monotonic() - start) * 1000)
        flush_tracer()
        record_chat_success(time.monotonic() - start)
        record_run_critic_turn_kind(str(initial_state.get("critic_turn_kind") or "final"))
        if request.stream:
            _cache_chat_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

            async def _cached_sse() -> Any:
                yield _sse_content_delta(
                    _cache_chat_id,
                    {"role": "assistant", "content": cached_response},
                    run_id=run_id,
                )
                yield _sse_chunk(
                    {
                        "id": _cache_chat_id,
                        "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                        "run_id": run_id,
                    }
                )
                yield "data: [DONE]\n\n"

            return StreamingResponse(
                _cached_sse(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
            )
        return ChatCompletionResponse(
            choices=[Choice(message=ChatMessage(role="assistant", content=cached_response), finish_reason="stop")],
            usage=Usage(),
            run_id=run_id,
        )

    if request.stream:
        chat_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

        if settings.streaming_events_enabled:
            # ── astream_events(v2): token-level streaming + inline node status ──

            async def sse_generator() -> object:
                yield _emit_phase("Starting\u2026")
                await asyncio.sleep(0)

                _flow_started = True

                def _flow_phase(desc: str, **kw: Any) -> str:
                    """Emit phase with › flow indicator after the first emission."""
                    detail = kw.pop("detail", None)
                    if _flow_started and desc and not kw.get("done"):
                        return _emit_phase(f"\u203a {desc}", detail=detail, **kw)
                    return _emit_phase(desc, detail=detail, **kw)

                accumulated_state: dict[str, Any] = dict(initial_state)
                # When inline critic is active (critic_background=False), suppress
                # writer content streaming to prevent draft concatenation
                # across critic rejection cycles.  Reasoning tokens still stream so
                # the thinking UI stays responsive.  Final content is emitted from
                # accumulated_state after the graph completes.
                stream_content = settings.critic_background
                content_streamed = False
                _stream_closed = False
                sent_role = False
                thinking_phases: list[str] = []
                first_content_logged = False
                _current_phase = ""
                _phase_start = 0.0
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
                _think_parser = ThinkTagParser()
                _consecutive_empty = 0
                _empty_thinking_emitted = False

                # Heartbeat queue — background task pushes keepalive strings
                # so proxies and clients see activity during long evidence phases.
                _hb_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=4)
                _hb_interval = _HEARTBEAT_AFTER_S

                # Sub-phase queue — graph nodes (e.g. entry_pipeline) push
                # fine-grained status updates via emit_sub_phase().
                _sub_phase_q: asyncio.Queue[str] = asyncio.Queue(maxsize=64)
                _sub_phase_token = set_sub_phase_queue(_sub_phase_q)

                async def _keepalive() -> None:
                    while True:
                        await asyncio.sleep(_hb_interval)
                        if _current_phase and not _stream_closed:
                            elapsed = int(time.monotonic() - _phase_start)
                            base = _current_phase.rstrip("\u2026")
                            with contextlib.suppress(asyncio.QueueFull):
                                _hb_queue.put_nowait(f"{base}\u2026 ({elapsed}s)")

                _hb_task = asyncio.create_task(_keepalive())

                # Track the pending __anext__ task outside the try block so
                # the finally can clean it up even on exception.
                _pending_next: asyncio.Task | None = None

                _block_fixer = StreamingBlockFixer() if stream_content else None

                try:
                    _event_iter = graph.astream_events(
                        initial_state,
                        version="v2",
                        config=get_graph_config(thread_id=run_id),
                    )
                    # Use asyncio.wait instead of asyncio.wait_for to poll
                    # for events.  wait_for cancels the __anext__() coroutine
                    # on timeout, which throws CancelledError into the async
                    # generator and destroys the entire graph.  asyncio.wait
                    # leaves the task alive on timeout so the generator is
                    # never corrupted.
                    while True:
                        # Drain sub-phase queue (entry_pipeline sub-steps, etc.)
                        while not _sub_phase_q.empty():
                            try:
                                sp_msg = _sub_phase_q.get_nowait()
                                if sp_msg and not _stream_closed:
                                    _current_phase = sp_msg
                                    _phase_start = time.monotonic()
                                    yield _flow_phase(sp_msg)
                                    await asyncio.sleep(0)
                            except asyncio.QueueEmpty:
                                break

                        # Drain keepalive queue continuously, even when no
                        # LangGraph events are emitted during long-running nodes.
                        while not _hb_queue.empty():
                            try:
                                hb_msg = _hb_queue.get_nowait()
                                if hb_msg and not _stream_closed:
                                    yield _flow_phase(hb_msg)
                                    await asyncio.sleep(0)
                            except asyncio.QueueEmpty:
                                break

                        if _pending_next is None:
                            _pending_next = asyncio.ensure_future(_event_iter.__anext__())

                        done, _ = await asyncio.wait({_pending_next}, timeout=1.0)

                        if not done:
                            # Timeout — no new event yet; loop to drain
                            # heartbeats and poll again without cancelling.
                            continue

                        try:
                            event = _pending_next.result()
                        except StopAsyncIteration:
                            _pending_next = None
                            break
                        _pending_next = None

                        if _stream_closed:
                            continue

                        kind = event["event"]
                        node_label = _resolve_node_from_event(event)

                        # ── Node started → phase-based status with elapsed heartbeat ──
                        if kind == "on_chain_start" and node_label:
                            phase = _phase_for_node(node_label)
                            now = time.monotonic()

                            section_phase = ""
                            if node_label == "router":
                                input_data = event.get("data", {}).get("input") or {}
                                section_phase = _router_phase(input_data)

                            effective_phase = section_phase or phase

                            if effective_phase and effective_phase != _current_phase:
                                _current_phase = effective_phase
                                _phase_start = now
                                if not section_phase:
                                    effective_phase = _enrich_phase(
                                        phase, node_label, accumulated_state.get("task_frame") or {}
                                    )
                                    _current_phase = effective_phase
                                thinking_phases.append(effective_phase)
                                detail = _phase_detail_hint(effective_phase)
                                yield _flow_phase(effective_phase, detail=detail if detail else None)
                                await asyncio.sleep(0)
                            elif phase and _current_phase and (now - _phase_start) >= _HEARTBEAT_AFTER_S:
                                elapsed = int(now - _phase_start)
                                _phase_base = _current_phase.rstrip("\u2026")
                                yield _flow_phase(f"{_phase_base}\u2026 ({elapsed}s)")
                                await asyncio.sleep(0)

                        # ── Node ended → accumulate state + rich status ──
                        elif kind == "on_chain_end" and node_label:
                            output = event.get("data", {}).get("output")
                            if isinstance(output, dict):
                                for k, v in output.items():
                                    if k == "messages":
                                        if node_label == "respond":
                                            accumulated_state["messages"] = v
                                    else:
                                        accumulated_state[k] = v

                                # Rich status: describe what the router found
                                if node_label == "router":
                                    # Degradation notice (RAG empty, web fallback, etc.)
                                    _deg_notes = output.get("retrieval_degradation_notes") or ""
                                    if _deg_notes:
                                        yield _flow_phase(_deg_notes[:120])
                                        await asyncio.sleep(0)

                                    packets = output.get("evidence_packets") or []
                                    if packets:
                                        for p in packets[:3]:
                                            if not isinstance(p, dict):
                                                continue
                                            q = (p.get("query") or "")[:60]
                                            sources = p.get("sources") or []
                                            web_n = sum(
                                                1 for s in sources if isinstance(s, dict) and s.get("type") == "web"
                                            )
                                            rag_n = len(sources) - web_n
                                            parts: list[str] = []
                                            if web_n:
                                                parts.append(f"{web_n} web")
                                            if rag_n:
                                                parts.append(f"{rag_n} docs")
                                            detail = f" ({' + '.join(parts)})" if parts else ""
                                            if q:
                                                yield _flow_phase(f"Searched: {q}{detail}")
                                                await asyncio.sleep(0)
                                    elif not _deg_notes:
                                        yield _flow_phase("No evidence found, answering from knowledge\u2026")
                                        await asyncio.sleep(0)

                                # Rich status: summarise the plan with step previews
                                elif node_label == "planner":
                                    plan = output.get("execution_plan") or {}
                                    steps = plan.get("steps", []) if isinstance(plan, dict) else []
                                    if steps:
                                        yield _flow_phase(f"Plan ready: {len(steps)} sections")
                                        await asyncio.sleep(0)
                                        for s in steps[:8]:
                                            act = s.get("action", "") if isinstance(s, dict) else str(s)
                                            if act:
                                                short = act[:80] + "\u2026" if len(act) > 80 else act
                                                yield _flow_phase(f"\u203a {short}")
                                                await asyncio.sleep(0)

                                # ── Background critic: close stream after writer ──
                                elif node_label == "writer" and content_streamed and settings.critic_background:
                                    yield _flow_phase("", done=True)
                                    content, total_tokens = _extract_content_and_metrics(
                                        accumulated_state,
                                        user_id,
                                        last_user_content,
                                        run_id=run_id,
                                        memory_scope=memory_scope,
                                        model=request.model,
                                    )
                                    _prompt_cache_put(user_id, last_user_content or "", request.model, content)
                                    record_chat_success(time.monotonic() - start)
                                    total_elapsed_ms = int((time.monotonic() - t_start) * 1000)
                                    logger.info(
                                        "sse_early_close",
                                        extra={
                                            "trigger": node_label,
                                            "elapsed_ms": total_elapsed_ms,
                                            "token_count_estimate": token_count_estimate,
                                            "critic_background": True,
                                        },
                                    )
                                    pipeline_trace = _build_pipeline_trace(accumulated_state)
                                    _early_finish = "length" if accumulated_state.get("writer_truncated") else "stop"
                                    _early_usage = _build_final_usage(None, total_tokens)
                                    yield _sse_chunk(
                                        {
                                            "id": chat_id,
                                            "object": "chat.completion.chunk",
                                            "choices": [{"index": 0, "delta": {}, "finish_reason": _early_finish}],
                                            "usage": _early_usage,
                                            "run_id": run_id,
                                            "pipeline_trace": pipeline_trace,
                                        }
                                    )
                                    yield "data: [DONE]\n\n"
                                    _stream_closed = True

                        # ── Token streaming from writer LLM ──
                        elif kind == "on_chat_model_stream":
                            _meta = event.get("metadata") or {}
                            _lg_node = _meta.get("langgraph_node") or ""
                            if _lg_node != "writer":
                                continue
                            chunk_obj = event.get("data", {}).get("chunk")
                            if not chunk_obj:
                                continue
                            _diag_stream_events += 1
                            elapsed_now = int((time.monotonic() - t_start) * 1000)

                            # Phase heartbeat during long-running LLM calls
                            if _current_phase and (time.monotonic() - _phase_start) >= _HEARTBEAT_AFTER_S:
                                _hb_elapsed = int(time.monotonic() - _phase_start)
                                _hb_msg = f"{_current_phase.rstrip(chr(0x2026))}\u2026 ({_hb_elapsed}s)"
                                yield _flow_phase(_hb_msg)
                                _phase_start = time.monotonic()

                            if _diag_stream_events == 1:
                                _ak = getattr(chunk_obj, "additional_kwargs", {}) or {}
                                _raw_content = getattr(chunk_obj, "content", None)
                                logger.info(
                                    "sse_first_writer_chunk_diag",
                                    extra={
                                        "elapsed_ms": elapsed_now,
                                        "content_sample": (str(_raw_content) or "")[:80],
                                        "content_type": type(_raw_content).__name__,
                                        "has_reasoning_attr": hasattr(chunk_obj, "reasoning_content"),
                                        "reasoning_attr_val": (getattr(chunk_obj, "reasoning_content", None) or "")[
                                            :80
                                        ],
                                        "ak_keys": sorted(_ak.keys())[:10],
                                        "ak_reasoning": (_ak.get("reasoning_content", "") or "")[:80],
                                        "chunk_type": type(chunk_obj).__name__,
                                        "has_text_attr": hasattr(chunk_obj, "text"),
                                    },
                                )

                            # ── Reasoning extraction (3 paths: langchain attr, <think> tags, empty-chunk fallback) ──

                            # Path 1: langchain-openai reasoning_content attribute
                            rc = ""
                            if hasattr(chunk_obj, "reasoning_content") and chunk_obj.reasoning_content:
                                rc = chunk_obj.reasoning_content
                            elif hasattr(chunk_obj, "additional_kwargs"):
                                rc = (chunk_obj.additional_kwargs or {}).get("reasoning_content", "")

                            # Path 2: <think> tag parsing from content stream
                            # (fallback when langchain drops reasoning_content — langchain-ai/langchain#34706,
                            #  or when vLLM runs without --reasoning-parser and sends raw <think> tags)
                            # Robust content extraction: .content can be None, str, or list
                            _raw = getattr(chunk_obj, "content", None)
                            if isinstance(_raw, str):
                                content_tok = _raw
                            elif isinstance(_raw, list):
                                content_tok = "".join(
                                    (p.get("text", "") if isinstance(p, dict) else str(p)) for p in _raw
                                )
                            else:
                                content_tok = ""
                            if content_tok and not rc:
                                think_rc, think_content = _think_parser.feed(content_tok)
                                if think_rc:
                                    rc = think_rc
                                content_tok = think_content
                            elif not content_tok and not rc and _think_parser.is_thinking:
                                pass

                            # Path 3: empty-chunk fallback — detect silent thinking by counting
                            # consecutive empty chunks before any content arrives
                            if not rc and not content_tok:
                                _consecutive_empty += 1
                                _diag_empty_chunks += 1
                                if _diag_empty_chunks in (1, 10, 100):
                                    _raw_c = getattr(chunk_obj, "content", None)
                                    logger.info(
                                        "sse_empty_chunk_sample",
                                        extra={
                                            "n": _diag_empty_chunks,
                                            "raw_content_type": type(_raw_c).__name__,
                                            "raw_content_repr": repr(_raw_c)[:120],
                                            "chunk_type": type(chunk_obj).__name__,
                                        },
                                    )
                                if _consecutive_empty >= 3 and not _empty_thinking_emitted:
                                    _empty_thinking_emitted = True
                                    yield _flow_phase("Thinking\u2026")
                                    await asyncio.sleep(0)
                                continue
                            _consecutive_empty = 0

                            # ── Process reasoning tokens (from any path) ──
                            if rc:
                                _diag_reasoning_chunks += 1
                                if _diag_first_reasoning_ms is None:
                                    _diag_first_reasoning_ms = elapsed_now
                                    logger.info(
                                        "sse_first_reasoning_token",
                                        extra={
                                            "elapsed_ms": elapsed_now,
                                            "node": _lg_node,
                                            "sample": rc[:120],
                                        },
                                    )
                                    yield _flow_phase("Thinking\u2026")
                                    await asyncio.sleep(0)

                                # Forward reasoning_content in SSE delta so Open
                                # WebUI renders it in the native "Thought for Xs"
                                # collapsible instead of only as status events.
                                yield _sse_content_delta(chat_id, {"reasoning_content": rc}, run_id=run_id)

                                _reasoning_buf += rc
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
                                        or (len(line) > 20 and line[0].isupper())
                                    )
                                    if is_heading and line != _last_reasoning_status:
                                        _last_reasoning_status = line
                                        short = line.lstrip("#*- ").strip().rstrip(":")
                                        if short and len(short) > 3:
                                            thinking_phases.append(f"  → {short}")

                            # ── Process content tokens (gated on stream_content) ──
                            # When inline critic is active, content tokens are
                            # suppressed to prevent draft concatenation on revision
                            # cycles.  Final content is emitted post-graph.
                            if content_tok and stream_content:
                                _diag_content_chunks += 1
                                if _diag_first_content_ms is None:
                                    _diag_first_content_ms = elapsed_now
                                    logger.info(
                                        "sse_first_content_token",
                                        extra={
                                            "elapsed_ms": elapsed_now,
                                            "reasoning_chunks": _diag_reasoning_chunks,
                                            "node": _lg_node,
                                        },
                                    )
                                fragments = _block_fixer.feed(content_tok) if _block_fixer else [content_tok]
                                for fragment in fragments:
                                    if not fragment:
                                        continue
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

                    # Flush any buffered fenced-block tail from the stream fixer
                    if _block_fixer:
                        for _flushed in _block_fixer.flush():
                            if _flushed:
                                _flush_delta: dict[str, str] = {"content": _flushed}
                                if not sent_role:
                                    _flush_delta["role"] = "assistant"
                                    sent_role = True
                                content_streamed = True
                                yield _sse_content_delta(chat_id, _flush_delta, run_id=run_id)
                        if _block_fixer.fixes:
                            logger.info(
                                "stream_fixer_summary",
                                extra={"fixes": _block_fixer.fixes},
                            )

                except Exception as _graph_exc:
                    _cur_node = accumulated_state.get("current_node", "unknown") if accumulated_state else "unknown"
                    _nxt_node = accumulated_state.get("next_node", "unknown") if accumulated_state else "unknown"
                    _err_state = accumulated_state.get("error", "") if accumulated_state else ""
                    _is_timeout = "timed out" in str(_err_state).lower() or "timeout" in str(_graph_exc).lower()
                    _error_code = "timeout" if _is_timeout else "graph_error"
                    logger.exception(
                        "graph_execution_error",
                        extra={
                            "current_node": _cur_node,
                            "next_node": _nxt_node,
                            "error_code": _error_code,
                            "state_error": str(_err_state)[:200] if _err_state else "",
                        },
                    )
                    record_error(
                        error_type=_error_code,
                        error_output=f"node={_cur_node} next={_nxt_node}: {str(_graph_exc)[:2000]}",
                        task_description=(last_user_content or "")[:2048],
                        trace_id=run_id,
                    )
                    record_chat_error(time.monotonic() - start)
                    rss_mib, cgroup_mib = _sample_memory_and_log("request_end")
                    record_memory_after_request(rss_mib, cgroup_mib)
                    try:
                        _err_payload = {
                            "error": "Graph execution failed. Check server logs for details.",
                            "error_code": _error_code,
                            "node": _cur_node,
                        }
                        yield f"event: error\ndata: {json.dumps(_err_payload)}\n\n"
                        yield "data: [DONE]\n\n"
                    except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
                        pass
                    return
                finally:
                    _hb_task.cancel()
                    set_sub_phase_queue(None)
                    if _pending_next is not None and not _pending_next.done():
                        _pending_next.cancel()
                    _tracer_usage = snapshot_tracer_usage()
                    flush_tracer()

                # Stream already closed (background critic mode) — skip all post-processing
                if _stream_closed:
                    return

                _msgs = accumulated_state.get("messages")
                _has_ai_msg = _msgs and any(getattr(m, "type", "") == "ai" for m in _msgs)
                if not _msgs or not _has_ai_msg:
                    if _msgs and not _has_ai_msg:
                        logger.warning("sse_no_ai_message msg_count=%d", len(_msgs))
                    yield f"event: error\ndata: {json.dumps({'error': 'Graph produced no result'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                # Flush any remaining think-parser buffer
                flush_rc, flush_content = _think_parser.flush()
                if flush_rc:
                    _reasoning_buf += flush_rc
                if flush_content and not content_streamed:
                    yield _sse_content_delta(
                        chat_id,
                        {"role": "assistant", "content": flush_content},
                        run_id=run_id,
                    )
                    content_streamed = True
                    sent_role = True

                # ── Deferred direct stream for text mode ──
                # When the writer returns a direct_stream_request
                # instead of calling langchain (which drops reasoning_content),
                # we stream directly via the raw openai SDK. This preserves
                # reasoning_content and gives fast time-to-first-token for
                # trivial tasks.
                _stream_req = accumulated_state.get("direct_stream_request")
                if _stream_req and not content_streamed:
                    # Close the pipeline-status section so Open WebUI collapses the
                    # phase indicators into a clean finished block BEFORE the
                    # native reasoning UI kicks in.
                    yield _flow_phase("", done=True)
                    await asyncio.sleep(0)

                    try:
                        import openai as _openai

                        _ds_base_url = _stream_req.pop("base_url", None) or settings.general_model_url
                        _ds_model = _stream_req.pop("model", None) or settings.general_model_name
                        _aclient = _openai.AsyncOpenAI(
                            base_url=_ds_base_url,
                            api_key=settings.model_api_key,
                        )
                        _ds_full_content = ""
                        _ds_in_reasoning = False
                        _ds_first_content = False
                        _ds_usage: dict[str, int] | None = (
                            None  # prompt_tokens, completion_tokens, cached_prompt_tokens
                        )
                        _ds_finish_reason: str | None = None
                        _ds_fixer = StreamingBlockFixer()
                        _ds_t0 = time.monotonic()

                        yield _sse_content_delta(chat_id, {"role": "assistant", "content": ""}, run_id=run_id)
                        sent_role = True
                        await asyncio.sleep(0)

                        _ds_stream = await _aclient.chat.completions.create(
                            model=_ds_model,
                            stream=True,
                            stream_options={"include_usage": True},
                            **_stream_req,
                        )
                        async for _ds_chunk in _ds_stream:
                            _ds_u = getattr(_ds_chunk, "usage", None)
                            if _ds_u is not None:
                                from .llm_usage_extract import normalize_usage_dict

                                _raw: dict = {}
                                if hasattr(_ds_u, "model_dump"):
                                    _raw = _ds_u.model_dump()
                                elif isinstance(_ds_u, dict):
                                    _raw = dict(_ds_u)
                                else:
                                    _raw = {
                                        "prompt_tokens": getattr(_ds_u, "prompt_tokens", None),
                                        "completion_tokens": getattr(_ds_u, "completion_tokens", None),
                                        "total_tokens": getattr(_ds_u, "total_tokens", None),
                                    }
                                    _ptd = getattr(_ds_u, "prompt_tokens_details", None)
                                    if _ptd is not None:
                                        if hasattr(_ptd, "model_dump"):
                                            _raw["prompt_tokens_details"] = _ptd.model_dump()
                                        elif isinstance(_ptd, dict):
                                            _raw["prompt_tokens_details"] = _ptd
                                        else:
                                            _raw["prompt_tokens_details"] = {
                                                "cached_tokens": getattr(_ptd, "cached_tokens", 0),
                                            }
                                _ds_norm = normalize_usage_dict(_raw)
                                _ds_usage = {
                                    "prompt_tokens": _ds_norm.prompt_tokens,
                                    "completion_tokens": _ds_norm.completion_tokens,
                                    "cached_prompt_tokens": _ds_norm.cached_prompt_tokens,
                                }
                            if not _ds_chunk.choices:
                                continue
                            _ds_choice = _ds_chunk.choices[0]
                            if _ds_choice.finish_reason:
                                _ds_finish_reason = _ds_choice.finish_reason
                            _ds_delta = _ds_choice.delta
                            _ds_rc = getattr(_ds_delta, "reasoning_content", None) or ""
                            _ds_ct = getattr(_ds_delta, "content", None) or ""

                            if _ds_rc:
                                _diag_reasoning_chunks += 1
                                if not _ds_in_reasoning:
                                    _ds_in_reasoning = True
                                    _diag_first_reasoning_ms = int((time.monotonic() - t_start) * 1000)
                                    _ds_source_node = accumulated_state.get("current_node") or "writer"
                                    logger.info(
                                        "sse_first_reasoning_token",
                                        extra={
                                            "elapsed_ms": _diag_first_reasoning_ms,
                                            "node": _ds_source_node,
                                            "sample": _ds_rc[:120],
                                            "source": "direct_stream",
                                        },
                                    )

                                # Forward reasoning_content in SSE delta — Open WebUI
                                # renders this natively as a collapsible "Thought for Xs"
                                # block.  No need for duplicate status events.
                                yield _sse_content_delta(chat_id, {"reasoning_content": _ds_rc}, run_id=run_id)

                            if _ds_ct:
                                _diag_content_chunks += 1
                                if not _ds_first_content:
                                    _ds_first_content = True
                                    _diag_first_content_ms = int((time.monotonic() - t_start) * 1000)
                                    logger.info(
                                        "sse_first_content_token",
                                        extra={
                                            "elapsed_ms": _diag_first_content_ms,
                                            "reasoning_chunks": _diag_reasoning_chunks,
                                            "node": accumulated_state.get("current_node") or "writer",
                                            "source": "direct_stream",
                                        },
                                    )
                                _ds_frags = _ds_fixer.feed(_ds_ct) if _ds_fixer else [_ds_ct]
                                for _ds_frag in _ds_frags:
                                    if _ds_frag:
                                        yield _sse_content_delta(chat_id, {"content": _ds_frag}, run_id=run_id)
                                _ds_full_content += _ds_ct
                                content_streamed = True
                                token_count_estimate += 1

                        # Flush direct-stream block fixer
                        if _ds_fixer:
                            for _ds_fl in _ds_fixer.flush():
                                if _ds_fl:
                                    yield _sse_content_delta(chat_id, {"content": _ds_fl}, run_id=run_id)

                        accumulated_state["generated_code"] = _ds_full_content

                        if _ds_finish_reason == "length":
                            accumulated_state["writer_truncated"] = True
                            _trunc_parts = []
                            if _ds_usage:
                                _trunc_total = _ds_usage.get("prompt_tokens", 0) + _ds_usage.get("completion_tokens", 0)
                                if _trunc_total:
                                    _trunc_parts.append(f"{_trunc_total:,} tokens used")
                            _trunc_notice = (
                                "\n\n---\n"
                                "**Note:** This response was truncated because it reached the "
                                "output token limit."
                                + (f" ({', '.join(_trunc_parts)})" if _trunc_parts else "")
                                + " You can ask me to continue from where I left off."
                            )
                            yield _sse_content_delta(chat_id, {"content": _trunc_notice}, run_id=run_id)
                            _ds_full_content += _trunc_notice
                            accumulated_state["generated_code"] = _ds_full_content
                            logger.warning(
                                "direct_stream_truncated",
                                extra={
                                    "finish_reason": "length",
                                    "completion_tokens": _ds_usage.get("completion_tokens", 0) if _ds_usage else 0,
                                },
                            )

                        if _ds_usage:
                            _ds_node = accumulated_state.get("current_node") or "writer"
                            _ds_elapsed = (time.monotonic() - _ds_t0) * 1000
                            _ds_prompt_text = ""
                            _ds_msgs = _stream_req.get("messages") or []
                            if _ds_msgs:
                                _last_msg = _ds_msgs[-1]
                                _ds_prompt_text = (
                                    _last_msg.get("content", "") if isinstance(_last_msg, dict) else str(_last_msg)
                                )
                            from .synesis_tracer import get_synesis_tracer as _get_ds_tracer

                            _ds_tracer = _get_ds_tracer()
                            if _ds_tracer is not None:
                                _ds_tracer.record_direct_stream_usage(
                                    node=_ds_node,
                                    model=_ds_model,
                                    prompt_tokens=_ds_usage["prompt_tokens"],
                                    completion_tokens=_ds_usage["completion_tokens"],
                                    cached_prompt_tokens=_ds_usage.get("cached_prompt_tokens", 0),
                                    prompt_text=_ds_prompt_text,
                                    completion_text=_ds_full_content,
                                    latency_ms=_ds_elapsed,
                                )
                    except Exception:
                        logger.exception("direct_stream_error")
                        yield _sse_content_delta(
                            chat_id,
                            {"content": "\n\n*Error during direct stream. Check server logs for details.*"},
                            run_id=run_id,
                        )
                        content_streamed = True

                # If empty-chunk fallback detected thinking but no phases were extracted,
                # add a generic timing phase so the thinking block still renders
                if (
                    _empty_thinking_emitted
                    and not thinking_phases
                    and _diag_reasoning_chunks == 0
                    and _diag_empty_chunks > 3
                ):
                    elapsed_s = time.monotonic() - t_start
                    thinking_phases.append(f"  \u2192 Reasoned for {elapsed_s:.0f}s")

                # Stop status animation
                yield _flow_phase("", done=True)

                content, total_tokens = _extract_content_and_metrics(
                    accumulated_state,
                    user_id,
                    last_user_content,
                    run_id=run_id,
                    memory_scope=memory_scope,
                    model=request.model,
                )
                _prompt_cache_put(user_id, last_user_content or "", request.model, content)
                record_chat_success(time.monotonic() - start)
                rss_mib, cgroup_mib = _sample_memory_and_log("request_end", state=accumulated_state)
                record_memory_after_request(rss_mib, cgroup_mib)

                if content_streamed:
                    if accumulated_state.get("writer_truncated"):
                        _trunc_note = (
                            "\n\n---\n"
                            "**Note:** This response was truncated because it reached the "
                            "output token limit."
                            + (f" ({total_tokens:,} tokens used)" if total_tokens else "")
                            + " You can ask me to continue from where I left off."
                        )
                        yield _sse_content_delta(chat_id, {"content": _trunc_note}, run_id=run_id)
                elif len(content) > 2000:
                    # Progressive streaming for large non-streamed content
                    # (e.g. light-mode compiler). Break on paragraph boundaries
                    # for a natural rendering cadence.
                    paragraphs = content.split("\n\n")
                    first = True
                    for para in paragraphs:
                        chunk_text = para if first else f"\n\n{para}"
                        delta: dict[str, str] = {"content": chunk_text}
                        if first:
                            delta["role"] = "assistant"
                            first = False
                        yield _sse_content_delta(chat_id, delta, run_id=run_id)
                        await asyncio.sleep(0)
                else:
                    yield _sse_content_delta(
                        chat_id,
                        {"role": "assistant", "content": content},
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

                pipeline_trace = _build_pipeline_trace(accumulated_state)
                _final_finish = "length" if accumulated_state.get("writer_truncated") else "stop"
                _final_usage = _build_final_usage(_tracer_usage, total_tokens)
                yield _sse_chunk(
                    {
                        "id": chat_id,
                        "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": _final_finish}],
                        "usage": _final_usage,
                        "run_id": run_id,
                        "pipeline_trace": pipeline_trace,
                    }
                )
                yield "data: [DONE]\n\n"

        else:
            # ── Fallback: buffered astream(values) + StatusQueueCallback ──

            status_queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=128)
            status_callback = StatusQueueCallback(status_queue)

            async def sse_generator() -> object:
                yield _emit_phase("Starting\u2026")

                _fb_flow_started = True

                def _fb_flow_phase(desc: str, **kw: Any) -> str:
                    detail = kw.pop("detail", None)
                    if _fb_flow_started and desc and not kw.get("done"):
                        return _emit_phase(f"\u203a {desc}", detail=detail, **kw)
                    return _emit_phase(desc, detail=detail, **kw)

                # Sub-phase queue for entry_pipeline sub-steps
                _fb_sub_q: asyncio.Queue[str] = asyncio.Queue(maxsize=64)
                _fb_sub_token = set_sub_phase_queue(_fb_sub_q)

                result = None
                heartbeat_task = None
                try:
                    config = get_graph_config(thread_id=run_id)
                    config.setdefault("callbacks", []).append(status_callback)

                    async def _heartbeat(queue: asyncio.Queue, interval: float = 5.0) -> None:
                        """Emit periodic keep-alive so proxies and Open WebUI see activity."""
                        while True:
                            await asyncio.sleep(interval)
                            with contextlib.suppress(asyncio.QueueFull):
                                queue.put_nowait("")

                    heartbeat_task = asyncio.create_task(_heartbeat(status_queue))

                    async for chunk in graph.astream(initial_state, stream_mode="values", config=config):
                        # Drain sub-phase queue
                        while not _fb_sub_q.empty():
                            try:
                                sp_msg = _fb_sub_q.get_nowait()
                                if sp_msg:
                                    yield _fb_flow_phase(sp_msg)
                            except asyncio.QueueEmpty:
                                break

                        while True:
                            try:
                                cb_desc = status_queue.get_nowait()
                            except asyncio.QueueEmpty:
                                break
                            if cb_desc:
                                yield _fb_flow_phase(cb_desc)

                        result = chunk
                        node = chunk.get("current_node", "")
                        exec_plan = chunk.get("execution_plan") or {}
                        steps = exec_plan.get("steps", []) if isinstance(exec_plan, dict) else []
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
                                short = reasoning[:80] + "\u2026" if len(reasoning) > 80 else reasoning
                                yield _fb_flow_phase(f"Plan: {short}")
                            for s in steps:
                                act = s.get("action", str(s)) if isinstance(s, dict) else str(s)
                                if act:
                                    yield _fb_flow_phase(act)
                        if node:
                            desc = _phase_for_node(node)
                            if desc:
                                fb_detail = _phase_detail_hint(desc)
                                yield _fb_flow_phase(desc, detail=fb_detail or None)
                        if getattr(settings, "stream_debug_chatter", False) and chunk:
                            for n, label, content in _format_debug_chatter(chunk):
                                if content:
                                    yield _sse_debug_chatter_event(n, label, content)
                except Exception as _graph_exc:
                    _cur_node = result.get("current_node", "unknown") if result else "unknown"
                    _nxt_node = result.get("next_node", "unknown") if result else "unknown"
                    _err_state = result.get("error", "") if result else ""
                    _is_timeout = "timed out" in str(_err_state).lower() or "timeout" in str(_graph_exc).lower()
                    _error_code = "timeout" if _is_timeout else "graph_error"
                    logger.exception(
                        "graph_execution_error",
                        extra={
                            "current_node": _cur_node,
                            "next_node": _nxt_node,
                            "error_code": _error_code,
                            "state_error": str(_err_state)[:200] if _err_state else "",
                        },
                    )
                    record_error(
                        error_type=_error_code,
                        error_output=f"node={_cur_node} next={_nxt_node}: {str(_graph_exc)[:2000]}",
                        task_description=(last_user_content or "")[:2048],
                        trace_id=run_id,
                    )
                    record_chat_error(time.monotonic() - start)
                    rss_mib, cgroup_mib = _sample_memory_and_log("request_end")
                    record_memory_after_request(rss_mib, cgroup_mib)
                    _err_payload = {
                        "error": "Graph execution failed. Check server logs for details.",
                        "error_code": _error_code,
                        "node": _cur_node,
                    }
                    yield f"event: error\ndata: {json.dumps(_err_payload)}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                finally:
                    if heartbeat_task:
                        heartbeat_task.cancel()
                    set_sub_phase_queue(None)
                    _fb_tracer_usage = snapshot_tracer_usage()
                    flush_tracer()

                if not result:
                    yield f"event: error\ndata: {json.dumps({'error': 'Graph produced no result'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                yield _fb_flow_phase("", done=True)
                content, total_tokens = _extract_content_and_metrics(
                    result, user_id, last_user_content, run_id=run_id, memory_scope=memory_scope, model=request.model
                )
                _prompt_cache_put(user_id, last_user_content or "", request.model, content)
                record_chat_success(time.monotonic() - start)
                rss_mib, cgroup_mib = _sample_memory_and_log("request_end", state=result)
                record_memory_after_request(rss_mib, cgroup_mib)
                yield _sse_content_delta(
                    chat_id,
                    {"role": "assistant", "content": content},
                    run_id=run_id,
                )
                pipeline_trace = _build_pipeline_trace(result)
                _fb_finish = "length" if (result or {}).get("writer_truncated") else "stop"
                _fb_final_usage = _build_final_usage(_fb_tracer_usage, total_tokens)
                yield _sse_chunk(
                    {
                        "id": chat_id,
                        "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": _fb_finish}],
                        "usage": _fb_final_usage,
                        "run_id": run_id,
                        "pipeline_trace": pipeline_trace,
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
        config = get_graph_config(thread_id=run_id)
        result = await graph.ainvoke(initial_state, config=config)
    except Exception as _graph_exc:
        _is_timeout = "timeout" in str(_graph_exc).lower()
        _error_code = "timeout" if _is_timeout else "graph_error"
        logger.exception(
            "graph_execution_error",
            extra={"error_code": _error_code},
        )
        record_error(
            error_type=_error_code,
            error_output=str(_graph_exc)[:2000],
            task_description=(last_user_content or "")[:2048],
            trace_id=run_id,
        )
        record_chat_error(time.monotonic() - start)
        rss_mib, cgroup_mib = _sample_memory_and_log("request_end")
        record_memory_after_request(rss_mib, cgroup_mib)
        raise HTTPException(
            status_code=500,
            detail=f"Graph execution failed ({_error_code}). Check planner logs and admin status page for model health.",
        ) from None
    finally:
        _ns_tracer_usage = snapshot_tracer_usage()
        flush_tracer()

    content, total_tokens = _extract_content_and_metrics(
        result, user_id, last_user_content, run_id=run_id, memory_scope=memory_scope, model=request.model
    )
    _prompt_cache_put(user_id, last_user_content or "", request.model, content)

    latency_ms = (time.monotonic() - start) * 1000
    record_chat_success(latency_ms / 1000)
    rss_mib, cgroup_mib = _sample_memory_and_log("request_end", state=result)
    record_memory_after_request(rss_mib, cgroup_mib)
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
    pipeline_trace = _build_pipeline_trace(result)
    _ns_usage = _build_final_usage(_ns_tracer_usage, total_tokens)

    return ChatCompletionResponse(
        id=chat_id,
        model=request.model,
        choices=[
            Choice(
                message=ChatMessage(role="assistant", content=content),
            )
        ],
        usage=Usage(**_ns_usage),
        run_id=run_id,
        pipeline_trace=pipeline_trace,
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


class KnowledgeSearchRequest(BaseModel):
    """Label-scoped RAG search against the Synesis catalog."""

    query: str = Field(..., min_length=1, description="Search query")
    top_k: int = Field(default=5, ge=1, le=50, description="Number of results")
    language: str = Field(default="", description="Filter by language (e.g. python, go, rust)")
    artifact_kind: str = Field(default="", description="Filter by artifact kind (code, docs, config, api_spec)")
    domain: str = Field(default="", description="Filter by taxonomy domain (e.g. python, kubernetes)")
    repo_path: str = Field(default="", description="Filter by repository (e.g. owner/repo)")
    tags: str = Field(default="", description="Filter by tag substring (e.g. async, web)")
    content_format: str = Field(default="", description="Filter by content format (e.g. python, yaml)")


class KnowledgeSubmitRequest(BaseModel):
    """User-submitted knowledge to fill gaps. Self-heal flow."""

    domain: str = Field(..., description="Domain (e.g. openshift, python, generalist)")
    content: str = Field(..., min_length=1, description="Markdown or plain text content")


@app.post("/v1/knowledge/submit")
async def knowledge_submit(req: KnowledgeSubmitRequest):
    """Submit user knowledge to synesis_catalog. Fills gaps from knowledge backlog review."""
    content = req.content.strip()
    if settings.injection_scan_enabled:
        result = scan_text(content, source="user_knowledge_submit")
        if result.detected:
            logger.warning(
                "knowledge_submit_injection_blocked",
                extra={"patterns": result.patterns_found[:5]},
            )
            raise HTTPException(status_code=422, detail="Content rejected: potential prompt injection detected")
    chunk_id = await submit_user_knowledge(
        domain=req.domain.strip() or "generalist",
        content=content,
        source="user_submitted",
    )
    if chunk_id:
        return {"chunk_id": chunk_id, "status": "ingested"}
    raise HTTPException(status_code=500, detail="Failed to submit knowledge")


@app.post("/v1/knowledge/search")
async def knowledge_search(req: KnowledgeSearchRequest):
    """Label-scoped RAG search — Milvus pre-filtered by metadata signals.

    Supports filtering by language, artifact_kind, domain, repo_path, tags,
    and content_format.  Used by MCP tools (synesis_search, synesis_code_search,
    etc.) to give coding agents targeted corpus access.
    """
    domain_filter = ""
    if req.domain:
        safe = req.domain.replace('"', "")[:64]
        domain_filter = f'domain == "{safe}"'

    filter_expr = build_metadata_filter(
        language=req.language,
        artifact_kind=req.artifact_kind,
        repo_path=req.repo_path,
        domain_filter=domain_filter,
        tags=req.tags,
        content_format=req.content_format,
    )

    try:
        results = await retrieve_context(
            query=req.query,
            collections=["synesis_catalog"],
            top_k=req.top_k,
            domain_filter=filter_expr,
        )
    except Exception as e:
        logger.warning("knowledge_search_failed", extra={"error": str(e)[:200]})
        raise HTTPException(status_code=502, detail="Search backend unavailable") from e

    return {
        "results": [
            {
                "text": r.text,
                "source": r.source,
                "source_url": r.source_url,
                "document_name": r.document_name,
                "domain": r.domain,
                "language": r.language,
                "artifact_kind": r.artifact_kind,
                "repo_path": r.repo_path,
                "module_path": r.module_path,
                "symbol_name": r.symbol_name,
                "heading_path": r.heading_path,
                "authority": r.authority,
                "handler": r.handler,
                "source_type": r.source_type,
                "rrf_score": r.rrf_score,
                "rerank_score": r.rerank_score,
            }
            for r in results
        ],
        "count": len(results),
        "filters_applied": filter_expr or "(none)",
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/health/readiness")
async def readiness():
    return {"status": "ready"}


@app.get("/debug/sse-test")
async def sse_test():
    """Stream sample status events for verifying Open WebUI receives them.

    Simulates the full phase flow including entry pipeline sub-phases,
    router evidence gathering, and completion. Always available.
    Use: curl -N http://planner:8000/debug/sse-test
    """

    async def _gen():
        yield _emit_phase("Starting\u2026")
        await asyncio.sleep(0.5)
        # Entry pipeline sub-phases
        yield _emit_phase("\u203a Classifying request\u2026")
        await asyncio.sleep(0.5)
        yield _emit_phase("\u203a Classified: architecture_question (difficulty 0.7)")
        await asyncio.sleep(0.5)
        yield _emit_phase("\u203a Extracting intent & assessing strategy\u2026")
        await asyncio.sleep(1)
        yield _emit_phase("\u203a Analyzing request\u2026", detail="Interpreting intent and constraints")
        await asyncio.sleep(0.5)
        # Router phases
        yield _emit_phase("\u203a Generating queries for 2 topic(s)\u2026")
        await asyncio.sleep(0.5)
        yield _emit_phase("\u203a Retrieving & summarizing 2 evidence request(s)\u2026")
        await asyncio.sleep(1)
        yield _emit_phase("\u203a Evidence gathered: 2 packet(s), 8 snippet(s), avg confidence 72%")
        await asyncio.sleep(0.5)
        yield _emit_phase("\u203a Building plan\u2026")
        await asyncio.sleep(0.5)
        yield _emit_phase("\u203a Plan ready: 3 sections")
        await asyncio.sleep(0.5)
        yield _emit_phase("\u203a Composing response\u2026")
        await asyncio.sleep(1)
        yield _emit_phase("\u203a Evaluating quality\u2026")
        await asyncio.sleep(0.5)
        yield _emit_phase("\u203a Finalizing\u2026")
        await asyncio.sleep(0.3)
        yield _emit_phase("", done=True)
        yield _sse_content_delta(
            "test-sse", {"role": "assistant", "content": "SSE status events working. All phases rendered correctly."}
        )
        yield _sse_chunk(
            {
                "id": "test-sse",
                "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
        )
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.get("/metrics")
async def metrics():
    """Prometheus metrics for retrieval, writer, web search, etc."""
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST,
    )


@app.get("/debug/cache-stats")
async def cache_stats():
    """Cache statistics for admin observability."""
    stats: dict[str, Any] = {}

    # Prompt cache stats
    now = time.monotonic()
    active_entries = sum(1 for _, (exp, _) in _prompt_cache.items() if exp > now)
    stats["prompt_cache"] = {
        "enabled": settings.prompt_cache_enabled,
        "entries": active_entries,
        "max_entries": settings.prompt_cache_max_entries,
        "ttl_seconds": settings.prompt_cache_ttl_seconds,
    }

    # Frame cache stats
    try:
        from .nodes.frame_extractor import _frame_cache

        fc_active = sum(1 for _, (exp, _) in _frame_cache.items() if exp > now) if _frame_cache else 0
        stats["frame_cache"] = {
            "entries": fc_active,
        }
    except Exception:
        stats["frame_cache"] = {"entries": 0}

    # Retrieval cache stats
    try:
        from .retrieval_cache import get_retrieval_cache

        cache = get_retrieval_cache()
        size = len(cache._exact) if hasattr(cache, "_exact") else 0
        stats["retrieval_cache"] = {
            "backend": settings.retrieval_cache_backend,
            "size": size,
        }
    except Exception:
        stats["retrieval_cache"] = {
            "backend": getattr(settings, "retrieval_cache_backend", "unknown"),
            "size": 0,
        }

    # Redis info
    try:
        import redis.asyncio as aioredis

        redis_url = settings.retrieval_cache_redis_url or settings.session_redis_url
        if redis_url:
            r = aioredis.from_url(redis_url, decode_responses=True)
            info_mem = await r.info("memory")
            info_stats = await r.info("stats")
            info_keys = await r.info("keyspace")
            info_clients = await r.info("clients")
            await r.aclose()
            hits = int(info_stats.get("keyspace_hits", 0) or 0)
            misses = int(info_stats.get("keyspace_misses", 0) or 0)
            total = hits + misses
            hit_rate = round(hits / total, 4) if total > 0 else 0.0
            total_keys = 0
            for db_name, db_info in (info_keys or {}).items():
                if isinstance(db_info, str):
                    for part in db_info.split(","):
                        if part.strip().startswith("keys="):
                            total_keys += int(part.split("=")[1].strip())
                            break
                elif isinstance(db_info, dict):
                    total_keys += int(db_info.get("keys", 0) or 0)
            stats["redis"] = {
                "status": "connected",
                "used_memory_human": info_mem.get("used_memory_human", "0B"),
                "used_memory_bytes": int(info_mem.get("used_memory", 0) or 0),
                "connected_clients": int(info_clients.get("connected_clients", 0) or 0),
                "keyspace_hits": hits,
                "keyspace_misses": misses,
                "keyspace_hit_rate": round(hit_rate, 4),
                "total_keys": total_keys,
            }
        else:
            stats["redis"] = {"status": "not_configured"}
    except Exception as e:
        stats["redis"] = {"status": "error", "error": str(e)[:200]}

    # Session checkpointer
    stats["session"] = {
        "backend": settings.session_checkpointer_backend,
    }

    # L2 archive
    stats["l2_archive"] = {
        "configured": bool(settings.l2_archive_redis_url),
    }

    return stats
