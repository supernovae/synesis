FROM registry.access.redhat.com/ubi10/python-312-minimal:latest

LABEL org.opencontainers.image.description="Synesis base API image — FastAPI, uvicorn, pydantic, httpx, numpy (UBI 10, Python 3.12 minimal)"

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

USER 0
RUN microdnf install -y git && microdnf clean all

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
