"""Erlang/OTP-style health monitor for Synesis services.

Periodically probes all dependent services, manages circuit breaker
state, and exposes Prometheus metrics. Runs as a sidecar deployment
alongside the planner.
"""

from __future__ import annotations

import asyncio
import enum
import logging
import time
from dataclasses import dataclass
from pathlib import Path

import httpx
import yaml
from prometheus_client import Counter, Gauge, start_http_server

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.health_monitor")

# Prometheus metrics
SERVICE_HEALTH = Gauge(
    "synesis_service_health",
    "Service health status (1=healthy, 0=unhealthy)",
    ["service"],
)
CIRCUIT_STATE = Gauge(
    "synesis_circuit_breaker_state",
    "Circuit breaker state (0=closed, 1=half_open, 2=open)",
    ["service"],
)
HEALTH_CHECK_FAILURES = Counter(
    "synesis_health_check_failures_total",
    "Total health check failures",
    ["service"],
)
CIRCUIT_TRIPS = Counter(
    "synesis_circuit_breaker_trips_total",
    "Total circuit breaker trips",
    ["service"],
)


class CircuitState(enum.IntEnum):
    CLOSED = 0
    HALF_OPEN = 1
    OPEN = 2


@dataclass
class CircuitBreaker:
    failure_threshold: int = 5
    reset_timeout_seconds: float = 60.0
    half_open_max_requests: int = 2

    state: CircuitState = CircuitState.CLOSED
    failure_count: int = 0
    last_failure_time: float = 0.0
    half_open_requests: int = 0

    def record_success(self):
        if self.state == CircuitState.HALF_OPEN:
            self.half_open_requests += 1
            if self.half_open_requests >= self.half_open_max_requests:
                self.state = CircuitState.CLOSED
                self.failure_count = 0
                self.half_open_requests = 0
        elif self.state == CircuitState.CLOSED:
            self.failure_count = 0

    def record_failure(self):
        self.failure_count += 1
        self.last_failure_time = time.monotonic()

        if self.state == CircuitState.HALF_OPEN or self.failure_count >= self.failure_threshold:
            self.state = CircuitState.OPEN

    def should_allow_request(self) -> bool:
        if self.state == CircuitState.CLOSED:
            return True
        if self.state == CircuitState.OPEN:
            elapsed = time.monotonic() - self.last_failure_time
            if elapsed >= self.reset_timeout_seconds:
                self.state = CircuitState.HALF_OPEN
                self.half_open_requests = 0
                return True
            return False
        return True


@dataclass
class ServiceConfig:
    name: str
    endpoint: str
    health_path: str
    circuit_breaker: CircuitBreaker
    timeout_seconds: float = 10.0


def load_config(config_path: str = "/etc/synesis/supervisor.yaml") -> list[ServiceConfig]:
    from .url_utils import ensure_url_protocol

    path = Path(config_path)
    if not path.exists():
        logger.warning(f"Config not found at {config_path}, using defaults")
        return []

    with open(path) as f:
        raw = yaml.safe_load(f)

    services = []
    for name, cfg in raw.get("services", {}).items():
        cb_cfg = cfg.get("circuit_breaker", {})
        cb = CircuitBreaker(
            failure_threshold=cb_cfg.get("failure_threshold", 5),
            reset_timeout_seconds=cb_cfg.get("reset_timeout_seconds", 60),
            half_open_max_requests=cb_cfg.get("half_open_max_requests", 2),
        )
        endpoint = ensure_url_protocol(cfg.get("endpoint", ""))
        services.append(
            ServiceConfig(
                name=name,
                endpoint=endpoint,
                health_path=cfg.get("health_path", "/health"),
                circuit_breaker=cb,
                timeout_seconds=cfg.get("timeout_seconds", 10),
            )
        )

    return services


async def check_service(client: httpx.AsyncClient, svc: ServiceConfig) -> bool:
    if not svc.circuit_breaker.should_allow_request():
        return False

    try:
        url = f"{svc.endpoint.rstrip('/')}{svc.health_path}"
        resp = await client.get(url, timeout=svc.timeout_seconds)
        healthy = resp.status_code < 500
        if healthy:
            svc.circuit_breaker.record_success()
        else:
            svc.circuit_breaker.record_failure()
            HEALTH_CHECK_FAILURES.labels(service=svc.name).inc()
        return healthy
    except Exception:
        svc.circuit_breaker.record_failure()
        HEALTH_CHECK_FAILURES.labels(service=svc.name).inc()
        return False


async def monitor_loop(services: list[ServiceConfig], interval: float = 15.0):
    async with httpx.AsyncClient() as client:
        while True:
            for svc in services:
                old_state = svc.circuit_breaker.state
                healthy = await check_service(client, svc)

                SERVICE_HEALTH.labels(service=svc.name).set(1 if healthy else 0)
                CIRCUIT_STATE.labels(service=svc.name).set(svc.circuit_breaker.state.value)

                if old_state != CircuitState.OPEN and svc.circuit_breaker.state == CircuitState.OPEN:
                    CIRCUIT_TRIPS.labels(service=svc.name).inc()
                    logger.warning(f"Circuit OPENED for {svc.name}")

                if old_state == CircuitState.OPEN and svc.circuit_breaker.state != CircuitState.OPEN:
                    logger.info(f"Circuit recovering for {svc.name}: {svc.circuit_breaker.state.name}")

            await asyncio.sleep(interval)


def main():
    logger.info("Starting Synesis health monitor")
    start_http_server(9090)

    services = load_config()
    if not services:
        logger.warning("No services configured, monitor will idle")

    asyncio.run(monitor_loop(services))


if __name__ == "__main__":
    main()
