FROM registry.access.redhat.com/ubi9/python-311:latest

LABEL org.opencontainers.image.description="Synesis dev-tools base — UBI 9 Python 3.11, Node.js 22 (module), Go + JDK 21 (AppStream), shellcheck + cppcheck (EPEL)"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER 0

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# As root, `uv pip install --system` otherwise resolves to /usr/bin/python3 (e.g. 3.9 from RPM deps).
ENV UV_PYTHON=/opt/app-root/bin/python

# Shared telemetry library (from sibling base-api image source)
COPY base-api/synesis-telemetry/ /tmp/synesis-telemetry/
RUN uv pip install --system --no-cache /tmp/synesis-telemetry/ \
    && rm -rf /tmp/synesis-telemetry/

# EPEL: ShellCheck + cppcheck are not published in UBI BaseOS/AppStream.
# Node.js 22, Go, JDK from Red Hat module / AppStream (same lineage as admin ubi9/nodejs-22).
RUN dnf install -y \
        https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm \
    && dnf module enable -y nodejs:22 \
    && dnf install -y \
        ShellCheck \
        cppcheck \
        git \
        golang \
        java-21-openjdk-headless \
        nodejs \
        npm \
    && dnf clean all

USER 1001
