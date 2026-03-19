"""Unit tests for the session manager."""

from __future__ import annotations

import time

import pytest

from app.session.models import AuthUser, RateLimits, SessionState
from app.session.manager import check_rate_limit


class TestSessionState:
    def test_default_creation(self):
        s = SessionState(session_key="test", user_id="u1")
        assert s.role == "user"
        assert s.request_count == 0
        assert s.total_tokens_in == 0

    def test_rate_limits_default(self):
        rl = RateLimits()
        assert rl.tokens_per_minute == 500_000
        assert rl.requests_per_minute == 60
        assert rl.requests_used_this_minute == 0


class TestAuthUser:
    def test_pat_user(self):
        u = AuthUser(user_id="pat-abc", role="user", auth_method="pat")
        assert u.auth_method == "pat"

    def test_keycloak_admin(self):
        u = AuthUser(user_id="kc-123", role="admin", auth_method="keycloak")
        assert u.role == "admin"


class TestRateLimiting:
    def test_within_limits(self):
        s = SessionState(
            session_key="test",
            user_id="u1",
            rate_limits=RateLimits(requests_per_minute=10),
        )
        assert check_rate_limit(s) is True

    def test_exceeded_requests(self):
        s = SessionState(
            session_key="test",
            user_id="u1",
            rate_limits=RateLimits(
                requests_per_minute=10,
                requests_used_this_minute=10,
            ),
        )
        assert check_rate_limit(s) is False

    def test_window_reset(self):
        s = SessionState(
            session_key="test",
            user_id="u1",
            rate_limits=RateLimits(
                requests_per_minute=10,
                requests_used_this_minute=10,
                window_start=time.time() - 120,
            ),
        )
        assert check_rate_limit(s) is True
        assert s.rate_limits.requests_used_this_minute == 0
