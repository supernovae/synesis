ARG BASE_IMAGE=ghcr.io/supernovae/synesis/synesis-base-devtools:latest
FROM ${BASE_IMAGE}

USER 0
RUN dnf install -y jq && dnf clean all

RUN uv pip install --system --no-cache \
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
