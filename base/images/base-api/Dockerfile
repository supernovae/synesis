FROM python:3.13-slim

LABEL org.opencontainers.image.description="Synesis base API image — FastAPI, uvicorn, pydantic, httpx, numpy"

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY synesis-telemetry/ /tmp/synesis-telemetry/
RUN pip install --no-cache-dir /tmp/synesis-telemetry/ \
    && rm -rf /tmp/synesis-telemetry/
