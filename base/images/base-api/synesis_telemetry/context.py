"""Request-scoped context propagation via contextvars.

Set once per request at the API boundary; automatically read by formatters
and span wrappers so every log line includes run_id, user_id, etc.
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import Any

_run_id: ContextVar[str] = ContextVar("synesis_run_id", default="")
_user_id: ContextVar[str] = ContextVar("synesis_user_id", default="")
_node_name: ContextVar[str] = ContextVar("synesis_node_name", default="")
_service_name: ContextVar[str] = ContextVar("synesis_service_name", default="")


def set_request_context(
    *,
    run_id: str = "",
    user_id: str = "",
    node_name: str = "",
) -> None:
    """Set request-scoped context (call at API boundary)."""
    if run_id:
        _run_id.set(run_id)
    if user_id:
        _user_id.set(user_id)
    if node_name:
        _node_name.set(node_name)


def set_service_name(name: str) -> None:
    _service_name.set(name)


def set_node(name: str) -> None:
    _node_name.set(name)


def get_context() -> dict[str, Any]:
    """Return current context as a dict for log injection."""
    ctx: dict[str, Any] = {}
    v = _run_id.get("")
    if v:
        ctx["run_id"] = v
    v = _user_id.get("")
    if v:
        ctx["user_id"] = v
    v = _node_name.get("")
    if v:
        ctx["node"] = v
    v = _service_name.get("")
    if v:
        ctx["service"] = v
    return ctx
