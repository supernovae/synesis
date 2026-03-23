"""BGE Reranker Service -- high-accuracy cross-encoder re-ranking.

Wraps BAAI/bge-reranker-v2-m3 behind a simple /rerank HTTP endpoint.
Default reranker for the planner; FlashRank is available as a lighter
inline alternative.
"""

from __future__ import annotations

import os
import time

import torch
from fastapi import FastAPI
from pydantic import BaseModel
from synesis_telemetry import configure_logging, get_logger
from transformers import AutoModelForSequenceClassification, AutoTokenizer

configure_logging(service="synesis-bge-reranker")
logger = get_logger("synesis.bge-reranker")

MODEL_NAME = os.environ.get("BGE_RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")
MODEL_REVISION = os.environ.get("BGE_RERANKER_REVISION", "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32

logger.info(
    "loading_model", extra={"model": MODEL_NAME, "revision": MODEL_REVISION, "device": DEVICE, "dtype": str(DTYPE)}
)
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, revision=MODEL_REVISION)
model = (
    AutoModelForSequenceClassification.from_pretrained(MODEL_NAME, revision=MODEL_REVISION, torch_dtype=DTYPE)
    .to(DEVICE)
    .eval()
)
logger.info("model_loaded")

app = FastAPI(title="Synesis BGE Reranker", version="0.1.0")


class RerankRequest(BaseModel):
    query: str
    passages: list[str]
    top_k: int | None = None


class RerankResponse(BaseModel):
    scores: list[float]
    latency_ms: float


@app.post("/rerank", response_model=RerankResponse)
async def rerank(request: RerankRequest):
    start = time.monotonic()

    pairs = [[request.query, p] for p in request.passages]
    inputs = tokenizer(
        pairs,
        padding=True,
        truncation=True,
        max_length=512,
        return_tensors="pt",
    ).to(DEVICE)

    with torch.no_grad():
        logits = model(**inputs).logits.squeeze(-1)
        scores = torch.sigmoid(logits).cpu().tolist()

    if isinstance(scores, float):
        scores = [scores]

    elapsed = (time.monotonic() - start) * 1000

    logger.info(
        "rerank_completed",
        extra={
            "passages": len(request.passages),
            "latency_ms": elapsed,
        },
    )

    return RerankResponse(scores=scores, latency_ms=elapsed)


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_NAME, "device": DEVICE}
