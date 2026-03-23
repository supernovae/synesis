ARG BASE_IMAGE=ghcr.io/supernovae/synesis/synesis-base-api:latest

# --- Stage 1: Build React frontend ---
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --ignore-scripts 2>/dev/null || npm install
COPY frontend/ ./
RUN npm run build

# --- Stage 2: Python runtime ---
FROM ${BASE_IMAGE}

USER 0
WORKDIR /app
COPY requirements.txt .
RUN uv pip install --python /opt/app-root/venv/bin/python --no-cache -r requirements.txt

COPY alembic.ini ./
COPY alembic/ ./alembic/
COPY app/ ./app/
COPY entrypoint.sh ./
COPY --from=frontend /build/dist ./static/

USER 1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/v1/health')"]

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
