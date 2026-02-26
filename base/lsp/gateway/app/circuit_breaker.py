"""Per-language circuit breaker for LSP analyzers.

Prevents a broken language toolchain from consuming resources.
Follows the same pattern as the Synesis health monitor.
"""

from __future__ import annotations

import enum
import threading
import time
from dataclasses import dataclass, field

from prometheus_client import Counter, Gauge

CIRCUIT_STATE = Gauge(
    "synesis_lsp_circuit_breaker_state",
    "LSP circuit breaker state (0=closed, 1=half_open, 2=open)",
    ["language"],
)
CIRCUIT_TRIPS = Counter(
    "synesis_lsp_circuit_breaker_trips_total",
    "Total LSP circuit breaker trips",
    ["language"],
)


class CircuitState(enum.IntEnum):
    CLOSED = 0
    HALF_OPEN = 1
    OPEN = 2


@dataclass
class CircuitBreaker:
    language: str
    failure_threshold: int = 3
    reset_timeout_seconds: float = 30.0
    half_open_max_requests: int = 1

    state: CircuitState = field(default=CircuitState.CLOSED, init=False)
    failure_count: int = field(default=0, init=False)
    last_failure_time: float = field(default=0.0, init=False)
    half_open_requests: int = field(default=0, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)

    def record_success(self) -> None:
        with self._lock:
            if self.state == CircuitState.HALF_OPEN:
                self.half_open_requests += 1
                if self.half_open_requests >= self.half_open_max_requests:
                    self.state = CircuitState.CLOSED
                    self.failure_count = 0
                    self.half_open_requests = 0
            elif self.state == CircuitState.CLOSED:
                self.failure_count = 0
            self._update_metric()

    def record_failure(self) -> None:
        with self._lock:
            self.failure_count += 1
            self.last_failure_time = time.monotonic()
            old_state = self.state
            if self.state == CircuitState.HALF_OPEN or self.failure_count >= self.failure_threshold:
                self.state = CircuitState.OPEN
            if old_state != CircuitState.OPEN and self.state == CircuitState.OPEN:
                CIRCUIT_TRIPS.labels(language=self.language).inc()
            self._update_metric()

    def should_allow_request(self) -> bool:
        with self._lock:
            if self.state == CircuitState.CLOSED:
                return True
            if self.state == CircuitState.OPEN:
                elapsed = time.monotonic() - self.last_failure_time
                if elapsed >= self.reset_timeout_seconds:
                    self.state = CircuitState.HALF_OPEN
                    self.half_open_requests = 0
                    self._update_metric()
                    return True
                return False
            return True

    def _update_metric(self) -> None:
        CIRCUIT_STATE.labels(language=self.language).set(self.state.value)
