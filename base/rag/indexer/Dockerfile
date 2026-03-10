FROM python:3.13-slim

# System deps: git + Chromium shared libraries required by Playwright.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        libasound2t64 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libglib2.0-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libx11-6 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download Chromium for Playwright (used by crawl4ai web_page handler).
# PLAYWRIGHT_BROWSERS_PATH must be readable by the arbitrary UID at runtime.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN playwright install chromium \
    && chmod -R 755 /opt/pw-browsers

COPY app/ /app/app/
COPY seed-corpus.json /app/seed-corpus.json
COPY seed-corpus-band2.json /app/seed-corpus-band2.json
COPY seed-corpus-developer.json /app/seed-corpus-developer.json

# Writable dirs for OpenShift (runs as arbitrary non-root UID).
# HOME must point somewhere writable so Path.home() / ~ expansion works.
# CRAWL4_AI_BASE_DIRECTORY is the env var crawl4ai actually reads (note the
# underscore between CRAWL4 and AI — different from the documented name).
ENV HOME=/tmp \
    CRAWL4_AI_BASE_DIRECTORY=/tmp
RUN mkdir -p /tmp/.crawl4ai && chmod -R 777 /tmp/.crawl4ai

USER 1001

ENTRYPOINT ["python", "-m", "app.cli"]
CMD ["--sources", "/data/sources.yaml"]
