# UBI 10 minimal + Playwright/Crawl4AI headless Chromium.
#
# Playwright ships as a **PyPI** package (`playwright`); its CLI embeds Node for
# `playwright install chromium`. On UBI, `playwright install-deps` only prints
# Ubuntu `apt-get` commands (unsupported OS fallback) — it does **not** run dnf.
# We install equivalent Chromium shared-library RPMs via microdnf instead.
FROM registry.access.redhat.com/ubi10/python-312-minimal:latest

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

USER 0

# Shared libs for Playwright's bundled Chromium (mapped from Playwright's Ubuntu 24.04 dep set).
RUN microdnf install -y \
        alsa-lib \
        atk \
        at-spi2-atk \
        at-spi2-core \
        cairo \
        cups-libs \
        dbus-libs \
        default-fonts-core-sans \
        fontconfig \
        freetype \
        git \
        glib2 \
        google-noto-sans-vf-fonts \
        langpacks-fonts-en \
        liberation-mono-fonts \
        libdrm \
        libX11 \
        libxcb \
        libXcomposite \
        libXdamage \
        libXext \
        libXfixes \
        libxkbcommon \
        libXrandr \
        mesa-dri-drivers \
        mesa-filesystem \
        mesa-libgbm \
        nspr \
        nss \
        nss-util \
        pango \
        xorg-x11-fonts-misc \
        xorg-x11-fonts-Type1 \
    && microdnf clean all

WORKDIR /app

COPY images/base-api/synesis-telemetry/ /tmp/synesis-telemetry/
# Install into the S2I interpreter at /opt/app-root/bin/python (not /usr/local — that
# interpreter is not the default `python` on this image).
RUN uv pip install --system --python /opt/app-root/bin/python --no-cache /tmp/synesis-telemetry/ \
    && rm -rf /tmp/synesis-telemetry/

COPY rag/indexer/requirements.lock .
# requirements.lock is fully resolved with security overrides; install the
# locked set directly so uv does not re-solve crawl4ai's stale lxml<6 metadata.
RUN uv pip install --system --python /opt/app-root/bin/python --no-cache --require-hashes --no-deps -r requirements.lock \
    && (uv pip uninstall --system --python /opt/app-root/bin/python unclecode-litellm 2>/dev/null || true)

# Download Chromium for Playwright (used by crawl4ai web_page handler).
# PLAYWRIGHT_BROWSERS_PATH must be readable by the arbitrary UID at runtime.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN /opt/app-root/bin/python -m playwright install chromium \
    && chmod -R 755 /opt/pw-browsers

COPY rag/indexer/app/ /app/app/
COPY rag/indexer/seed-corpus.json /app/seed-corpus.json
COPY rag/indexer/seed-corpus-band2.json /app/seed-corpus-band2.json
COPY rag/indexer/seed-corpus-developer.json /app/seed-corpus-developer.json
COPY rag/indexer/seed-corpus-ai-architecture.json /app/seed-corpus-ai-architecture.json
COPY rag/indexer/seed-corpus-retrieval-depth.json /app/seed-corpus-retrieval-depth.json

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
