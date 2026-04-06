FROM registry.access.redhat.com/ubi10/python-312-minimal:latest

# Install microdnf dependencies for tree-sitter compilation if needed
USER root
RUN microdnf install -y gcc gcc-c++ make && microdnf clean all

# Create app directory
WORKDIR /opt/app-root/src

# Copy uv binary
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy project files
COPY pyproject.toml ./
COPY app/ ./app/

# Install dependencies using uv
RUN uv pip install --system .

# Run the MCP server
CMD ["synesis-ast-mcp"]
