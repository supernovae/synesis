ARG BASE_IMAGE=ghcr.io/supernovae/synesis/synesis-base-api:latest
FROM ${BASE_IMAGE}

LABEL org.opencontainers.image.description="Synesis ML base image — PyTorch + Transformers on top of base-api"

USER 0

COPY requirements.lock /tmp/requirements.lock
RUN uv pip install --python /opt/app-root/venv/bin/python --no-cache --require-hashes -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock

USER 1001
