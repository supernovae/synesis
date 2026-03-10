FROM python:3.13-slim

LABEL org.opencontainers.image.description="Synesis dev-tools base — shellcheck, cppcheck, JDK, Node 20, Go 1.22"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        git \
        shellcheck \
        cppcheck \
        default-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Go 1.22
ENV GOLANG_VERSION=1.22.5
RUN curl -fsSL "https://go.dev/dl/go${GOLANG_VERSION}.linux-amd64.tar.gz" \
    | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"
