ARG BASE_IMAGE=ghcr.io/supernovae/synesis/synesis-base-ml:latest
FROM ${BASE_IMAGE}

USER 0
WORKDIR /app

COPY requirements.txt .
RUN uv pip install --python /opt/app-root/venv/bin/python --no-cache -r requirements.txt

COPY app/ app/

USER 1001

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
