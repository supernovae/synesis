"""Per-endpoint circuit breaker for model providers.

Ported from base/planner/app/model_client.py with the same state machine:
closed (normal) -> open (all calls rejected) -> half-open (probe).
"""

from __future__ import annotations

import logging
import time

logger = logging.getLogger("yarn.model.breaker")

CLOSED = "closed"
OPEN = "open"
HALF_OPEN = "half_open"


class CircuitBreaker:
    __slots__ = (
        "_failure_count",
        "_half_open_calls",
        "_last_failure_time",
        "_state",
        "failure_threshold",
        "half_open_max",
        "name",
        "recovery_timeout",
    )

    def __init__(
        self,
        name: str,
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
        half_open_max: int = 1,
    ) -> None:
        self.name = name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.half_open_max = half_open_max
        self._state = CLOSED
        self._failure_count = 0
        self._last_failure_time = 0.0
        self._half_open_calls = 0

    @property
    def state(self) -> str:
        if self._state == OPEN:
            if time.time() - self._last_failure_time >= self.recovery_timeout:
                self._state = HALF_OPEN
                self._half_open_calls = 0
                logger.info("Circuit breaker %s: OPEN -> HALF_OPEN", self.name)
        return self._state

    def allow_request(self) -> bool:
        s = self.state
        if s == CLOSED:
            return True
        if s == HALF_OPEN:
            if self._half_open_calls < self.half_open_max:
                self._half_open_calls += 1
                return True
            return False
        return False

    def record_success(self) -> None:
        if self._state in (HALF_OPEN, OPEN):
            logger.info("Circuit breaker %s: %s -> CLOSED", self.name, self._state)
        self._state = CLOSED
        self._failure_count = 0

    def record_failure(self) -> None:
        self._failure_count += 1
        self._last_failure_time = time.time()
        if self._state == HALF_OPEN:
            self._state = OPEN
            logger.warning("Circuit breaker %s: HALF_OPEN -> OPEN", self.name)
        elif self._failure_count >= self.failure_threshold:
            self._state = OPEN
            logger.warning(
                "Circuit breaker %s: CLOSED -> OPEN (failures=%d)",
                self.name,
                self._failure_count,
            )
