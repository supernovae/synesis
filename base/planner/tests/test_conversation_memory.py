"""Tests for conversation_memory.py -- in-process and Redis-backed stores."""

from __future__ import annotations

import inspect
import time

import pytest

from app.conversation_memory import ConversationMemory, RedisConversationMemory


class TestConversationMemory:
    def test_store_and_retrieve(self):
        mem = ConversationMemory(max_turns_per_user=10, max_users=100, ttl_seconds=3600)
        mem.store_turn("user1", "user", "hello")
        mem.store_turn("user1", "assistant", "hi there")
        history = mem.get_history("user1")
        assert len(history) == 2
        assert "[user]: hello" in history[0]
        assert "[assistant]: hi there" in history[1]

    def test_unknown_user_returns_empty(self):
        mem = ConversationMemory(max_turns_per_user=10, max_users=100, ttl_seconds=3600)
        assert mem.get_history("nobody") == []

    def test_turn_limit_enforced(self):
        mem = ConversationMemory(max_turns_per_user=3, max_users=100, ttl_seconds=3600)
        for i in range(5):
            mem.store_turn("u1", "user", f"msg{i}")
        history = mem.get_history("u1")
        assert len(history) == 3
        assert "msg2" in history[0]
        assert "msg4" in history[2]

    def test_user_lru_eviction(self):
        mem = ConversationMemory(max_turns_per_user=10, max_users=2, ttl_seconds=3600)
        mem.store_turn("u1", "user", "first")
        mem.store_turn("u2", "user", "second")
        mem.store_turn("u3", "user", "third")
        assert mem.get_history("u1") == []
        assert len(mem.get_history("u2")) == 1
        assert len(mem.get_history("u3")) == 1

    def test_ttl_expiration(self):
        mem = ConversationMemory(max_turns_per_user=10, max_users=100, ttl_seconds=0.01)
        mem.store_turn("u1", "user", "hello")
        time.sleep(0.02)
        assert mem.get_history("u1") == []

    def test_turn_count(self):
        mem = ConversationMemory(max_turns_per_user=10, max_users=100, ttl_seconds=3600)
        assert mem.get_turn_count("u1") == 0
        mem.store_turn("u1", "user", "a")
        mem.store_turn("u1", "assistant", "b")
        assert mem.get_turn_count("u1") == 2

    def test_active_users(self):
        mem = ConversationMemory(max_turns_per_user=10, max_users=100, ttl_seconds=3600)
        assert mem.active_users == 0
        mem.store_turn("u1", "user", "a")
        mem.store_turn("u2", "user", "b")
        assert mem.active_users == 2

    def test_get_summary_empty(self):
        mem = ConversationMemory(max_turns_per_user=10, max_users=100, ttl_seconds=3600)
        assert mem.get_summary("nobody") == ""

    def test_get_summary_with_history(self):
        mem = ConversationMemory(max_turns_per_user=10, max_users=100, ttl_seconds=3600)
        mem.store_turn("u1", "user", "write a bash script")
        mem.store_turn("u1", "assistant", "here it is: #!/bin/bash")
        summary = mem.get_summary("u1")
        assert "Conversation History" in summary
        assert "bash script" in summary

    def test_stats(self):
        mem = ConversationMemory(max_turns_per_user=10, max_users=100, ttl_seconds=7200)
        mem.store_turn("u1", "user", "a")
        mem.store_turn("u1", "assistant", "b")
        mem.store_turn("u2", "user", "c")
        stats = mem.stats()
        assert stats["active_users"] == 2
        assert stats["total_turns"] == 3
        assert stats["max_users"] == 100
        assert stats["max_turns_per_user"] == 10

    def test_content_truncation(self):
        mem = ConversationMemory(max_turns_per_user=10, max_users=100, ttl_seconds=3600)
        long_msg = "x" * 10000
        mem.store_turn("u1", "user", long_msg)
        history = mem.get_history("u1")
        assert len(history) == 1
        # store_turn caps at 4096; get_history replays same cap (prefix "[user]: ")
        assert len(history[0]) <= 8 + 4096


# ---------------------------------------------------------------------------
# Redis-backed memory tests (fakeredis)
# ---------------------------------------------------------------------------

try:
    import fakeredis

    _HAS_FAKEREDIS = True
except ImportError:
    _HAS_FAKEREDIS = False

skip_no_fakeredis = pytest.mark.skipif(not _HAS_FAKEREDIS, reason="fakeredis not installed")


def _make_redis_mem(max_turns: int = 10) -> RedisConversationMemory:
    """Build a RedisConversationMemory backed by fakeredis."""
    mem = RedisConversationMemory.__new__(RedisConversationMemory)
    mem._client = fakeredis.FakeRedis(decode_responses=True)
    mem._max_turns = max_turns
    mem._ttl = 3600
    mem._pending_l2 = None
    return mem


@skip_no_fakeredis
class TestRedisConversationMemory:
    def test_store_and_retrieve(self):
        mem = _make_redis_mem()
        mem.store_turn("user1", "user", "hello")
        mem.store_turn("user1", "assistant", "hi there")
        history = mem.get_history("user1")
        assert len(history) == 2
        assert "[user]: hello" in history[0]
        assert "[assistant]: hi there" in history[1]

    def test_unknown_user_returns_empty(self):
        mem = _make_redis_mem()
        assert mem.get_history("nobody") == []

    def test_turn_limit_enforced(self):
        mem = _make_redis_mem(max_turns=3)
        for i in range(5):
            mem.store_turn("u1", "user", f"msg{i}")
        history = mem.get_history("u1")
        assert len(history) == 3
        assert "msg2" in history[0]
        assert "msg4" in history[2]

    def test_turn_count(self):
        mem = _make_redis_mem()
        assert mem.get_turn_count("u1") == 0
        mem.store_turn("u1", "user", "a")
        mem.store_turn("u1", "assistant", "b")
        assert mem.get_turn_count("u1") == 2

    def test_active_users(self):
        mem = _make_redis_mem()
        assert mem.active_users == 0
        mem.store_turn("u1", "user", "a")
        mem.store_turn("u2", "user", "b")
        assert mem.active_users == 2

    def test_get_summary_empty(self):
        mem = _make_redis_mem()
        assert mem.get_summary("nobody") == ""

    def test_get_summary_with_history(self):
        mem = _make_redis_mem()
        mem.store_turn("u1", "user", "write a bash script")
        mem.store_turn("u1", "assistant", "here it is: #!/bin/bash")
        summary = mem.get_summary("u1")
        assert "Conversation History" in summary
        assert "bash script" in summary

    def test_stats(self):
        mem = _make_redis_mem()
        mem.store_turn("u1", "user", "a")
        stats = mem.stats()
        assert stats["active_users"] == 1
        assert stats["backend"] == "redis"

    def test_content_truncation(self):
        mem = _make_redis_mem()
        long_msg = "x" * 10000
        mem.store_turn("u1", "user", long_msg)
        history = mem.get_history("u1")
        assert len(history) == 1
        assert len(history[0]) <= 8 + 4096

    def test_language_tracking(self):
        mem = _make_redis_mem()
        assert mem.get_last_active_language("u1") is None
        mem.set_last_active_language("u1", "python")
        assert mem.get_last_active_language("u1") == "python"

    def test_context_tracking(self):
        mem = _make_redis_mem()
        assert mem.get_last_context("u1") is None
        mem.set_last_context("u1", True, ["python", "kubernetes"])
        ctx = mem.get_last_context("u1")
        assert ctx is not None
        assert ctx[0] is True
        assert "python" in ctx[1]

    def test_context_str_coercion(self):
        mem = _make_redis_mem()
        mem.set_last_context("u1", "text", [])
        ctx = mem.get_last_context("u1")
        assert ctx is not None
        assert ctx[0] is False

    def test_clear_user_history(self):
        mem = _make_redis_mem()
        mem.store_turn("u1", "user", "hello")
        mem.clear_user_history("u1")
        assert mem.get_history("u1") == []
        assert mem.get_turn_count("u1") == 0

    def test_pending_question_without_l2(self):
        mem = _make_redis_mem()
        mem.store_pending_question("u1", {"question": "what?"})
        assert mem.get_and_clear_pending_question("u1") is None

    def test_pending_question_with_l2(self):
        mem = _make_redis_mem()
        from app.conversation_memory import RedisPendingCheckpointStore

        store = RedisPendingCheckpointStore.__new__(RedisPendingCheckpointStore)
        store._client = fakeredis.FakeRedis(decode_responses=True)
        store._prefix = "synesis:pending:"
        mem._pending_l2 = store
        mem.store_pending_question("u1", {"question": "what?", "run_id": "r1"})
        result = mem.get_and_clear_pending_question("u1")
        assert result is not None
        assert result.get("question") == "what?"
        assert result.get("pending_question_id")
        assert mem.get_and_clear_pending_question("u1") is None

    def test_pending_plan_with_l2(self):
        mem = _make_redis_mem()
        from app.conversation_memory import RedisPendingCheckpointStore

        store = RedisPendingCheckpointStore.__new__(RedisPendingCheckpointStore)
        store._client = fakeredis.FakeRedis(decode_responses=True)
        store._prefix = "synesis:pending:"
        mem._pending_l2 = store
        mem.store_pending_plan("u1", {"plan": "step1"})
        result = mem.get_and_clear_pending_plan("u1")
        assert result is not None
        assert result.get("plan") == "step1"
        assert mem.get_and_clear_pending_plan("u1") is None


# ---------------------------------------------------------------------------
# Governance: API parity between in-process and Redis implementations
# ---------------------------------------------------------------------------

class TestAPIGovernance:
    """RedisConversationMemory must implement all public methods of ConversationMemory."""

    def _public_methods(self, cls: type) -> set[str]:
        return {
            name
            for name, _ in inspect.getmembers(cls, predicate=inspect.isfunction)
            if not name.startswith("_")
        }

    def _public_properties(self, cls: type) -> set[str]:
        return {
            name
            for name in dir(cls)
            if not name.startswith("_") and isinstance(getattr(cls, name, None), property)
        }

    def test_methods_parity(self):
        in_proc = self._public_methods(ConversationMemory)
        redis_impl = self._public_methods(RedisConversationMemory)
        missing = in_proc - redis_impl
        assert not missing, (
            f"RedisConversationMemory is missing methods present in ConversationMemory: {missing}"
        )

    def test_properties_parity(self):
        in_proc = self._public_properties(ConversationMemory)
        redis_impl = self._public_properties(RedisConversationMemory)
        missing = in_proc - redis_impl
        assert not missing, (
            f"RedisConversationMemory is missing properties present in ConversationMemory: {missing}"
        )
