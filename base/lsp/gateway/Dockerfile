FROM python:3.12-slim AS base

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    shellcheck \
    cppcheck \
    default-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 LTS for TypeScript
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# TypeScript compiler
RUN npm install -g typescript@5

# Go toolchain
ENV GOLANG_VERSION=1.22.5
RUN curl -fsSL "https://go.dev/dl/go${GOLANG_VERSION}.linux-amd64.tar.gz" \
    | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"

# staticcheck for Go
RUN GOBIN=/usr/local/bin go install honnef.co/go/tools/cmd/staticcheck@2024.1.1

# Rust minimal toolchain (rustc + cargo only, no docs)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable \
    && . /root/.cargo/env && rustup component add clippy
ENV PATH="/root/.cargo/bin:${PATH}"

# basedpyright for Python type checking
RUN pip install --no-cache-dir basedpyright

# Python app dependencies
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ app/

# Non-root user for restricted PSA compliance
RUN useradd -u 1000 -m lsp
USER 1000

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
