"""SynesisTracer — lightweight LangChain callback that persists trace records to Redis.

Replaces the heavy Opik stack (ClickHouse, MySQL, ZooKeeper, Java backend)
with a zero-infrastructure alternative that reuses the existing Redis instance.

Trace lifecycle:
  1. Instantiated once at module level (like OpikTracer was).
  2. Attached as a LangChain callback via get_graph_config().
  3. Captures per-node spans and per-LLM-call detail from callback events.
  4. On flush(), persists the completed TraceRecord to Redis with TTL.

Storage schema:
  - synesis:traces:{trace_id}   → JSON blob (TraceRecord)
  - synesis:traces:index        → ZSET scored by timestamp for range queries
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult

logger = logging.getLogger("synesis.tracer")

_TRACE_KEY_PREFIX = "synesis:traces:"
_TRACE_INDEX_KEY = "synesis:traces:index"
_MAX_SNIPPET = int(os.environ.get("SYNESIS_TRACE_SNIPPET_MAX_CHARS", "500"))
_TTL_SECONDS = int(os.environ.get("SYNESIS_TRACE_TTL_HOURS", "168")) * 3600


# ---------------------------------------------------------------------------
# Data model — serialized as JSON into Redis
# ---------------------------------------------------------------------------


@dataclass
class LLMCallRecord:
    model: str = ""
    node: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    latency_ms: float = 0.0
    prompt_snippet: str = ""
    completion_snippet: str = ""
    timestamp: float = 0.0


@dataclass
class SpanRecord:
    node_name: str = ""
    start_time: float = 0.0
    end_time: float = 0.0
    latency_ms: float = 0.0
    tokens_used: int = 0
    confidence: float = 0.0
    outcome: str = ""
    reasoning: str = ""
    llm_calls: list[LLMCallRecord] = field(default_factory=list)


@dataclass
class TraceRecord:
    trace_id: str = ""
    user_id: str = ""
    query_snippet: str = ""
    timestamp: float = 0.0
    total_duration_ms: float = 0.0
    total_tokens: int = 0
    estimated_cost_usd: float = 0.0
    difficulty: float = 0.0
    task_type: str = ""
    domain_tags: list[str] = field(default_factory=list)
    is_code_task: bool = False
    has_error: bool = False
    iteration_count: int = 0
    spans: list[SpanRecord] = field(default_factory=list)
    critic_scores: dict[str, Any] = field(default_factory=dict)
    evidence_summary: dict[str, Any] = field(default_factory=dict)
    taxonomy: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Redis persistence helpers
# ---------------------------------------------------------------------------

_redis_client: Any = None


def _get_redis() -> Any:
    """Lazy-init Redis connection reusing the planner's SYNESIS_REDIS_URL."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    redis_url = os.environ.get("SYNESIS_REDIS_URL", "")
    if not redis_url:
        return None
    try:
        import redis as redis_lib

        _redis_client = redis_lib.Redis.from_url(redis_url, decode_responses=True)
        _redis_client.ping()
        logger.info("synesis_tracer_redis_ready", extra={"url": redis_url[:40]})
        return _redis_client
    except Exception:
        logger.warning("synesis_tracer_redis_failed", exc_info=True)
        return None


def _persist_trace(record: TraceRecord) -> None:
    """Write a completed trace record to Redis."""
    r = _get_redis()
    if r is None:
        return
    try:
        key = f"{_TRACE_KEY_PREFIX}{record.trace_id}"
        payload = json.dumps(asdict(record), default=str)
        pipe = r.pipeline(transaction=False)
        pipe.set(key, payload, ex=_TTL_SECONDS)
        pipe.zadd(_TRACE_INDEX_KEY, {record.trace_id: record.timestamp})
        cutoff = time.time() - _TTL_SECONDS
        pipe.zremrangebyscore(_TRACE_INDEX_KEY, "-inf", cutoff)
        pipe.execute()
    except Exception:
        logger.debug("synesis_tracer_persist_failed", exc_info=True)


# ---------------------------------------------------------------------------
# LangChain Callback Handler
# ---------------------------------------------------------------------------


class SynesisTracer(BaseCallbackHandler):
    """Lightweight LangChain callback that builds per-request trace records.

    Thread-safe for a single graph invocation at a time (the planner processes
    one request per graph.ainvoke / astream call).
    """

    name = "SynesisTracer"

    def __init__(self) -> None:
        super().__init__()
        self._current_trace: TraceRecord | None = None
        self._active_spans: dict[str, SpanRecord] = {}
        self._llm_starts: dict[str, tuple[float, str, str]] = {}  # run_id → (start_time, node, prompt_snippet)
        self._trace_start: float = 0.0

    # -- Trace lifecycle ---------------------------------------------------

    def start_trace(self, *, trace_id: str = "", user_id: str = "", query: str = "") -> None:
        """Begin a new trace (called from the API layer before graph.ainvoke)."""
        self._current_trace = TraceRecord(
            trace_id=trace_id or str(uuid.uuid4()),
            user_id=user_id,
            query_snippet=query[:_MAX_SNIPPET],
            timestamp=time.time(),
        )
        self._trace_start = time.monotonic()
        self._active_spans.clear()
        self._llm_starts.clear()

    def flush(self) -> None:
        """Persist the current trace and reset state."""
        if self._current_trace is None:
            return
        record = self._current_trace
        record.total_duration_ms = (time.monotonic() - self._trace_start) * 1000
        record.total_tokens = sum(sum(c.total_tokens for c in s.llm_calls) for s in record.spans)
        _persist_trace(record)
        self._current_trace = None
        self._active_spans.clear()
        self._llm_starts.clear()

    # -- Metadata setters (called from graph nodes) ------------------------

    def set_request_metadata(
        self,
        *,
        run_id: str = "",
        difficulty: float = 0.0,
        task_type: str = "",
        domain_tags: list[str] | None = None,
        evidence_packet_count: int = 0,
        avg_evidence_confidence: float = 0.0,
        critic_weighted_score: float = 0.0,
        critic_blocking_issues: int = 0,
        iteration_count: int = 0,
        is_code_task: bool = False,
        response_length: int = 0,
        has_error: bool = False,
    ) -> None:
        if self._current_trace is None:
            return
        t = self._current_trace
        t.difficulty = difficulty
        t.task_type = task_type
        t.domain_tags = (domain_tags or [])[:10]
        t.is_code_task = is_code_task
        t.has_error = has_error
        t.iteration_count = iteration_count
        t.evidence_summary = {
            "packets": evidence_packet_count,
            "avg_confidence": avg_evidence_confidence,
            "critic_weighted_score": critic_weighted_score,
            "critic_blocking_issues": critic_blocking_issues,
            "response_length": response_length,
        }

    def set_critic_scores(
        self,
        *,
        weighted_overall: float = 0.0,
        task_faithfulness: float = 0.0,
        constraint_compliance: float = 0.0,
        coverage: float = 0.0,
        judgment_quality: float = 0.0,
        failure_modes: list[str] | None = None,
        approved: bool = False,
        difficulty: float = 0.0,
        hallucinated_urls_count: int = 0,
    ) -> None:
        if self._current_trace is None:
            return
        self._current_trace.critic_scores = {
            "weighted_overall": weighted_overall,
            "task_faithfulness": task_faithfulness,
            "constraint_compliance": constraint_compliance,
            "coverage": coverage,
            "judgment_quality": judgment_quality,
            "failure_modes": failure_modes or [],
            "approved": approved,
            "difficulty": difficulty,
            "hallucinated_urls_count": hallucinated_urls_count,
        }

    def set_taxonomy(self, taxonomy: dict[str, Any]) -> None:
        if self._current_trace is None:
            return
        self._current_trace.taxonomy = {
            "path": taxonomy.get("path", ""),
            "complexity_score": taxonomy.get("complexity_score", 0),
            "persona_instructions": str(taxonomy.get("persona_instructions", ""))[:200],
        }

    # -- LangChain BaseCallbackHandler overrides ---------------------------

    def on_chain_start(
        self,
        serialized: dict[str, Any],
        inputs: dict[str, Any],
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: Any,
    ) -> None:
        if self._current_trace is None:
            return
        node_name = ""
        if tags:
            for tag in tags:
                if tag.startswith("graph:step:"):
                    node_name = tag.split(":", 2)[-1]
                    break
        name = node_name if node_name else serialized.get("name", "")
        if not name or name in ("RunnableSequence", "RunnableLambda", "RunnableParallel"):
            return
        span = SpanRecord(
            node_name=name,
            start_time=time.time(),
        )
        self._active_spans[str(run_id)] = span

    def on_chain_end(
        self,
        outputs: dict[str, Any],
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        rid = str(run_id)
        span = self._active_spans.pop(rid, None)
        if span is None or self._current_trace is None:
            return
        span.end_time = time.time()
        span.latency_ms = (span.end_time - span.start_time) * 1000
        self._current_trace.spans.append(span)

    def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        rid = str(run_id)
        span = self._active_spans.pop(rid, None)
        if span is None or self._current_trace is None:
            return
        span.end_time = time.time()
        span.latency_ms = (span.end_time - span.start_time) * 1000
        span.outcome = "error"
        span.reasoning = str(error)[:_MAX_SNIPPET]
        self._current_trace.spans.append(span)

    def on_llm_start(
        self,
        serialized: dict[str, Any],
        prompts: list[str],
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        **kwargs: Any,
    ) -> None:
        if self._current_trace is None:
            return
        prompt_text = prompts[0] if prompts else ""
        node = ""
        parent_span = self._active_spans.get(str(parent_run_id)) if parent_run_id else None
        if parent_span:
            node = parent_span.node_name
        self._llm_starts[str(run_id)] = (
            time.monotonic(),
            node,
            prompt_text[:_MAX_SNIPPET],
        )

    def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[Any]],
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        **kwargs: Any,
    ) -> None:
        if self._current_trace is None:
            return
        prompt_snippet = ""
        if messages and messages[0]:
            last_msg = messages[0][-1]
            content = getattr(last_msg, "content", str(last_msg))
            prompt_snippet = (content if isinstance(content, str) else str(content))[:_MAX_SNIPPET]
        node = ""
        parent_span = self._active_spans.get(str(parent_run_id)) if parent_run_id else None
        if parent_span:
            node = parent_span.node_name
        self._llm_starts[str(run_id)] = (
            time.monotonic(),
            node,
            prompt_snippet,
        )

    def on_llm_end(
        self,
        response: LLMResult,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        **kwargs: Any,
    ) -> None:
        if self._current_trace is None:
            return
        rid = str(run_id)
        start_info = self._llm_starts.pop(rid, None)
        start_time, node, prompt_snippet = start_info if start_info else (time.monotonic(), "", "")

        completion_snippet = ""
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0
        model = ""

        if response.generations and response.generations[0]:
            gen = response.generations[0][0]
            text = gen.text or ""
            if not text and hasattr(gen, "message"):
                msg_content = getattr(gen.message, "content", "")
                text = msg_content if isinstance(msg_content, str) else str(msg_content)
            completion_snippet = text[:_MAX_SNIPPET]

        if response.llm_output:
            usage = response.llm_output.get("token_usage") or response.llm_output.get("usage") or {}
            prompt_tokens = usage.get("prompt_tokens", 0)
            completion_tokens = usage.get("completion_tokens", 0)
            total_tokens = usage.get("total_tokens", 0) or (prompt_tokens + completion_tokens)
            model = response.llm_output.get("model_name", "") or response.llm_output.get("model", "")

        call = LLMCallRecord(
            model=model,
            node=node,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            latency_ms=(time.monotonic() - start_time) * 1000,
            prompt_snippet=prompt_snippet,
            completion_snippet=completion_snippet,
            timestamp=time.time(),
        )

        parent_span = self._active_spans.get(str(parent_run_id)) if parent_run_id else None
        if parent_span:
            parent_span.llm_calls.append(call)
            parent_span.tokens_used += total_tokens
        elif self._current_trace.spans:
            self._current_trace.spans[-1].llm_calls.append(call)

    def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        **kwargs: Any,
    ) -> None:
        self._llm_starts.pop(str(run_id), None)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_synesis_tracer: SynesisTracer | None = None


def get_synesis_tracer() -> SynesisTracer | None:
    """Return the module-level tracer singleton (None when Redis is unavailable)."""
    global _synesis_tracer
    if _synesis_tracer is not None:
        return _synesis_tracer
    redis_url = os.environ.get("SYNESIS_REDIS_URL", "")
    if not redis_url:
        logger.info("synesis_tracer_disabled reason=no_redis_url")
        return None
    _synesis_tracer = SynesisTracer()
    logger.info("synesis_tracer_ready")
    return _synesis_tracer


def flush_synesis_tracer() -> None:
    """Flush the current trace to Redis. Safe to call when tracer is None."""
    if _synesis_tracer is not None:
        try:
            _synesis_tracer.flush()
        except Exception:
            logger.debug("synesis_tracer_flush_failed", exc_info=True)
