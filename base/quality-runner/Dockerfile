ARG BASE_IMAGE=ghcr.io/supernovae/synesis/synesis-base-api:latest
FROM ${BASE_IMAGE}

USER 0
COPY benchmarks/corpus/requirements.txt /tmp/corpus-req.txt
COPY tools/curator/requirements.txt /tmp/curator-req.txt
RUN uv pip install --system --no-cache -r /tmp/corpus-req.txt -r /tmp/curator-req.txt && \
    rm -f /tmp/corpus-req.txt /tmp/curator-req.txt

USER 1001

COPY benchmarks/ /app/benchmarks/
COPY tools/curator/ /app/tools/curator/
COPY base/quality-runner/entrypoint.py /app/entrypoint.py
COPY base/planner/taxonomy_prompt_config.yaml /app/taxonomy_prompt_config.yaml

WORKDIR /app
CMD ["python", "entrypoint.py"]
