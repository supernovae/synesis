FROM python:3.12-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    shellcheck \
    cppcheck \
    default-jdk-headless \
    nodejs \
    npm \
    golang-go \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    ruff \
    bandit \
    semgrep

# hadolint ignore=DL3016
RUN npm install -g eslint prettier --no-fund --no-audit 2>/dev/null || true

RUN mkdir -p /sandbox /tmp/sandbox-work
COPY run.sh /sandbox/run.sh
COPY warm_server.py /sandbox/warm_server.py
COPY semgrep-rules/ /sandbox/semgrep-rules/
RUN chmod +x /sandbox/run.sh

USER 1000
WORKDIR /tmp/sandbox-work

EXPOSE 8080

ENTRYPOINT ["/sandbox/run.sh"]
