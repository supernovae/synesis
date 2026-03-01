# ModelCar Dockerfile — OCI-compliant model image for ECR/RHOAI
# Model files land in /models. vLLM loads from --model=/models
#
# Build: docker build -f base/model-serving/modelcar/Dockerfile \
#   --build-arg MODEL_REPO=Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8 \
#   --build-arg MODEL_NAME=synesis-executor \
#   -t ${ECR_URI}/synesis-models:executor .
#
# Requires: HF_TOKEN for gated models; optional for public.
# Base: ubi9-minimal for minimal footprint (has cp/sh for init container).

ARG MODEL_REPO
ARG MODEL_NAME=model

FROM registry.access.redhat.com/ubi9/ubi-micro:latest AS base
# ubi9-micro is minimal; we need a way to get model files.
# Use multi-stage: builder stage downloads, final stage copies.

FROM python:3.12-slim AS downloader
ARG MODEL_REPO
ARG MODEL_NAME
ARG HF_TOKEN
ENV HF_HOME=/tmp/hf_home
ENV MODEL_REPO=${MODEL_REPO}
ENV HF_TOKEN=${HF_TOKEN}
RUN pip install --no-cache-dir "huggingface_hub[hf_transfer]" huggingface_hub
COPY download_model.py /download_model.py
RUN python /download_model.py

FROM registry.access.redhat.com/ubi9/ubi-minimal:latest
ARG MODEL_NAME
# Copy model from downloader stage (ubi-minimal has cp, sh for init container)
COPY --from=downloader /models /models
WORKDIR /models
# Init container: mount emptyDir at /output, run: cp -a /models/. /output/
# OCI ModelCar convention: model at /models
# Labels for registry discovery
LABEL org.opencontainers.image.title="Synesis ModelCar: ${MODEL_NAME}"
LABEL org.opencontainers.image.description="OCI model bundle for vLLM inference"
LABEL com.redhat.rhaiis.modelcar="true"
LABEL com.redhat.rhaiis.model-format="vllm"
ENV MODEL_PATH=/models
