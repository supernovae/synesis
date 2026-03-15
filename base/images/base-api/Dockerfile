FROM python:3.13-slim

LABEL org.opencontainers.image.description="Synesis base API image — FastAPI, uvicorn, pydantic, httpx, numpy"

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN uv pip install --system --no-cache -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY synesis-telemetry/ /tmp/synesis-telemetry/
RUN uv pip install --system --no-cache /tmp/synesis-telemetry/ \
    && rm -rf /tmp/synesis-telemetry/

USER 1001
