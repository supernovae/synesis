"""Conversation memory — in-process or Redis-backed.

Two implementations share the same public API:

- ``ConversationMemory`` — process-local (OrderedDict + deques). Works for
  single-replica dev and tests.
- ``RedisConversationMemory`` — Redis-primary. Guarantees consistency across
  HPA replicas and survives pod restarts.

Which one is instantiated is controlled by ``settings.memory_redis_url``:
non-empty → Redis, empty → in-process.

PendingCheckpointStore: optional L2 for pending_question state snapshots.
When pods scale down, get_and_clear_pending_question can fall back to L2.
"""

from __future__ import annotations

import json as _json
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
        self._last_context: dict[str, tuple[bool, list[str]]] = {}  # user_id -> (is_code_task, active_domain_refs)
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
                logger.debug(
                    "lru_user_evicted", extra={"user_id_prefix": oldest_uid[:8], "turns_evicted": len(oldest_turns)}
                )

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
        # Match store_turn cap (4096) so quiz/options survive L1 replay; 512 was truncating MC stems.
        return [f"[{t.role}]: {t.content[:4096]}" for t in recent]

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

    def get_last_context(self, user_id: str) -> tuple[bool, list[str]] | None:
        """Return (is_code_task, active_domain_refs) for context pivot detection. None if never set."""
        with self._lock:
            return self._last_context.get(user_id)

    def set_last_context(self, user_id: str, is_code_task: bool | str, active_domain_refs: list[str]) -> None:
        """Store is_code_task and active_domain_refs after a turn for next-turn pivot detection.

        is_code_task: True if sandbox required (code path); False for text mode.
        For backward compat, accepts str: 'text' → False, else → True.
        """
        with self._lock:
            if isinstance(is_code_task, str):
                is_code_task = is_code_task not in ("explain_only", "text")
            self._last_context[user_id] = (is_code_task, list(active_domain_refs or []))
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
                logger.debug("l2_pending_checkpoint_write_failed", extra={"error": str(e)[:200]})

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
                logger.debug("l2_pending_checkpoint_read_failed", extra={"error": str(e)[:200]})
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
        logger.debug("evicted_turns_l2_stub", extra={"turns_evicted": len(turns), "user_id_prefix": user_id[:8]})

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


class RedisPendingCheckpointStore:
    """Redis-backed L2 for pending question state.

    Uses GETDEL for atomic claim-and-delete on read.
    """

    def __init__(self, redis_url: str, prefix: str = "synesis:pending:") -> None:
        import redis as _redis

        self._client = _redis.Redis.from_url(redis_url, decode_responses=True)
        self._prefix = prefix

    def _key(self, user_id: str) -> str:
        return f"{self._prefix}{user_id}"

    def write(self, user_id: str, data: dict[str, Any], ttl_seconds: int = 86400) -> None:
        import json

        self._client.set(self._key(user_id), json.dumps(data), ex=ttl_seconds)

    def read_and_delete(self, user_id: str) -> dict[str, Any] | None:
        import json

        raw = self._client.getdel(self._key(user_id))
        if raw is None:
            return None
        return json.loads(raw)


class RedisConversationMemory:
    """Redis-backed conversation memory shared across planner replicas.

    Data model per user — Redis Hash at ``synesis:mem:{user_id}``:
      - ``turns`` — JSON list of ``{role, content, timestamp, summary}`` dicts
      - ``lang``  — last-active language string
      - ``ctx``   — JSON ``{is_code_task, domain_refs}``

    Pending-question state is delegated to ``PendingCheckpointStore`` (same
    as the in-process implementation).

    TTL is refreshed on every write via ``EXPIRE``.
    """

    _PREFIX = "synesis:mem:"

    def __init__(
        self,
        redis_url: str,
        max_turns_per_user: int = 20,
        ttl_seconds: float = 14400.0,
        pending_checkpoint_store: PendingCheckpointStore | None = None,
    ):
        import redis as _redis

        self._client = _redis.Redis.from_url(redis_url, decode_responses=True)
        self._max_turns = max_turns_per_user
        self._ttl = int(ttl_seconds)
        self._pending_l2 = pending_checkpoint_store

    def _key(self, user_id: str) -> str:
        return f"{self._PREFIX}{user_id}"

    def _touch(self, user_id: str, pipe: Any | None = None) -> None:
        target = pipe or self._client
        target.expire(self._key(user_id), self._ttl)

    # ── Turn history ──────────────────────────────────────────────────

    def store_turn(self, user_id: str, role: str, content: str) -> None:
        key = self._key(user_id)
        turn = {"role": role, "content": content[:4096], "timestamp": time.time(), "summary": ""}
        pipe = self._client.pipeline(transaction=True)
        raw = self._client.hget(key, "turns")
        turns: list[dict] = _json.loads(raw) if raw else []
        turns.append(turn)
        turns = turns[-self._max_turns :]
        pipe.hset(key, "turns", _json.dumps(turns))
        pipe.expire(key, self._ttl)
        pipe.execute()

    def get_history(self, user_id: str, max_turns: int | None = None) -> list[str]:
        raw = self._client.hget(self._key(user_id), "turns")
        if not raw:
            return []
        turns: list[dict] = _json.loads(raw)
        limit = max_turns or self._max_turns
        recent = turns[-limit:]
        return [f"[{t['role']}]: {t['content'][:4096]}" for t in recent]

    def get_summary(self, user_id: str) -> str:
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
        raw = self._client.hget(self._key(user_id), "turns")
        if not raw:
            return 0
        return len(_json.loads(raw))

    # ── Language / context pivots ─────────────────────────────────────

    def get_last_active_language(self, user_id: str) -> str | None:
        val = self._client.hget(self._key(user_id), "lang")
        return val if val else None

    def set_last_active_language(self, user_id: str, lang: str) -> None:
        key = self._key(user_id)
        pipe = self._client.pipeline(transaction=True)
        pipe.hset(key, "lang", lang)
        pipe.expire(key, self._ttl)
        pipe.execute()

    def get_last_context(self, user_id: str) -> tuple[bool, list[str]] | None:
        raw = self._client.hget(self._key(user_id), "ctx")
        if not raw:
            return None
        data = _json.loads(raw)
        return (bool(data.get("is_code_task", False)), list(data.get("domain_refs", [])))

    def set_last_context(self, user_id: str, is_code_task: bool | str, active_domain_refs: list[str]) -> None:
        if isinstance(is_code_task, str):
            is_code_task = is_code_task not in ("explain_only", "text")
        key = self._key(user_id)
        pipe = self._client.pipeline(transaction=True)
        pipe.hset(key, "ctx", _json.dumps({"is_code_task": is_code_task, "domain_refs": list(active_domain_refs or [])}))
        pipe.expire(key, self._ttl)
        pipe.execute()

    # ── Clear ─────────────────────────────────────────────────────────

    def clear_user_history(self, user_id: str) -> None:
        self._client.hdel(self._key(user_id), "turns")

    # ── Pending state (delegates to PendingCheckpointStore) ───────────

    def store_pending_plan(self, user_id: str, plan_data: dict[str, Any]) -> None:
        if self._pending_l2:
            self._pending_l2.write(user_id + ":plan", plan_data)

    def get_and_clear_pending_plan(self, user_id: str) -> dict[str, Any] | None:
        if self._pending_l2:
            return self._pending_l2.read_and_delete(user_id + ":plan")
        return None

    def store_pending_needs_input(self, user_id: str, data: dict[str, Any]) -> None:
        if self._pending_l2:
            self._pending_l2.write(user_id + ":needs_input", data)

    def get_and_clear_pending_needs_input(self, user_id: str) -> dict[str, Any] | None:
        if self._pending_l2:
            return self._pending_l2.read_and_delete(user_id + ":needs_input")
        return None

    def store_pending_question(self, user_id: str, data: dict[str, Any]) -> None:
        enriched = dict(data)
        enriched.setdefault("pending_question_id", str(uuid.uuid4()))
        enriched.setdefault("run_id", data.get("run_id", ""))
        enriched.setdefault("turn_id", data.get("turn_id", ""))
        expires_sec = getattr(settings, "pending_question_ttl_seconds", 86400) or 86400
        enriched.setdefault("expires_at", time.time() + expires_sec)
        if self._pending_l2:
            try:
                snapshot = {k: v for k, v in enriched.items() if k != "question"}
                snapshot["_full"] = enriched
                self._pending_l2.write(user_id, snapshot, ttl_seconds=86400)
            except Exception as e:
                logger.debug("l2_pending_checkpoint_write_failed", extra={"error": str(e)[:200]})

    def get_and_clear_pending_question(self, user_id: str) -> dict[str, Any] | None:
        if self._pending_l2:
            try:
                data = self._pending_l2.read_and_delete(user_id)
                if data and isinstance(data.get("_full"), dict):
                    return data["_full"]
                return data
            except Exception as e:
                logger.debug("l2_pending_checkpoint_read_failed", extra={"error": str(e)[:200]})
        return None

    # ── Stats ─────────────────────────────────────────────────────────

    @property
    def active_users(self) -> int:
        cursor = 0
        count = 0
        while True:
            cursor, keys = self._client.scan(cursor, match=f"{self._PREFIX}*", count=200)
            count += len(keys)
            if cursor == 0:
                break
        return count

    def stats(self) -> dict[str, Any]:
        user_count = self.active_users
        return {
            "active_users": user_count,
            "total_turns": -1,  # expensive to compute across all keys; use -1 sentinel
            "max_users": -1,
            "max_turns_per_user": self._max_turns,
            "ttl_seconds": self._ttl,
            "backend": "redis",
        }


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def _build_pending_l2() -> PendingCheckpointStore | None:
    """Build L2 pending checkpoint store from config. Returns None if unconfigured."""
    redis_url = settings.memory_redis_url or settings.l2_archive_redis_url
    if redis_url:
        try:
            store = RedisPendingCheckpointStore(
                redis_url=redis_url,
                prefix="synesis:pending:",
            )
            logger.info("redis_pending_l2_ready", extra={"url": redis_url[:40]})
            return store
        except Exception:
            logger.warning("redis_pending_l2_init_failed", exc_info=True)
    return None


def _build_memory() -> ConversationMemory | RedisConversationMemory:
    """Select memory backend based on config."""
    pending_l2 = _build_pending_l2()
    if settings.memory_redis_url:
        try:
            mem = RedisConversationMemory(
                redis_url=settings.memory_redis_url,
                max_turns_per_user=settings.memory_max_turns_per_user,
                ttl_seconds=settings.memory_ttl_seconds,
                pending_checkpoint_store=pending_l2,
            )
            logger.info(
                "redis_conversation_memory_ready",
                extra={"url": settings.memory_redis_url[:40]},
            )
            return mem
        except Exception:
            logger.warning("redis_memory_init_failed_falling_back", exc_info=True)
    return ConversationMemory(
        max_turns_per_user=settings.memory_max_turns_per_user,
        max_users=settings.memory_max_users,
        ttl_seconds=settings.memory_ttl_seconds,
        pending_checkpoint_store=pending_l2,
    )


memory = _build_memory()
