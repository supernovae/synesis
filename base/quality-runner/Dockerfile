ARG BASE_IMAGE=ghcr.io/supernovae/synesis/synesis-base-api:latest
FROM ${BASE_IMAGE}

USER 0
COPY benchmarks/corpus/requirements.lock /tmp/corpus-req.lock
COPY tools/curator/requirements.lock /tmp/curator-req.lock
RUN uv pip install --python /opt/app-root/venv/bin/python --no-cache \
      -r /tmp/corpus-req.lock -r /tmp/curator-req.lock && \
    rm -f /tmp/corpus-req.lock /tmp/curator-req.lock

USER 1001

COPY benchmarks/ /app/benchmarks/
COPY tools/curator/ /app/tools/curator/
COPY base/quality-runner/entrypoint.py /app/entrypoint.py
COPY base/planner-ts/config/taxonomy_prompt_config.yaml /app/taxonomy_prompt_config.yaml

WORKDIR /app
CMD ["python", "entrypoint.py"]
