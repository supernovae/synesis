ARG BASE_IMAGE=synesis-base-api:latest
FROM ${BASE_IMAGE}

USER 0
# Install microdnf dependencies for tree-sitter compilation if needed
RUN microdnf install -y gcc gcc-c++ make && microdnf clean all

# Create app directory
WORKDIR /opt/app-root/src

# Copy project files
COPY pyproject.toml requirements.lock ./
COPY app/ ./app/

# Install dependencies using uv into the existing venv
RUN uv pip install --python /opt/app-root/venv/bin/python --no-cache --require-hashes -r requirements.lock

# Run the MCP server
USER 1001
CMD ["python", "-m", "app.server"]