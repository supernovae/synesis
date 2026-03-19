"""SynesisTracer — lightweight LangChain callback that persists trace records to Postgres.

Replaces the heavy Opik stack (ClickHouse, MySQL, ZooKeeper, Java backend)
with a zero-infrastructure alternative using the operator-managed Postgres DB.

Trace lifecycle:
  1. Instantiated once at module level (like OpikTracer was).
  2. Attached as a LangChain callback via get_graph_config().
  3. Captures per-node spans and per-LLM-call detail from callback events.
  4. On flush(), computes estimated_cost_usd and persists the completed
     TraceRecord to Postgres.

Storage: synesis_admin.traces table (see base/admin/app/db/models.py).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult

logger = logging.getLogger("synesis.tracer")

# Snippet length for list/compact views; full content for debug (stored in prompt_full/completion_full).
_MAX_SNIPPET = 500
_MAX_FULL_CHARS = int(os.environ.get("SYNESIS_TRACE_FULL_CONTENT_MAX_CHARS", "50000"))

# Human-readable labels for graph node names in traces.
_NODE_DISPLAY_NAMES: dict[str, str] = {
    "entry_pipeline": "Frame extraction",
    "router": "Router",
    "planner": "Planner",
    "plan_gate": "Plan gate",
    "writer": "Writer",
    "critic": "Critic",
    "final_scrubber": "Final scrubber",
    "respond": "Respond",
}


# ---------------------------------------------------------------------------
# Data model — serialized as JSON into Postgres JSONB
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
    prompt_full: str = ""
    completion_full: str = ""
    timestamp: float = 0.0
    actual_cost: float = 0.0


@dataclass
class SpanRecord:
    node_name: str = ""
    intent: str = ""
    start_time: float = 0.0
    end_time: float = 0.0
    latency_ms: float = 0.0
    tokens_used: int = 0
    confidence: float = 0.0
    outcome: str = ""
    reasoning: str = ""
    llm_calls: list[LLMCallRecord] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class TraceRecord:
    trace_id: str = ""
    user_id: str = ""
    user_email: str = ""
    org_id: str = ""
    org_name: str = ""
    query_snippet: str = ""
    timestamp: float = 0.0
    total_duration_ms: float = 0.0
    total_tokens: int = 0
    estimated_cost_usd: float = 0.0
    actual_cost_usd: float = 0.0
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
    phase_timings: dict[str, float] = field(default_factory=dict)
    short_circuit_reason: str = ""


# ---------------------------------------------------------------------------
# Pricing lookup — compute estimated_cost_usd from token counts
# ---------------------------------------------------------------------------

_pricing_table: dict[str, tuple[float, float]] | None = None


def _load_pricing() -> dict[str, tuple[float, float]]:
    """Build a model->(input_per_million, output_per_million) lookup table.

    Priority: SYNESIS_MODEL_PRICING_PATH JSON > models.yaml notes > hardcoded defaults.
    """
    global _pricing_table
    if _pricing_table is not None:
        return _pricing_table

    pricing_path = os.environ.get("SYNESIS_MODEL_PRICING_PATH", "")
    if pricing_path:
        try:
            with open(pricing_path) as f:
                raw = json.load(f)
            _pricing_table = {k: (v.get("input", 0), v.get("output", 0)) for k, v in raw.items()}
            logger.info("pricing_table_loaded path=%s models=%d", pricing_path, len(_pricing_table))
            return _pricing_table
        except Exception:
            logger.warning("pricing_table_load_failed", exc_info=True)

    table = _parse_pricing_from_models_yaml()
    if table:
        _pricing_table = table
        return _pricing_table

    _pricing_table = {
        "synesis-router": (0.20, 0.50),
        "synesis-general": (0.26, 0.38),
        "synesis-coder": (0.20, 0.20),
        "synesis-critic": (0.29, 0.29),
        "synesis-summarizer": (0.20, 0.50),
    }
    return _pricing_table


def _parse_pricing_from_models_yaml() -> dict[str, tuple[float, float]] | None:
    """Try to parse $/M rates from models.yaml openrouter notes fields."""

    yaml_path = os.environ.get("SYNESIS_MODELS_YAML_PATH", "")
    if not yaml_path:
        return None
    try:
        import yaml

        with open(yaml_path) as f:
            data = yaml.safe_load(f) or {}
    except Exception:
        return None

    table: dict[str, tuple[float, float]] = {}
    for profiles_key in ("openrouter_profiles", "profiles"):
        for _pname, profile in data.get(profiles_key, {}).items():
            for role, assignment in profile.get("assignments", {}).items():
                served = f"synesis-{role}"
                if served in table:
                    continue
                notes = assignment.get("notes", "")
                if "$" in notes and "/M" in notes:
                    rates = _extract_rates(notes)
                    if rates[0] > 0 or rates[1] > 0:
                        table[served] = rates
    return table if table else None


def _extract_rates(notes: str) -> tuple[float, float]:
    """Extract $/M input and output rates from notes like '$0.20/M in, $0.50/M out'."""
    import re

    matches = re.findall(r"\$(\d+\.?\d*)/M", notes)
    if len(matches) >= 2:
        return (float(matches[0]), float(matches[1]))
    elif len(matches) == 1:
        return (float(matches[0]), float(matches[0]))
    return (0.0, 0.0)


def _compute_cost(record: TraceRecord) -> float:
    """Sum cost across all LLM calls in the trace using the pricing table."""
    pricing = _load_pricing()
    total_cost = 0.0
    for span in record.spans:
        for call in span.llm_calls:
            model = call.model or ""
            rates = pricing.get(model, (0, 0))
            if rates == (0, 0):
                for key in pricing:
                    if key in model or model in key:
                        rates = pricing[key]
                        break
            input_cost = (call.prompt_tokens / 1_000_000) * rates[0]
            output_cost = (call.completion_tokens / 1_000_000) * rates[1]
            total_cost += input_cost + output_cost
    return round(total_cost, 8)


# ---------------------------------------------------------------------------
# Postgres persistence helpers
# ---------------------------------------------------------------------------

_pg_conn = None


def _get_pg():
    """Lazy-init synchronous Postgres connection for trace writes."""
    global _pg_conn
    if _pg_conn is not None:
        try:
            _pg_conn.cursor().execute("SELECT 1")
            return _pg_conn
        except Exception:
            _pg_conn = None

    db_url = os.environ.get("SYNESIS_TRACE_DATABASE_URL", "")
    if not db_url:
        return None
    try:
        import psycopg2

        dsn = db_url.replace("postgresql+asyncpg://", "postgresql://")
        _pg_conn = psycopg2.connect(dsn)
        _pg_conn.autocommit = True
        logger.info("synesis_tracer_pg_ready")
        return _pg_conn
    except Exception:
        logger.warning("synesis_tracer_pg_failed", exc_info=True)
        return None


_INSERT_SQL = """
INSERT INTO traces (
    trace_id, user_id, query_snippet, timestamp, total_duration_ms,
    total_tokens, estimated_cost_usd, actual_cost_usd, difficulty, task_type,
    is_code_task, has_error, iteration_count, full_record
) VALUES (
    %(trace_id)s, %(user_id)s, %(query_snippet)s, %(timestamp)s, %(total_duration_ms)s,
    %(total_tokens)s, %(estimated_cost_usd)s, %(actual_cost_usd)s, %(difficulty)s, %(task_type)s,
    %(is_code_task)s, %(has_error)s, %(iteration_count)s, %(full_record)s
) ON CONFLICT (trace_id) DO UPDATE SET
    total_duration_ms = EXCLUDED.total_duration_ms,
    total_tokens = EXCLUDED.total_tokens,
    estimated_cost_usd = EXCLUDED.estimated_cost_usd,
    actual_cost_usd = EXCLUDED.actual_cost_usd,
    has_error = EXCLUDED.has_error,
    full_record = EXCLUDED.full_record
"""

_INSERT_SQL_LEGACY = """
INSERT INTO traces (
    trace_id, user_id, query_snippet, timestamp, total_duration_ms,
    total_tokens, estimated_cost_usd, difficulty, task_type,
    is_code_task, has_error, iteration_count, full_record
) VALUES (
    %(trace_id)s, %(user_id)s, %(query_snippet)s, %(timestamp)s, %(total_duration_ms)s,
    %(total_tokens)s, %(estimated_cost_usd)s, %(difficulty)s, %(task_type)s,
    %(is_code_task)s, %(has_error)s, %(iteration_count)s, %(full_record)s
) ON CONFLICT (trace_id) DO UPDATE SET
    total_duration_ms = EXCLUDED.total_duration_ms,
    total_tokens = EXCLUDED.total_tokens,
    estimated_cost_usd = EXCLUDED.estimated_cost_usd,
    has_error = EXCLUDED.has_error,
    full_record = EXCLUDED.full_record
"""


def _persist_trace(record: TraceRecord) -> None:
    """Write a completed trace record to Postgres.

    Falls back to the legacy INSERT (without actual_cost_usd) if migration
    010 hasn't been applied yet, so traces are never silently dropped.
    """
    conn = _get_pg()
    if conn is None:
        return
    try:
        full = json.dumps(asdict(record), default=str)
        params = {
            "trace_id": record.trace_id,
            "user_id": record.user_id,
            "query_snippet": record.query_snippet,
            "timestamp": record.timestamp,
            "total_duration_ms": record.total_duration_ms,
            "total_tokens": record.total_tokens,
            "estimated_cost_usd": record.estimated_cost_usd,
            "actual_cost_usd": record.actual_cost_usd,
            "difficulty": record.difficulty,
            "task_type": record.task_type,
            "is_code_task": record.is_code_task,
            "has_error": record.has_error,
            "iteration_count": record.iteration_count,
            "full_record": full,
        }
        with conn.cursor() as cur:
            try:
                cur.execute(_INSERT_SQL, params)
            except Exception:
                conn.rollback()
                cur.execute(_INSERT_SQL_LEGACY, params)
                logger.info("synesis_tracer_used_legacy_insert (migration 010 pending)")
    except Exception:
        logger.warning("synesis_tracer_persist_failed", exc_info=True)


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
        # run_id -> (start_time, node, snippet, full, model_name)
        self._llm_starts: dict[str, tuple[float, str, str, str, str]] = {}
        self._trace_start: float = 0.0

    # -- Trace lifecycle ---------------------------------------------------

    def start_trace(
        self,
        *,
        trace_id: str = "",
        user_id: str = "",
        user_email: str = "",
        org_id: str = "",
        org_name: str = "",
        query: str = "",
    ) -> None:
        """Begin a new trace (called from the API layer before graph.ainvoke)."""
        self._current_trace = TraceRecord(
            trace_id=trace_id or str(uuid.uuid4()),
            user_id=user_id,
            user_email=user_email,
            org_id=org_id,
            org_name=org_name,
            query_snippet=query[:_MAX_SNIPPET],
            timestamp=time.time(),
        )
        self._trace_start = time.monotonic()
        self._active_spans.clear()
        self._llm_starts.clear()

    def flush(self) -> None:
        """Persist the current trace and reset state.

        Promotes any in-progress spans (e.g. writer mid-stream when client
        disconnects) to the trace as interrupted spans so partial work is
        never silently dropped.

        The Postgres write runs in a daemon thread so it never blocks the
        event loop — typical INSERT takes <5ms but we avoid even that stall.
        """
        if self._current_trace is None:
            return
        record = self._current_trace

        for run_id, span in list(self._active_spans.items()):
            span.latency_ms = (time.monotonic() - self._trace_start) * 1000 - (
                span.latency_ms if span.latency_ms > 0 else 0
            )
            span.outcome = "interrupted"
            span.reasoning = "stream interrupted before node completed"
            record.spans.append(span)

        record.total_duration_ms = (time.monotonic() - self._trace_start) * 1000
        record.total_tokens = sum(sum(c.total_tokens for c in s.llm_calls) for s in record.spans)
        record.estimated_cost_usd = _compute_cost(record)
        record.actual_cost_usd = sum(
            c.actual_cost for s in record.spans for c in s.llm_calls
        )
        threading.Thread(target=_persist_trace, args=(record,), daemon=True).start()
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

    def record_phase_timing(self, phase: str, duration_ms: float) -> None:
        """Record a named sub-phase duration (e.g. 'router.query_gen_ms')."""
        if self._current_trace is None:
            return
        self._current_trace.phase_timings[phase] = round(duration_ms, 1)

    def mark_short_circuit(self, reason: str) -> None:
        """Mark current trace as short-circuited (e.g. prompt_cache_hit).

        The trace will still be flushed, but its short_circuit_reason field
        explains why no graph spans were produced.
        """
        if self._current_trace is None:
            return
        self._current_trace.short_circuit_reason = reason

    def record_direct_stream_usage(
        self,
        *,
        node: str,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
        prompt_text: str = "",
        completion_text: str = "",
        latency_ms: float = 0.0,
    ) -> None:
        """Record token usage for a direct-stream call (raw OpenAI SDK, not LangChain).

        Creates a synthetic LLMCallRecord and attaches it to the most recent
        span matching *node*, or the last span if none matches.
        """
        if self._current_trace is None:
            return
        total = prompt_tokens + completion_tokens
        call = LLMCallRecord(
            model=model,
            node=node,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total,
            latency_ms=latency_ms,
            prompt_snippet=prompt_text[:_MAX_SNIPPET],
            completion_snippet=completion_text[:_MAX_SNIPPET],
            prompt_full=prompt_text[:_MAX_FULL_CHARS],
            completion_full=completion_text[:_MAX_FULL_CHARS],
            timestamp=time.time(),
        )
        target_span = None
        for span in reversed(self._current_trace.spans):
            if span.node_name == node:
                target_span = span
                break
        if target_span is None and self._current_trace.spans:
            target_span = self._current_trace.spans[-1]
        if target_span is not None:
            target_span.llm_calls.append(call)
            target_span.tokens_used += total

    def annotate_span(self, node_name: str, annotations: dict[str, Any]) -> None:
        """Attach structured metadata to the most recent span matching *node_name*.

        Nodes call this to record non-LLM operational details (cache hits,
        scrubber counts, frame extraction path, etc.) without duplicating
        ad-hoc logic.  Values are merged into ``SpanRecord.metadata``.
        """
        if self._current_trace is None:
            return
        # Walk completed spans in reverse; most callers annotate *their own*
        # span right at the end of the node function.
        for span in reversed(self._current_trace.spans):
            if span.node_name == node_name:
                span.metadata.update(annotations)
                return
        # Span may still be active (on_chain_end not yet called).
        for span in self._active_spans.values():
            if span.node_name == node_name:
                span.metadata.update(annotations)
                return

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
        try:
            node_name = ""
            # LangGraph 1.x passes node identity via metadata.langgraph_node
            metadata = kwargs.get("metadata") or {}
            lg_node = (metadata.get("langgraph_node") or "").strip()
            if lg_node:
                node_name = lg_node
            if not node_name and tags:
                for tag in tags:
                    if tag.startswith("graph:step:"):
                        node_name = tag.split(":", 2)[-1]
                        break
            name = node_name if node_name else (serialized or {}).get("name", "")
            if not name or name in ("RunnableSequence", "RunnableLambda", "RunnableParallel"):
                return
            span = SpanRecord(
                node_name=name,
                start_time=time.time(),
            )
            self._active_spans[str(run_id)] = span
        except Exception:
            logger.debug("on_chain_start_callback_error", exc_info=True)

    def on_chain_end(
        self,
        outputs: dict[str, Any],
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        try:
            rid = str(run_id)
            span = self._active_spans.pop(rid, None)
            if span is None or self._current_trace is None:
                return
            span.end_time = time.time()
            span.latency_ms = (span.end_time - span.start_time) * 1000
            # Intent label: human-readable node + primary model (e.g. "Router (synesis-router)")
            display = _NODE_DISPLAY_NAMES.get(span.node_name, span.node_name.replace("_", " ").title())
            if span.llm_calls:
                primary_model = span.llm_calls[0].model or ""
                if primary_model:
                    span.intent = f"{display} ({primary_model})"
                else:
                    span.intent = display
            else:
                span.intent = display
            self._current_trace.spans.append(span)
        except Exception:
            logger.debug("on_chain_end_callback_error", exc_info=True)

    def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        try:
            rid = str(run_id)
            span = self._active_spans.pop(rid, None)
            if span is None or self._current_trace is None:
                return
            span.end_time = time.time()
            span.latency_ms = (span.end_time - span.start_time) * 1000
            span.outcome = "error"
            span.reasoning = str(error)[:_MAX_FULL_CHARS]
            display = _NODE_DISPLAY_NAMES.get(span.node_name, span.node_name.replace("_", " ").title())
            if span.llm_calls:
                primary = span.llm_calls[0].model or ""
                span.intent = f"{display} ({primary})" if primary else display
            else:
                span.intent = display
            self._current_trace.spans.append(span)
        except Exception:
            logger.debug("on_chain_error_callback_error", exc_info=True)

    @staticmethod
    def _extract_model_name(serialized: dict[str, Any], kwargs: dict[str, Any]) -> str:
        """Best-effort model name extraction from callback args."""
        inv = kwargs.get("invocation_params") or {}
        model = inv.get("model_name") or inv.get("model") or ""
        if not model:
            kw = (serialized or {}).get("kwargs") or {}
            model = kw.get("model_name") or kw.get("model") or ""
        return model

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
        try:
            prompt_text = prompts[0] if prompts else ""
            node = ""
            parent_span = self._active_spans.get(str(parent_run_id)) if parent_run_id else None
            if parent_span:
                node = parent_span.node_name
            model = self._extract_model_name(serialized, kwargs)
            self._llm_starts[str(run_id)] = (
                time.monotonic(),
                node,
                prompt_text[:_MAX_SNIPPET],
                prompt_text[:_MAX_FULL_CHARS],
                model,
            )
        except Exception:
            logger.debug("on_llm_start_callback_error", exc_info=True)

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
        try:
            prompt_snippet = ""
            prompt_full = ""
            if messages and messages[0]:
                last_msg = messages[0][-1]
                content = getattr(last_msg, "content", str(last_msg))
                prompt_full = content if isinstance(content, str) else str(content)
                prompt_snippet = prompt_full[:_MAX_SNIPPET]
                prompt_full = prompt_full[:_MAX_FULL_CHARS]
            node = ""
            parent_span = self._active_spans.get(str(parent_run_id)) if parent_run_id else None
            if parent_span:
                node = parent_span.node_name
            model = self._extract_model_name(serialized, kwargs)
            self._llm_starts[str(run_id)] = (
                time.monotonic(),
                node,
                prompt_snippet,
                prompt_full,
                model,
            )
        except Exception:
            logger.debug("on_chat_model_start_callback_error", exc_info=True)

    def _unpack_llm_start(self, run_id: str) -> tuple[float, str, str, str, str]:
        """Pop and normalize the start-info tuple (handles legacy 3/4 element tuples)."""
        info = self._llm_starts.pop(run_id, None)
        if info is None:
            return time.monotonic(), "", "", "", ""
        if len(info) == 5:
            return info  # type: ignore[return-value]
        if len(info) == 4:
            return (*info, "")  # type: ignore[return-value]
        # 3-element legacy
        return (info[0], info[1], info[2], info[2], "")  # type: ignore[index]

    def _build_llm_call(
        self,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None,
        response_model: str,
        prompt_tokens: int,
        completion_tokens: int,
        total_tokens: int,
        completion_text: str,
        actual_cost: float = 0.0,
    ) -> None:
        """Shared logic for on_llm_end / on_chat_model_end."""
        rid = str(run_id)
        start_time, node, prompt_snippet, prompt_full, stored_model = self._unpack_llm_start(rid)

        model = response_model or stored_model
        completion_full = completion_text[:_MAX_FULL_CHARS]
        completion_snippet = completion_full[:_MAX_SNIPPET]

        call = LLMCallRecord(
            model=model,
            node=node,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            latency_ms=(time.monotonic() - start_time) * 1000,
            prompt_snippet=prompt_snippet,
            completion_snippet=completion_snippet,
            prompt_full=prompt_full,
            completion_full=completion_full,
            timestamp=time.time(),
            actual_cost=actual_cost,
        )

        parent_span = self._active_spans.get(str(parent_run_id)) if parent_run_id else None
        if parent_span:
            parent_span.llm_calls.append(call)
            parent_span.tokens_used += total_tokens
        elif self._current_trace.spans:
            self._current_trace.spans[-1].llm_calls.append(call)
            self._current_trace.spans[-1].tokens_used += total_tokens

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
        try:
            completion_text = ""
            prompt_tokens = 0
            completion_tokens = 0
            total_tokens = 0
            model = ""
            actual_cost = 0.0

            if response.generations and response.generations[0]:
                gen = response.generations[0][0]
                text = gen.text or ""
                if not text and hasattr(gen, "message"):
                    msg_content = getattr(gen.message, "content", "")
                    text = msg_content if isinstance(msg_content, str) else str(msg_content)
                completion_text = text

            if response.llm_output:
                usage = response.llm_output.get("token_usage") or response.llm_output.get("usage") or {}
                prompt_tokens = usage.get("prompt_tokens", 0)
                completion_tokens = usage.get("completion_tokens", 0)
                total_tokens = usage.get("total_tokens", 0) or (prompt_tokens + completion_tokens)
                model = response.llm_output.get("model_name", "") or response.llm_output.get("model", "")
                actual_cost = float(usage.get("cost", 0.0) or 0.0)

            # ChatOpenAI streaming often puts usage on the AIMessage instead of llm_output
            if total_tokens == 0 and response.generations and response.generations[0]:
                gen = response.generations[0][0]
                msg = getattr(gen, "message", None)
                if msg:
                    usage_meta = getattr(msg, "usage_metadata", None) or {}
                    if isinstance(usage_meta, dict) and usage_meta:
                        prompt_tokens = usage_meta.get("input_tokens", 0)
                        completion_tokens = usage_meta.get("output_tokens", 0)
                        total_tokens = prompt_tokens + completion_tokens
                    resp_meta = getattr(msg, "response_metadata", None) or {}
                    if not model:
                        model = resp_meta.get("model_name", "") or resp_meta.get("model", "")
                    if actual_cost == 0.0 and resp_meta:
                        resp_usage = resp_meta.get("usage", {}) or {}
                        actual_cost = float(resp_usage.get("cost", 0.0) or 0.0)

            self._build_llm_call(
                run_id=run_id,
                parent_run_id=parent_run_id,
                response_model=model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                completion_text=completion_text,
                actual_cost=actual_cost,
            )
        except Exception:
            logger.debug("on_llm_end_callback_error", exc_info=True)

    def on_chat_model_end(
        self,
        response: LLMResult,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        **kwargs: Any,
    ) -> None:
        """Mirror of on_llm_end for the chat-model callback path.

        ChatOpenAI may fire on_chat_model_end instead of (or in addition to)
        on_llm_end.  Guard against double-counting by checking whether the
        run was already consumed in on_llm_end (the _llm_starts entry will
        have been popped).
        """
        rid = str(run_id)
        if self._current_trace is None or rid not in self._llm_starts:
            return
        self.on_llm_end(response, run_id=run_id, parent_run_id=parent_run_id, **kwargs)

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
    """Return the module-level tracer singleton (None when Postgres is unavailable)."""
    global _synesis_tracer
    if _synesis_tracer is not None:
        return _synesis_tracer
    db_url = os.environ.get("SYNESIS_TRACE_DATABASE_URL", "")
    if not db_url:
        logger.info("synesis_tracer_disabled reason=no_database_url")
        return None
    _synesis_tracer = SynesisTracer()
    logger.info("synesis_tracer_ready")
    return _synesis_tracer


def flush_synesis_tracer() -> None:
    """Flush the current trace to Postgres. Safe to call when tracer is None."""
    if _synesis_tracer is not None:
        try:
            _synesis_tracer.flush()
        except Exception:
            logger.debug("synesis_tracer_flush_failed", exc_info=True)
