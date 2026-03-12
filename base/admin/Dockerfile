ARG BASE_IMAGE=ghcr.io/supernovae/synesis/synesis-base-api:latest
FROM ${BASE_IMAGE}

USER 0
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

USER 1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8080/')"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
