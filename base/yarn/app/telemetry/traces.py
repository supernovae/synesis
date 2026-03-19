"""OpenTelemetry and structured logging setup."""

from __future__ import annotations

import logging
import sys

from ..config import settings


def setup_logging() -> None:
    """Configure structured logging for the Yarn runtime."""
    level = getattr(logging, settings.log_level.upper(), logging.INFO)

    root = logging.getLogger()
    root.setLevel(level)

    if not root.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setLevel(level)
        formatter = logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
        handler.setFormatter(formatter)
        root.addHandler(handler)

    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def setup_otel() -> None:
    """Initialize OpenTelemetry tracing if configured."""
    if not settings.otel_endpoint:
        return

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        resource = Resource.create({"service.name": "synesis-yarn"})
        provider = TracerProvider(resource=resource)
        exporter = OTLPSpanExporter(endpoint=settings.otel_endpoint)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)

        logging.getLogger("yarn.telemetry").info(
            "OpenTelemetry initialized, exporting to %s", settings.otel_endpoint
        )
    except ImportError:
        logging.getLogger("yarn.telemetry").warning(
            "OpenTelemetry SDK not available, tracing disabled"
        )
