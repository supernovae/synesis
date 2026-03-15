ARG BASE_IMAGE=ghcr.io/supernovae/synesis/synesis-base-api:latest
FROM ${BASE_IMAGE}

LABEL org.opencontainers.image.description="Synesis ML base image — PyTorch + Transformers on top of base-api"

USER 0

COPY requirements.txt /tmp/requirements.txt
RUN uv pip install --system --no-cache -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

USER 1001
