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

import contextvars
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

from .llm_usage_extract import normalize_from_llm_result
from .trace_redaction import redact_trace_payload

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
    cached_prompt_tokens: int = 0
    latency_ms: float = 0.0
    prompt_snippet: str = ""
    completion_snippet: str = ""
    prompt_full: str = ""
    completion_full: str = ""
    timestamp: float = 0.0
    actual_cost: float = 0.0
    estimated_cost: float | None = None
    policy_source: str = ""  # "policy", "env", "static", or "" if not tracked
    policy_rule_label: str = ""  # human label from matched policy rule
    error_message: str = ""


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
    total_cached_prompt_tokens: int = 0
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
    context_curation: dict[str, Any] = field(default_factory=dict)
    taxonomy: dict[str, Any] = field(default_factory=dict)
    model_policy_resolutions: dict[str, Any] = field(default_factory=dict)
    phase_timings: dict[str, float] = field(default_factory=dict)
    short_circuit_reason: str = ""
    conversation_id: str = ""
    parent_trace_id: str = ""
    root_trace_id: str = ""
    trace_context: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Pricing lookup — compute estimated_cost_usd from token counts
# ---------------------------------------------------------------------------

# Per-model: (input_per_million, input_cached_per_million_or_None, output_per_million).
# When input_cached is None, SYNESIS_CACHED_INPUT_PRICE_MULTIPLIER * input is used.
_pricing_table: dict[str, tuple[float, float | None, float]] | None = None


def _cached_input_rate(input_rate: float, explicit_cached: float | None) -> float:
    if explicit_cached is not None and explicit_cached >= 0:
        return explicit_cached
    mult = float(os.environ.get("SYNESIS_CACHED_INPUT_PRICE_MULTIPLIER", "0.1"))
    return input_rate * mult


def _load_pricing() -> dict[str, tuple[float, float | None, float]]:
    """Build a model->(input, optional input_cached, output) lookup table.

    Priority: SYNESIS_MODEL_PRICING_PATH JSON > hardcoded defaults for synesis-* served names.
    JSON values may include optional ``input_cached`` (USD per million cached prompt tokens).
    """
    global _pricing_table
    if _pricing_table is not None:
        return _pricing_table

    pricing_path = os.environ.get("SYNESIS_MODEL_PRICING_PATH", "")
    if pricing_path:
        try:
            with open(pricing_path) as f:
                raw = json.load(f)
            out: dict[str, tuple[float, float | None, float]] = {}
            for k, v in raw.items():
                if not isinstance(v, dict):
                    continue
                inp = float(v.get("input", 0) or 0)
                outp = float(v.get("output", 0) or 0)
                ic = v.get("input_cached")
                ic_f = float(ic) if ic is not None else None
                out[k] = (inp, ic_f, outp)
            _pricing_table = out
            logger.info("pricing_table_loaded path=%s models=%d", pricing_path, len(_pricing_table))
            return _pricing_table
        except Exception:
            logger.warning("pricing_table_load_failed", exc_info=True)

    _pricing_table = {
        "synesis-router": (0.20, None, 0.50),
        "synesis-general": (0.26, None, 0.38),
        "synesis-coder": (0.20, None, 0.20),
        "synesis-critic": (0.29, None, 0.29),
        "synesis-summarizer": (0.20, None, 0.50),
    }
    return _pricing_table


def _resolve_pricing_rates(
    model: str,
    pricing: dict[str, tuple[float, float | None, float]],
) -> tuple[float, float | None, float]:
    rates = pricing.get(model, (0.0, None, 0.0))
    if rates == (0.0, None, 0.0):
        for key in pricing:
            if key in model or model in key:
                return pricing[key]
    return rates


def _estimate_call_cost(
    *,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    cached_prompt_tokens: int,
    pricing: dict[str, tuple[float, float | None, float]] | None = None,
) -> float:
    table = pricing or _load_pricing()
    inp_r, inp_cached_r, out_r = _resolve_pricing_rates(model or "", table)
    pt = max(0, int(prompt_tokens or 0))
    cached = min(max(0, int(cached_prompt_tokens or 0)), pt)
    uncached = pt - cached
    ic_rate = _cached_input_rate(inp_r, inp_cached_r)
    input_cost = (uncached / 1_000_000) * inp_r + (cached / 1_000_000) * ic_rate
    output_cost = (max(0, int(completion_tokens or 0)) / 1_000_000) * out_r
    return round(input_cost + output_cost, 8)


def _compute_cost(record: TraceRecord) -> float:
    """Sum cost across all LLM calls in the trace using per-call estimates."""
    pricing = _load_pricing()
    total_cost = 0.0
    for span in record.spans:
        for call in span.llm_calls:
            if call.estimated_cost is not None:
                total_cost += float(call.estimated_cost)
                continue
            total_cost += _estimate_call_cost(
                model=call.model or "",
                prompt_tokens=call.prompt_tokens,
                completion_tokens=call.completion_tokens,
                cached_prompt_tokens=call.cached_prompt_tokens,
                pricing=pricing,
            )
    return round(total_cost, 8)


# ---------------------------------------------------------------------------
# Postgres persistence — uses shared planner connection pool
# ---------------------------------------------------------------------------


_INSERT_SQL = """
INSERT INTO traces (
    trace_id, user_id, query_snippet, timestamp, total_duration_ms,
    total_tokens, estimated_cost_usd, actual_cost_usd, difficulty, task_type,
    is_code_task, has_error, iteration_count, full_record,
    conversation_id, parent_trace_id, root_trace_id
) VALUES (
    %(trace_id)s, %(user_id)s, %(query_snippet)s, %(timestamp)s, %(total_duration_ms)s,
    %(total_tokens)s, %(estimated_cost_usd)s, %(actual_cost_usd)s, %(difficulty)s, %(task_type)s,
    %(is_code_task)s, %(has_error)s, %(iteration_count)s, %(full_record)s,
    %(conversation_id)s, %(parent_trace_id)s, %(root_trace_id)s
) ON CONFLICT (trace_id) DO UPDATE SET
    total_duration_ms = EXCLUDED.total_duration_ms,
    total_tokens = EXCLUDED.total_tokens,
    estimated_cost_usd = EXCLUDED.estimated_cost_usd,
    actual_cost_usd = EXCLUDED.actual_cost_usd,
    has_error = EXCLUDED.has_error,
    full_record = EXCLUDED.full_record,
    conversation_id = EXCLUDED.conversation_id,
    parent_trace_id = EXCLUDED.parent_trace_id,
    root_trace_id = EXCLUDED.root_trace_id
"""

_INSERT_SQL_PRE_SESSION = """
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

    Uses the shared planner connection pool so concurrent flushes from
    multiple requests never contend on a single socket.
    """
    from .pg_pool import pg_connection

    with pg_connection() as conn:
        if conn is None:
            return
        _persist_trace_inner(conn, record)


def _persist_trace_inner(conn, record: TraceRecord) -> None:
    try:
        payload = asdict(record)
        payload = redact_trace_payload(payload)
        full = json.dumps(payload, default=str)
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
            "conversation_id": record.conversation_id or None,
            "parent_trace_id": record.parent_trace_id or None,
            "root_trace_id": record.root_trace_id or None,
        }
        with conn.cursor() as cur:
            try:
                cur.execute(_INSERT_SQL, params)
            except Exception:
                conn.rollback()
                try:
                    cur.execute(_INSERT_SQL_PRE_SESSION, params)
                    logger.info("synesis_tracer_used_pre_session_insert (migration 015 pending)")
                except Exception:
                    conn.rollback()
                    legacy_params = {
                        "trace_id": params["trace_id"],
                        "user_id": params["user_id"],
                        "query_snippet": params["query_snippet"],
                        "timestamp": params["timestamp"],
                        "total_duration_ms": params["total_duration_ms"],
                        "total_tokens": params["total_tokens"],
                        "estimated_cost_usd": params["estimated_cost_usd"],
                        "difficulty": params["difficulty"],
                        "task_type": params["task_type"],
                        "is_code_task": params["is_code_task"],
                        "has_error": params["has_error"],
                        "iteration_count": params["iteration_count"],
                        "full_record": params["full_record"],
                    }
                    try:
                        cur.execute(_INSERT_SQL_LEGACY, legacy_params)
                        logger.info("synesis_tracer_used_legacy_insert (migration 010 pending)")
                    except Exception:
                        logger.warning("synesis_tracer_all_insert_paths_failed", exc_info=True)
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

    def set_session_links(
        self,
        *,
        conversation_id: str = "",
        parent_trace_id: str = "",
        root_trace_id: str = "",
    ) -> None:
        """Attach session/causal metadata before flush (call after pending merge in main)."""
        if self._current_trace is None:
            return
        self._current_trace.conversation_id = (conversation_id or "").strip()[:128]
        self._current_trace.parent_trace_id = (parent_trace_id or "").strip()[:64]
        self._current_trace.root_trace_id = (root_trace_id or "").strip()[:64]

    def set_trace_context(self, ctx: dict[str, Any]) -> None:
        """Merge pipeline context (critic turn kind, pivot, etc.) into the trace record."""
        if self._current_trace is None or not ctx:
            return
        self._current_trace.trace_context.update(ctx)

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
        record.total_cached_prompt_tokens = sum(sum(c.cached_prompt_tokens for c in s.llm_calls) for s in record.spans)
        record.estimated_cost_usd = _compute_cost(record)
        record.actual_cost_usd = sum(c.actual_cost for s in record.spans for c in s.llm_calls)
        threading.Thread(target=_persist_trace, args=(record,), daemon=True).start()
        self._current_trace = None
        self._active_spans.clear()
        self._llm_starts.clear()

    def pending_usage(self) -> dict[str, int]:
        """Return token totals from the in-flight trace (before flush).

        Uses the same aggregation logic as ``flush`` so callers get numbers
        identical to what ends up in the Postgres trace record.  Returns
        zeros when no trace is active.
        """
        rec = self._current_trace
        if rec is None:
            return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "cached_prompt_tokens": 0}
        all_calls = [c for s in rec.spans for c in s.llm_calls]
        active_calls = [c for s in self._active_spans.values() for c in s.llm_calls]
        calls = all_calls + active_calls
        prompt = sum(c.prompt_tokens for c in calls)
        completion = sum(c.completion_tokens for c in calls)
        total = sum(c.total_tokens for c in calls)
        cached = sum(c.cached_prompt_tokens for c in calls)
        return {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": total,
            "cached_prompt_tokens": cached,
        }

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
        sem = taxonomy.get("taxonomy_semantic")
        if isinstance(sem, dict):
            self._current_trace.taxonomy["semantic_overridden"] = sem.get("overridden", False)
            self._current_trace.taxonomy["semantic_ambiguous"] = sem.get("ambiguous", False)
            self._current_trace.taxonomy["semantic_keyword_key"] = sem.get("keyword_key", "")
            self._current_trace.taxonomy["semantic_top"] = sem.get("semantic_top", [])[:3]

    def record_model_policy(self, node: str, role: str, model_name: str, source: str, rule_label: str = "") -> None:
        """Record which model was selected by policy for a node."""
        if self._current_trace is None:
            return
        self._current_trace.model_policy_resolutions[node] = {
            "role": role,
            "model": model_name,
            "source": source,
            "rule_label": rule_label,
        }

    def set_context_curation(self, report: dict[str, Any]) -> None:
        """Writer evidence budgeting — rank-first pack, exclusions, starvation signals."""
        if self._current_trace is None:
            return
        excl = report.get("excluded") or []
        if isinstance(excl, list):
            excl = excl[:20]
        self._current_trace.context_curation = {
            "packets_in": report.get("packets_in"),
            "packets_kept": report.get("packets_kept"),
            "excluded_count": report.get("excluded_count"),
            "token_budget": report.get("token_budget"),
            "tokens_used": report.get("tokens_used"),
            "char_budget": report.get("char_budget"),
            "chars_used": report.get("chars_used"),
            "utilization": report.get("utilization"),
            "low_utilization": report.get("low_utilization"),
            "budget_alert": report.get("budget_alert") or "",
            "packets_truncated": report.get("packets_truncated"),
            "excluded": excl,
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
        cached_prompt_tokens: int = 0,
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
        pt = max(0, int(prompt_tokens))
        cached = min(max(0, int(cached_prompt_tokens)), pt) if pt else max(0, int(cached_prompt_tokens))
        call = LLMCallRecord(
            model=model,
            node=node,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total,
            cached_prompt_tokens=cached,
            latency_ms=latency_ms,
            prompt_snippet=prompt_text[:_MAX_SNIPPET],
            completion_snippet=completion_text[:_MAX_SNIPPET],
            prompt_full=prompt_text[:_MAX_FULL_CHARS],
            completion_full=completion_text[:_MAX_FULL_CHARS],
            timestamp=time.time(),
            estimated_cost=_estimate_call_cost(
                model=model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                cached_prompt_tokens=cached,
            ),
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

    def record_direct_stream_failure(
        self,
        *,
        node: str,
        model: str,
        prompt_text: str = "",
        error_message: str = "",
    ) -> None:
        """Record a direct-stream model failure that produced no usage payload."""
        if self._current_trace is None:
            return
        call = LLMCallRecord(
            model=model,
            node=node,
            prompt_tokens=0,
            completion_tokens=0,
            total_tokens=0,
            cached_prompt_tokens=0,
            latency_ms=0.0,
            prompt_snippet=prompt_text[:_MAX_SNIPPET],
            completion_snippet="",
            prompt_full=prompt_text[:_MAX_FULL_CHARS],
            completion_full="",
            timestamp=time.time(),
            actual_cost=0.0,
            estimated_cost=0.0,
            error_message=(error_message or "")[:_MAX_SNIPPET],
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
            target_span.metadata["llm_error"] = (error_message or "")[:_MAX_SNIPPET]

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
        _inputs: dict[str, Any],
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
        _outputs: dict[str, Any],
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
        cached_prompt_tokens: int,
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
            cached_prompt_tokens=cached_prompt_tokens,
            latency_ms=(time.monotonic() - start_time) * 1000,
            prompt_snippet=prompt_snippet,
            completion_snippet=completion_snippet,
            prompt_full=prompt_full,
            completion_full=completion_full,
            timestamp=time.time(),
            actual_cost=actual_cost,
            estimated_cost=_estimate_call_cost(
                model=model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                cached_prompt_tokens=cached_prompt_tokens,
            ),
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
            model = ""
            actual_cost = 0.0
            msg = None

            if response.generations and response.generations[0]:
                gen = response.generations[0][0]
                text = gen.text or ""
                if not text and hasattr(gen, "message"):
                    msg_content = getattr(gen.message, "content", "")
                    text = msg_content if isinstance(msg_content, str) else str(msg_content)
                completion_text = text
                msg = getattr(gen, "message", None)

            norm = normalize_from_llm_result(
                response.llm_output if isinstance(response.llm_output, dict) else None,
                msg,
            )
            prompt_tokens = norm.prompt_tokens
            completion_tokens = norm.completion_tokens
            total_tokens = norm.total_tokens or (prompt_tokens + completion_tokens)
            cached_prompt_tokens = norm.cached_prompt_tokens

            # ChatOpenAI streaming may invoke on_llm_end first with empty usage, then
            # on_chat_model_end with usage_metadata. Popping _llm_starts in the first
            # call prevents the second from recording (see on_chat_model_end guard).
            if total_tokens <= 0 and prompt_tokens <= 0 and completion_tokens <= 0:
                return

            if response.llm_output and isinstance(response.llm_output, dict):
                model = response.llm_output.get("model_name", "") or response.llm_output.get("model", "")
                usage = response.llm_output.get("token_usage") or response.llm_output.get("usage") or {}
                if isinstance(usage, dict):
                    actual_cost = float(usage.get("cost", 0.0) or 0.0)

            if msg is not None:
                resp_meta = getattr(msg, "response_metadata", None) or {}
                if not model and isinstance(resp_meta, dict):
                    model = resp_meta.get("model_name", "") or resp_meta.get("model", "")
                if actual_cost == 0.0 and isinstance(resp_meta, dict):
                    resp_usage = resp_meta.get("usage", {}) or {}
                    if isinstance(resp_usage, dict):
                        actual_cost = float(resp_usage.get("cost", 0.0) or 0.0)

            self._build_llm_call(
                run_id=run_id,
                parent_run_id=parent_run_id,
                response_model=model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                cached_prompt_tokens=cached_prompt_tokens,
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
        if self._current_trace is None:
            self._llm_starts.pop(str(run_id), None)
            return
        rid = str(run_id)
        start_time, node, prompt_snippet, prompt_full, stored_model = self._unpack_llm_start(rid)
        call = LLMCallRecord(
            model=stored_model or "",
            node=node,
            prompt_tokens=0,
            completion_tokens=0,
            total_tokens=0,
            cached_prompt_tokens=0,
            latency_ms=max(0.0, (time.monotonic() - start_time) * 1000),
            prompt_snippet=prompt_snippet,
            completion_snippet="",
            prompt_full=prompt_full,
            completion_full="",
            timestamp=time.time(),
            actual_cost=0.0,
            estimated_cost=0.0,
            error_message=str(error)[:_MAX_SNIPPET],
        )
        parent_span = self._active_spans.get(str(parent_run_id)) if parent_run_id else None
        if parent_span:
            parent_span.llm_calls.append(call)
            parent_span.metadata["llm_error"] = str(error)[:_MAX_SNIPPET]
        elif self._current_trace.spans:
            self._current_trace.spans[-1].llm_calls.append(call)
            self._current_trace.spans[-1].metadata["llm_error"] = str(error)[:_MAX_SNIPPET]


# ---------------------------------------------------------------------------
# Per-request tracer via ContextVar (replaces the old module-level singleton
# that caused cross-contamination between concurrent requests)
# ---------------------------------------------------------------------------

_request_tracer: contextvars.ContextVar[SynesisTracer | None] = contextvars.ContextVar(
    "_request_tracer", default=None,
)

_tracing_enabled: bool | None = None


def _is_tracing_enabled() -> bool:
    """Check once whether the trace database URL is configured."""
    global _tracing_enabled
    if _tracing_enabled is not None:
        return _tracing_enabled
    _tracing_enabled = bool(os.environ.get("SYNESIS_TRACE_DATABASE_URL", ""))
    if not _tracing_enabled:
        logger.info("synesis_tracer_disabled reason=no_database_url")
    return _tracing_enabled


def create_request_tracer() -> SynesisTracer | None:
    """Create a fresh per-request tracer and store it in the ContextVar.

    Call this at the start of each request handler. The returned instance
    is scoped to the current asyncio task so concurrent requests never
    share mutable trace state.
    """
    if not _is_tracing_enabled():
        return None
    tracer = SynesisTracer()
    _request_tracer.set(tracer)
    return tracer


def get_synesis_tracer() -> SynesisTracer | None:
    """Return the per-request tracer (or None outside a traced request)."""
    return _request_tracer.get(None)


def snapshot_pending_usage() -> dict[str, int]:
    """Return token breakdown from the active (pre-flush) trace, or zeros."""
    tracer = _request_tracer.get(None)
    if tracer is not None:
        try:
            return tracer.pending_usage()
        except Exception:
            logger.debug("synesis_tracer_pending_usage_failed", exc_info=True)
    return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "cached_prompt_tokens": 0}


def flush_synesis_tracer() -> None:
    """Flush the current request's trace to Postgres. Safe to call when tracer is None."""
    tracer = _request_tracer.get(None)
    if tracer is not None:
        try:
            tracer.flush()
        except Exception:
            logger.debug("synesis_tracer_flush_failed", exc_info=True)
