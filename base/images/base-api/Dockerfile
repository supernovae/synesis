FROM registry.access.redhat.com/ubi9/python-311:latest

LABEL org.opencontainers.image.description="Synesis base API image — FastAPI, uvicorn, pydantic, httpx, numpy"

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

USER 0
RUN dnf install -y git && dnf clean all

RUN uv venv --python /opt/app-root/bin/python /opt/app-root/venv

COPY requirements.lock /tmp/requirements.lock
RUN uv pip install --python /opt/app-root/venv/bin/python --no-cache --require-hashes -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock

COPY synesis-telemetry/ /tmp/synesis-telemetry/
RUN uv pip install --python /opt/app-root/venv/bin/python --no-cache /tmp/synesis-telemetry/ \
    && rm -rf /tmp/synesis-telemetry/

ENV PATH="/opt/app-root/venv/bin:${PATH}" \
    VIRTUAL_ENV=/opt/app-root/venv

USER 1001
