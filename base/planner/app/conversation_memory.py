"""Hierarchical conversation memory -- L1 in-memory store.

Per-user conversation history keyed by user_id, with LRU eviction at the
user level and per-user turn limits via bounded deques. Designed with an
explicit L2 eviction hook for future Milvus-backed persistence.

PendingCheckpointStore: optional L2 for pending_question state snapshots.
When pods scale down, get_and_clear_pending_question can fall back to L2.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Any, Protocol

from .config import settings


class PendingCheckpointStore(Protocol):
    """L2 persistence for pending_question state snapshots.

    Pluggable backend (Redis, Postgres, no-op). Enables resume after pod restart.
    CAS claim: When L2 backend supports it, use atomic claim-and-delete (GETDEL
    in Redis or UPDATE ... WHERE claimed=false RETURNING in Postgres).
    """

    def write(self, user_id: str, data: dict[str, Any], ttl_seconds: int = 86400) -> None:
        """Persist state snapshot. Overwrites existing for user_id."""
        ...

    def read_and_delete(self, user_id: str) -> dict[str, Any] | None:
        """Retrieve and remove. Returns None if not found.
        L2: Prefer atomic claim-and-delete to avoid double-submit races."""
        ...


logger = logging.getLogger("synesis.memory")


@dataclass
class ConversationTurn:
    """A single turn in a conversation."""

    role: str
    content: str
    timestamp: float = field(default_factory=time.time)
    summary: str = ""


class ConversationMemory:
    """Thread-safe in-memory conversation store with per-user turn limits.

    Each user gets a bounded deque of ConversationTurn objects. When turns
    exceed max_turns_per_user, oldest turns are evicted (and passed to
    _on_evict for future L2 persistence). Users are tracked in LRU order;
    when max_users is exceeded, the least recently active user is evicted.
    """

    def __init__(
        self,
        max_turns_per_user: int = 20,
        max_users: int = 5000,
        ttl_seconds: float = 14400.0,
        pending_checkpoint_store: PendingCheckpointStore | None = None,
    ):
        self._max_turns = max_turns_per_user
        self._max_users = max_users
        self._ttl = ttl_seconds
        self._pending_l2 = pending_checkpoint_store
        self._users: OrderedDict[str, deque[ConversationTurn]] = OrderedDict()
        self._last_active: dict[str, float] = {}
        self._last_active_language: dict[str, str] = {}  # per-user language for context-stability pivot
        self._pending_plans: dict[str, dict[str, Any]] = {}
        self._pending_needs_input: dict[str, dict[str, Any]] = {}
        self._pending_questions: dict[str, dict[str, Any]] = {}  # unified: plan, needs_input, clarification
        self._lock = threading.Lock()

    def store_turn(self, user_id: str, role: str, content: str) -> None:
        """Append a turn to the user's conversation history."""
        turn = ConversationTurn(
            role=role,
            content=content[:4096],
        )

        with self._lock:
            self._evict_expired_users()

            if user_id not in self._users:
                self._users[user_id] = deque(maxlen=self._max_turns)

            user_deque = self._users[user_id]

            if len(user_deque) == user_deque.maxlen:
                evicted = user_deque[0]
                self._on_evict(user_id, [evicted])

            user_deque.append(turn)
            self._last_active[user_id] = time.time()
            self._users.move_to_end(user_id)

            while len(self._users) > self._max_users:
                oldest_uid, oldest_turns = self._users.popitem(last=False)
                self._on_evict(oldest_uid, list(oldest_turns))
                self._last_active.pop(oldest_uid, None)
                logger.debug(f"Evicted LRU user {oldest_uid[:8]}... ({len(oldest_turns)} turns)")

    def get_history(self, user_id: str, max_turns: int | None = None) -> list[str]:
        """Return the user's recent conversation history as formatted strings."""
        with self._lock:
            if user_id not in self._users:
                return []

            if self._is_expired(user_id):
                self._remove_user(user_id)
                return []

            self._users.move_to_end(user_id)
            self._last_active[user_id] = time.time()

            turns = list(self._users[user_id])

        limit = max_turns or self._max_turns
        recent = turns[-limit:]
        return [f"[{t.role}]: {t.content[:512]}" for t in recent]

    def get_summary(self, user_id: str) -> str:
        """Return a compact summary of recent history for prompt injection."""
        history = self.get_history(user_id, max_turns=10)
        if not history:
            return ""

        lines = "\n".join(f"- {h}" for h in history)
        return (
            "## Conversation History\n"
            "The user has had previous interactions. Recent context:\n"
            f"{lines}\n\n"
            'Use this context to understand references like "it", "that script", '
            '"the previous one", etc.'
        )

    def get_turn_count(self, user_id: str) -> int:
        with self._lock:
            if user_id not in self._users:
                return 0
            return len(self._users[user_id])

    def get_last_active_language(self, user_id: str) -> str | None:
        """Return the last target language for this user (for context-stability pivot detection)."""
        with self._lock:
            return self._last_active_language.get(user_id)

    def set_last_active_language(self, user_id: str, lang: str) -> None:
        """Update the last target language after a turn."""
        with self._lock:
            self._last_active_language[user_id] = lang
            self._last_active[user_id] = time.time()

    def clear_user_history(self, user_id: str) -> None:
        """Flush conversation history for this user (e.g. on context pivot)."""
        with self._lock:
            if user_id in self._users:
                turns = list(self._users[user_id])
                self._users[user_id].clear()
                if turns:
                    self._on_evict(user_id, turns)

    def store_pending_plan(self, user_id: str, plan_data: dict[str, Any]) -> None:
        """Store a plan awaiting user approval. Overwrites any existing pending plan."""
        with self._lock:
            self._pending_plans[user_id] = plan_data
            self._last_active[user_id] = time.time()

    def get_and_clear_pending_plan(self, user_id: str) -> dict[str, Any] | None:
        """Retrieve and remove pending plan for user. Returns None if none."""
        with self._lock:
            return self._pending_plans.pop(user_id, None)

    def store_pending_needs_input(self, user_id: str, data: dict[str, Any]) -> None:
        """Store context when Executor asked user a question. Overwrites any existing."""
        with self._lock:
            self._pending_needs_input[user_id] = data
            self._last_active[user_id] = time.time()

    def get_and_clear_pending_needs_input(self, user_id: str) -> dict[str, Any] | None:
        """Retrieve and remove pending needs_input context. Returns None if none."""
        with self._lock:
            return self._pending_needs_input.pop(user_id, None)

    def store_pending_question(self, user_id: str, data: dict[str, Any]) -> None:
        """Unified: any question (plan, needs_input, clarification). Overwrites existing.
        L2 write-through when pending_checkpoint_store is set.

        Concurrency safety (multi-tab/double-submit): When storing, inject
        pending_question_id, run_id, turn_id, expires_at. Client should echo
        pending_question_id when replying; backend validates match before resume.
        """
        enriched = dict(data)
        enriched.setdefault("pending_question_id", str(uuid.uuid4()))
        enriched.setdefault("run_id", data.get("run_id", ""))
        enriched.setdefault("turn_id", data.get("turn_id", ""))
        expires_sec = getattr(settings, "pending_question_ttl_seconds", 86400) or 86400
        enriched.setdefault("expires_at", time.time() + expires_sec)
        with self._lock:
            self._pending_questions[user_id] = enriched
            self._last_active[user_id] = time.time()
        if self._pending_l2:
            try:
                snapshot = {k: v for k, v in enriched.items() if k != "question"}
                snapshot["_full"] = enriched
                self._pending_l2.write(user_id, snapshot, ttl_seconds=86400)
            except Exception as e:
                logger.debug(f"L2 pending checkpoint write failed: {e}")

    def get_and_clear_pending_question(self, user_id: str) -> dict[str, Any] | None:
        """Retrieve and remove pending question. L1 first; fallback to L2 on miss (pod restart)."""
        with self._lock:
            data = self._pending_questions.pop(user_id, None)
        if data is not None:
            return data
        if self._pending_l2:
            try:
                data = self._pending_l2.read_and_delete(user_id)
                if data and isinstance(data.get("_full"), dict):
                    return data["_full"]
                return data
            except Exception as e:
                logger.debug(f"L2 pending checkpoint read failed: {e}")
        return None

    def _is_expired(self, user_id: str) -> bool:
        last = self._last_active.get(user_id, 0)
        return time.time() - last > self._ttl

    def _evict_expired_users(self) -> None:
        now = time.time()
        expired = [uid for uid, last in self._last_active.items() if now - last > self._ttl]
        for uid in expired:
            self._remove_user(uid)

    def _remove_user(self, user_id: str) -> None:
        turns = self._users.pop(user_id, None)
        self._last_active.pop(user_id, None)
        self._last_active_language.pop(user_id, None)
        self._pending_plans.pop(user_id, None)
        self._pending_needs_input.pop(user_id, None)
        self._pending_questions.pop(user_id, None)
        if turns:
            self._on_evict(user_id, list(turns))

    def _on_evict(self, user_id: str, turns: list[ConversationTurn]) -> None:
        """Hook for future L2 persistence.

        When turns are evicted from L1 (either by TTL, LRU, or deque overflow),
        this method is called with the evicted turns. Currently a no-op.

        Future L2 implementation would:
        1. Summarize the evicted turns via the supervisor LLM
        2. Embed the summary
        3. Upsert to a conversation_memory_v1 Milvus collection
        """
        logger.debug(f"Evicted {len(turns)} turns for user {user_id[:8]}... (L2 stub)")

    @property
    def active_users(self) -> int:
        with self._lock:
            return len(self._users)

    def stats(self) -> dict[str, Any]:
        with self._lock:
            total_turns = sum(len(d) for d in self._users.values())
            return {
                "active_users": len(self._users),
                "total_turns": total_turns,
                "max_users": self._max_users,
                "max_turns_per_user": self._max_turns,
                "ttl_seconds": self._ttl,
            }


memory = ConversationMemory(
    max_turns_per_user=settings.memory_max_turns_per_user,
    max_users=settings.memory_max_users,
    ttl_seconds=settings.memory_ttl_seconds,
)
