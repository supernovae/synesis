ARG BASE_IMAGE=ghcr.io/supernovae/synesis/synesis-base-devtools:latest
FROM ${BASE_IMAGE}

USER 0
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# TypeScript compiler (Node already in base)
RUN npm install -g typescript@5

# staticcheck for Go (Go already in base)
RUN GOBIN=/usr/local/bin go install honnef.co/go/tools/cmd/staticcheck@2024.1.1

# Rust minimal toolchain (rustc + cargo only, no docs)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable \
    && . /root/.cargo/env && rustup component add clippy
ENV PATH="/root/.cargo/bin:${PATH}"

# basedpyright for Python type checking
RUN uv pip install --system --no-cache basedpyright

# Python app dependencies
WORKDIR /app
COPY requirements.txt .
RUN uv pip install --system --no-cache -r requirements.txt

COPY app/ app/

RUN useradd -u 1000 -m lsp
USER 1000

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
