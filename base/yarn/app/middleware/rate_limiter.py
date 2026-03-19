"""Token-bucket rate limiting per session."""

from __future__ import annotations

import time

from fastapi import HTTPException

from ..session.models import SessionState


def enforce_rate_limit(session: SessionState) -> None:
    """Check and enforce rate limits. Raises 429 if exceeded."""
    now = time.time()
    rl = session.rate_limits

    if now - rl.window_start >= 60.0:
        rl.tokens_used_this_minute = 0
        rl.requests_used_this_minute = 0
        rl.window_start = now

    if rl.requests_used_this_minute >= rl.requests_per_minute:
        retry_after = int(60 - (now - rl.window_start)) + 1
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded ({rl.requests_per_minute} req/min)",
            headers={"Retry-After": str(retry_after)},
        )

    if rl.tokens_used_this_minute >= rl.tokens_per_minute:
        retry_after = int(60 - (now - rl.window_start)) + 1
        raise HTTPException(
            status_code=429,
            detail=f"Token limit exceeded ({rl.tokens_per_minute} tok/min)",
            headers={"Retry-After": str(retry_after)},
        )
