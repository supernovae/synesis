"""BGE Reranker Service -- high-accuracy cross-encoder re-ranking.

Wraps BAAI/bge-reranker-v2-m3 behind a simple /rerank HTTP endpoint.
Only deployed when accuracy mode is needed; FlashRank handles the
default fast path inline.
"""

from __future__ import annotations

import logging
import os
import time

import torch
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoModelForSequenceClassification, AutoTokenizer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.bge-reranker")

MODEL_NAME = os.environ.get("BGE_RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32

logger.info(f"Loading {MODEL_NAME} on {DEVICE} with dtype={DTYPE}")
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
model = AutoModelForSequenceClassification.from_pretrained(MODEL_NAME, torch_dtype=DTYPE).to(DEVICE).eval()
logger.info("Model loaded")

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
