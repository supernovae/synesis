"""Prometheus metrics for planner API, graph, and critic.

Exposed via GET /metrics. Used by Grafana dashboard for observability.
"""

from __future__ import annotations

_metrics_registered = False
_chat_requests = None
_chat_duration = None
_critic_rejections = None
_graph_iterations = None
_node_confidence = None
_tokens_total = None
_memory_rss_gauge = None
_memory_cgroup_gauge = None
_prompt_cache_hits = None
_prompt_cache_misses = None
_prompt_cache_entries = None
_frame_cache_hits = None
_frame_cache_misses = None
_frame_cache_entries = None
_runs_by_critic_turn_kind = None


def _ensure_metrics():
    global _metrics_registered
    global _chat_requests, _chat_duration, _critic_rejections
    global _graph_iterations, _node_confidence, _tokens_total
    global _memory_rss_gauge, _memory_cgroup_gauge
    global _prompt_cache_hits, _prompt_cache_misses, _prompt_cache_entries
    global _frame_cache_hits, _frame_cache_misses, _frame_cache_entries
    global _runs_by_critic_turn_kind
    if _metrics_registered:
        return
    try:
        from prometheus_client import Counter, Gauge, Histogram

        _chat_requests = Counter(
            "synesis_chat_requests_total",
            "Chat completion requests by outcome",
            ["outcome"],  # success, error
        )
        _chat_duration = Histogram(
            "synesis_chat_duration_seconds",
            "Chat completion request latency",
            buckets=[0.5, 1, 2, 5, 10, 30, 60, 120, 180],
        )
        _critic_rejections = Counter(
            "synesis_critic_rejections_total",
            "Critic rejections (approved=false) requiring worker revision",
        )
        _graph_iterations = Histogram(
            "synesis_graph_iterations",
            "Graph iteration count per request",
            buckets=[1, 2, 3, 4, 5, 10],
        )
        _node_confidence = Gauge(
            "synesis_node_confidence",
            "Last observed node confidence (0-1); use avg_over_time for average",
            ["node"],
        )
        _tokens_total = Counter(
            "synesis_tokens_total",
            "Tokens consumed per request",
            ["model"],
        )
        _memory_rss_gauge = Gauge(
            "synesis_planner_memory_rss_mib",
            "Process RSS in MiB (sampled at request end); use for OOM debugging.",
        )
        _memory_cgroup_gauge = Gauge(
            "synesis_planner_memory_cgroup_mib",
            "Cgroup memory usage in MiB if available (sampled at request end).",
        )
        _prompt_cache_hits = Counter(
            "synesis_prompt_cache_hits_total",
            "Prompt-level response cache hits",
        )
        _prompt_cache_misses = Counter(
            "synesis_prompt_cache_misses_total",
            "Prompt-level response cache misses",
        )
        _prompt_cache_entries = Gauge(
            "synesis_prompt_cache_entries",
            "Current prompt cache entry count",
        )
        _frame_cache_hits = Counter(
            "synesis_frame_cache_hits_total",
            "Frame extraction cache hits",
        )
        _frame_cache_misses = Counter(
            "synesis_frame_cache_misses_total",
            "Frame extraction cache misses",
        )
        _frame_cache_entries = Gauge(
            "synesis_frame_cache_entries",
            "Current frame cache entry count",
        )
        _runs_by_critic_turn_kind = Counter(
            "synesis_runs_by_critic_turn_kind_total",
            "Completed chat runs by critic turn kind (low-cardinality)",
            ["critic_turn_kind"],
        )
    except Exception:  # nosec B110
        pass
    _metrics_registered = True


def record_chat_success(duration_seconds: float):
    _ensure_metrics()
    if _chat_requests:
        _chat_requests.labels(outcome="success").inc()
    if _chat_duration:
        _chat_duration.observe(duration_seconds)


def record_chat_error(duration_seconds: float):
    _ensure_metrics()
    if _chat_requests:
        _chat_requests.labels(outcome="error").inc()
    if _chat_duration:
        _chat_duration.observe(duration_seconds)


def record_critic_rejection():
    _ensure_metrics()
    if _critic_rejections:
        _critic_rejections.inc()


def record_graph_iterations(count: int):
    _ensure_metrics()
    if _graph_iterations:
        _graph_iterations.observe(count)


def record_node_confidence(node: str, confidence: float):
    _ensure_metrics()
    if _node_confidence and 0 <= confidence <= 1:
        _node_confidence.labels(node=node).set(confidence)


def record_tokens(model: str, tokens: int):
    _ensure_metrics()
    if _tokens_total and tokens > 0:
        _tokens_total.labels(model=model or "unknown").inc(tokens)


def record_memory_after_request(rss_mib: float, cgroup_mib: float = 0.0):
    """Update memory gauges after a request (stream or non-stream) for OOM debugging."""
    _ensure_metrics()
    if _memory_rss_gauge is not None:
        _memory_rss_gauge.set(round(rss_mib, 2))
    if _memory_cgroup_gauge is not None and cgroup_mib >= 0:
        _memory_cgroup_gauge.set(round(cgroup_mib, 2))


def record_prompt_cache_hit():
    _ensure_metrics()
    if _prompt_cache_hits:
        _prompt_cache_hits.inc()


def record_prompt_cache_miss():
    _ensure_metrics()
    if _prompt_cache_misses:
        _prompt_cache_misses.inc()


def record_prompt_cache_size(size: int):
    _ensure_metrics()
    if _prompt_cache_entries is not None:
        _prompt_cache_entries.set(size)


def record_frame_cache_hit():
    _ensure_metrics()
    if _frame_cache_hits:
        _frame_cache_hits.inc()


def record_frame_cache_miss():
    _ensure_metrics()
    if _frame_cache_misses:
        _frame_cache_misses.inc()


def record_frame_cache_size(size: int):
    _ensure_metrics()
    if _frame_cache_entries is not None:
        _frame_cache_entries.set(size)


def record_run_critic_turn_kind(kind: str):
    """Aggregate runs by derived critic turn kind (final, interactive_continue, ...)."""
    _ensure_metrics()
    if not _runs_by_critic_turn_kind:
        return
    k = (kind or "final").strip().lower() or "final"
    if k not in ("final", "interactive_continue", "micro_step", "skip"):
        k = "final"
    _runs_by_critic_turn_kind.labels(critic_turn_kind=k).inc()
