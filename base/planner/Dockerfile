FROM registry.access.redhat.com/ubi9/python-311:1

# Build metadata — set by CI; visible in logs for debugging stale containers
ARG GIT_SHA=dev
ARG BUILD_TIMESTAMP=dev
ENV SYNESIS_GIT_SHA=${GIT_SHA} \
    SYNESIS_BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

WORKDIR /opt/app-root/src

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY intent_weights.yaml .
COPY entry_classifier_weights.yaml .
COPY plugins/ ./plugins/

USER 1001

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
