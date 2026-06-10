"""In-memory sliding-window rate limiter for the Admin FastAPI service.

Per-IP limiting with configurable rates per route prefix. Suitable for
single-replica deployments; for multi-replica, rely on Cloudflare/ingress
edge rate rules as the primary layer.
"""

from __future__ import annotations

import os
import time
from collections import defaultdict
from dataclasses import dataclass, field

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from .request_ip import get_client_ip

_DEFAULT_GLOBAL_MAX = int(os.getenv("SYNESIS_ADMIN_RATE_LIMIT_MAX", "120"))
_DEFAULT_GLOBAL_WINDOW = int(os.getenv("SYNESIS_ADMIN_RATE_LIMIT_WINDOW_SECONDS", "60"))

_AUTH_MAX = int(os.getenv("SYNESIS_ADMIN_AUTH_RATE_LIMIT_MAX", "20"))
_AUTH_WINDOW = int(os.getenv("SYNESIS_ADMIN_AUTH_RATE_LIMIT_WINDOW_SECONDS", "60"))

_RAG_MAX = int(os.getenv("SYNESIS_ADMIN_RAG_RATE_LIMIT_MAX", "30"))
_RAG_WINDOW = int(os.getenv("SYNESIS_ADMIN_RAG_RATE_LIMIT_WINDOW_SECONDS", "60"))


@dataclass
class _BucketConfig:
    max_requests: int
    window_seconds: int


@dataclass
class _SlidingWindow:
    timestamps: list[float] = field(default_factory=list)

    def count_and_prune(self, now: float, window: float) -> int:
        cutoff = now - window
        self.timestamps = [t for t in self.timestamps if t > cutoff]
        return len(self.timestamps)

    def record(self, now: float) -> None:
        self.timestamps.append(now)


_PREFIX_CONFIGS: list[tuple[str, _BucketConfig]] = [
    ("/api/v1/auth", _BucketConfig(_AUTH_MAX, _AUTH_WINDOW)),
    ("/api/v1/rag", _BucketConfig(_RAG_MAX, _RAG_WINDOW)),
]
_GLOBAL_CONFIG = _BucketConfig(_DEFAULT_GLOBAL_MAX, _DEFAULT_GLOBAL_WINDOW)

_EXEMPT_PATHS = frozenset({"/api/v1/health", "/health", "/metrics"})

_buckets: dict[str, dict[str, _SlidingWindow]] = defaultdict(lambda: defaultdict(_SlidingWindow))

_MAX_TRACKED_IPS = 50_000
_LAST_CLEANUP = 0.0


def _get_client_ip(request: Request) -> str:
    return get_client_ip(request)


def _match_config(path: str) -> tuple[str, _BucketConfig]:
    for prefix, cfg in _PREFIX_CONFIGS:
        if path.startswith(prefix):
            return prefix, cfg
    return "__global__", _GLOBAL_CONFIG


def _maybe_cleanup(now: float) -> None:
    global _LAST_CLEANUP
    if now - _LAST_CLEANUP < 300:
        return
    _LAST_CLEANUP = now
    for bucket_name in list(_buckets.keys()):
        bucket = _buckets[bucket_name]
        if len(bucket) > _MAX_TRACKED_IPS:
            cfg = dict(_PREFIX_CONFIGS).get(bucket_name, _GLOBAL_CONFIG)
            cutoff = now - cfg.window_seconds
            stale = [ip for ip, w in bucket.items() if not w.timestamps or w.timestamps[-1] < cutoff]
            for ip in stale:
                del bucket[ip]


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        path = request.url.path
        if path in _EXEMPT_PATHS:
            return await call_next(request)

        client_ip = _get_client_ip(request)
        bucket_name, cfg = _match_config(path)
        now = time.monotonic()

        _maybe_cleanup(now)

        window = _buckets[bucket_name][client_ip]
        count = window.count_and_prune(now, cfg.window_seconds)

        if count >= cfg.max_requests:
            retry_after = (
                int(cfg.window_seconds - (now - window.timestamps[0])) + 1 if window.timestamps else cfg.window_seconds
            )
            return Response(
                content='{"error":"rate_limit_exceeded","message":"Too many requests"}',
                status_code=429,
                media_type="application/json",
                headers={"Retry-After": str(max(1, retry_after))},
            )

        window.record(now)
        response = await call_next(request)
        remaining = max(0, cfg.max_requests - count - 1)
        response.headers["X-RateLimit-Limit"] = str(cfg.max_requests)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        return response
