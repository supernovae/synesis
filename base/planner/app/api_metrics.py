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


def _ensure_metrics():
    global _metrics_registered
    global _chat_requests, _chat_duration, _critic_rejections
    global _graph_iterations, _node_confidence, _tokens_total
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
    except Exception:
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
