"""Adaptive, low-overhead diagnostics for Yarn sessions.

Captures compact per-request snapshots when requests are sampled or when
failure/waffling heuristics trigger. Snapshots are emitted to logs and stored
ephemerally in Redis for operator debugging.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from ..config import settings
from ..model.usage_tracker import UsageAggregator
from ..session import redis_store

logger = logging.getLogger("yarn.telemetry.diagnostics")


def _hash_id(value: str) -> str:
    if not value:
        return ""
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def _deterministic_sample(request_id: str, rate: float) -> bool:
    if rate <= 0:
        return False
    if rate >= 1:
        return True
    digest = hashlib.sha256(request_id.encode()).hexdigest()[:8]
    bucket = int(digest, 16) / 0xFFFFFFFF
    return bucket < rate


@dataclass
class SessionDiagnostics:
    request_id: str
    session_key: str
    user_id: str
    conversation_id: str
    sampled: bool
    reasons: set[str] = field(default_factory=set)
    tool_events: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def create(
        cls,
        *,
        request_id: str,
        session_key: str,
        user_id: str,
        conversation_id: str,
    ) -> SessionDiagnostics:
        return cls(
            request_id=request_id,
            session_key=session_key,
            user_id=user_id,
            conversation_id=conversation_id,
            sampled=_deterministic_sample(request_id, settings.diagnostics_base_sample_rate),
        )

    def add_reason(self, reason: str) -> None:
        if reason:
            self.reasons.add(reason)

    def record_tool(self, tool_name: str, success: bool) -> None:
        if len(self.tool_events) >= settings.diagnostics_max_tool_events:
            return
        self.tool_events.append(
            {
                "name": tool_name,
                "status": "success" if success else "error",
            }
        )

    async def finalize(
        self,
        *,
        status: str,
        usage: UsageAggregator,
        tool_loop_count: int,
        escalated: bool,
        context_utilization: float,
        error_message: str = "",
    ) -> None:
        if not settings.diagnostics_enabled:
            return

        if tool_loop_count >= settings.diagnostics_tool_loop_threshold:
            self.reasons.add("tool_loop_threshold")
        if escalated:
            self.reasons.add("escalated")
        if error_message:
            self.reasons.add("error")

        should_capture = (
            self.sampled or bool(self.reasons) or (settings.diagnostics_on_failure and status in {"error", "escalated"})
        )
        if not should_capture:
            return

        payload = {
            "ts": datetime.now(UTC).isoformat(),
            "request_id": self.request_id,
            "status": status,
            "sampled": self.sampled,
            "reasons": sorted(self.reasons),
            "session_key_hash": _hash_id(self.session_key),
            "user_id_hash": _hash_id(self.user_id),
            "conversation_id": self.conversation_id,
            "tool_loop_count": tool_loop_count,
            "escalated": escalated,
            "context_utilization": round(context_utilization, 4),
            "usage": {
                "tokens_in": usage.total_tokens_in,
                "tokens_out": usage.total_tokens_out,
                "tokens_cached": usage.total_tokens_cached,
                "cost_usd": round(usage.total_cost_usd, 6),
            },
            "tool_events": self.tool_events,
            "error_message": (error_message or "")[:500],
        }

        level = logger.warning if status in {"error", "escalated"} else logger.info
        level("yarn_session_diagnostics %s", json.dumps(payload, sort_keys=True))

        key = f"yarn:diag:{self.request_id}"
        try:
            redis = await redis_store.get_redis()
            await redis.set(
                key,
                json.dumps(payload, sort_keys=True),
                ex=settings.diagnostics_snapshot_ttl_seconds,
            )
        except Exception:
            logger.warning("Failed to persist diagnostics snapshot for %s", self.request_id, exc_info=True)


async def get_snapshot(request_id: str) -> dict[str, Any] | None:
    key = f"yarn:diag:{request_id}"
    try:
        redis = await redis_store.get_redis()
        raw = await redis.get(key)
    except Exception:
        logger.warning("Failed to load diagnostics snapshot for %s", request_id, exc_info=True)
        return None
    if not raw:
        return None
    try:
        if isinstance(raw, bytes):
            raw = raw.decode()
        return json.loads(raw)
    except Exception:
        logger.warning("Corrupt diagnostics snapshot for %s", request_id, exc_info=True)
        return None
