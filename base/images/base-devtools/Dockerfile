FROM registry.access.redhat.com/ubi10/nodejs-24:latest

LABEL org.opencontainers.image.description="Synesis dev-tools base — UBI 10 Node.js 24, Python 3.12, Go + JDK 21 (AppStream), shellcheck + cppcheck (EPEL 10)"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER 0

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Node.js S2I image ships Python in /usr; pin uv to that interpreter (not an older RPM python).
ENV UV_PYTHON=/usr/bin/python3

# Shared telemetry library (from sibling base-api image source)
COPY base-api/synesis-telemetry/ /tmp/synesis-telemetry/
RUN uv pip install --system --no-cache /tmp/synesis-telemetry/ \
    && rm -rf /tmp/synesis-telemetry/

# EPEL: ShellCheck + cppcheck are not in UBI repos. Node 24 + git are in the nodejs-24 base image.
RUN dnf install -y \
        https://dl.fedoraproject.org/pub/epel/epel-release-latest-10.noarch.rpm \
    && dnf install -y \
        ShellCheck \
        cppcheck \
        golang \
        java-21-openjdk-headless \
        python-unversioned-command \
    && dnf clean all

USER 1001
