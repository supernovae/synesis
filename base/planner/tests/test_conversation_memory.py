"""Tests for conversation_memory.py -- the L1 in-memory conversation store."""

from __future__ import annotations

import time

from app.conversation_memory import ConversationMemory


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
        assert len(history[0]) <= 520
