ARG BASE_IMAGE=ghcr.io/supernovae/synesis/synesis-base-api:latest
FROM ${BASE_IMAGE}

# Build metadata — set by CI; visible in logs for debugging stale containers
ARG GIT_SHA=dev
ARG BUILD_TIMESTAMP=dev
ENV SYNESIS_GIT_SHA=${GIT_SHA} \
    SYNESIS_BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

USER 0
WORKDIR /opt/app-root/src

COPY requirements.txt .
RUN uv pip install --system --no-cache -r requirements.txt

# Pre-download FlashRank reranker model so it's baked into the image
# instead of fetching 21MB on first request at runtime.
RUN python -c "from flashrank import Ranker; Ranker(model_name='ms-marco-MiniLM-L-12-v2')"

COPY app/ ./app/
COPY intent_weights.yaml .
COPY entry_classifier_weights.yaml .
COPY taxonomy_prompt_config.yaml .
COPY intent_prompts.yaml .
COPY plugins/ ./plugins/

USER 1001

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY:-2}"]
