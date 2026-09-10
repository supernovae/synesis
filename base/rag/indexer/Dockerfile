# Retained indexer: static HTTP and document extraction, without browser/model runtimes.
FROM registry.access.redhat.com/ubi10/python-312-minimal:latest

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
USER 0
RUN microdnf install -y git && microdnf clean all
WORKDIR /app

COPY images/base-api/synesis-telemetry/ /tmp/synesis-telemetry/
RUN uv pip install --system --python /opt/app-root/bin/python --no-cache /tmp/synesis-telemetry/ \
    && rm -rf /tmp/synesis-telemetry/

COPY rag/indexer/requirements.lock .
RUN uv pip install --system --python /opt/app-root/bin/python --no-cache --require-hashes -r requirements.lock
COPY rag/indexer/app/ /app/app/

USER 1001
ENTRYPOINT ["python", "-m", "app.cli"]
CMD ["--mode", "queue"]
