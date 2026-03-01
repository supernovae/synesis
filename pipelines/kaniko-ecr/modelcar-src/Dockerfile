# ModelCar Dockerfile — download from HF during build, OCI for vLLM
# Build args: MODEL_REPO, MODEL_NAME, HF_TOKEN (optional)

ARG MODEL_REPO
ARG MODEL_NAME=model

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
COPY --from=downloader /models /models
WORKDIR /models
LABEL org.opencontainers.image.title="Synesis ModelCar: ${MODEL_NAME}"
LABEL com.redhat.rhaiis.modelcar="true"
LABEL com.redhat.rhaiis.model-format="vllm"
ENV MODEL_PATH=/models
