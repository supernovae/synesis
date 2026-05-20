"""BGE Reranker Service -- high-accuracy cross-encoder re-ranking.

Wraps BAAI/bge-reranker-v2-m3 behind a simple /rerank HTTP endpoint.
Default reranker for the planner; FlashRank is available as a lighter
inline alternative.

Model load runs in the background after bind so /live succeeds immediately;
/ready stays 503 until load finishes. If load fails, the service stays ready
in degraded mode and /rerank returns neutral scores (matches planner fallback).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import time

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from synesis_telemetry import configure_logging, get_logger
from transformers import AutoModelForSequenceClassification, AutoTokenizer

configure_logging(service="synesis-bge-reranker")
logger = get_logger("synesis.bge-reranker")

MODEL_NAME = os.environ.get("BGE_RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")
MODEL_REVISION = os.environ.get("BGE_RERANKER_REVISION", "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e")

tokenizer: AutoTokenizer | None = None
model: torch.nn.Module | None = None
_load_complete = False
_load_failed = False
_device = "cpu"


def _detect_device_and_dtype() -> tuple[str, torch.dtype]:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    return device, dtype


def _load_model_sync() -> tuple[AutoTokenizer, torch.nn.Module, str]:
    device, dtype = _detect_device_and_dtype()
    logger.info(
        "loading_model",
        extra={"model": MODEL_NAME, "revision": MODEL_REVISION, "device": device, "dtype": str(dtype)},
    )
    tok = AutoTokenizer.from_pretrained(MODEL_NAME, revision=MODEL_REVISION)
    m = (
        AutoModelForSequenceClassification.from_pretrained(MODEL_NAME, revision=MODEL_REVISION, torch_dtype=dtype)
        .to(device)
        .eval()
    )
    logger.info("model_loaded", extra={"device": device})
    return tok, m, device


async def _background_load() -> None:
    global tokenizer, model, _load_complete, _load_failed, _device
    try:
        tok, m, device = await asyncio.to_thread(_load_model_sync)
        tokenizer = tok
        model = m
        _device = device
    except Exception:
        logger.exception(
            "model_load_failed",
            extra={"model": MODEL_NAME, "revision": MODEL_REVISION},
        )
        tokenizer = None
        model = None
        _load_failed = True
    finally:
        _load_complete = True


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    _ = app
    task = asyncio.create_task(_background_load())
    yield
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="Synesis BGE Reranker", version="0.1.0", lifespan=lifespan)


class RerankRequest(BaseModel):
    query: str
    passages: list[str]
    top_k: int | None = None


class RerankResponse(BaseModel):
    scores: list[float]
    latency_ms: float


def _rerank_sync(request: RerankRequest) -> RerankResponse:
    assert tokenizer is not None and model is not None
    start = time.monotonic()
    device = _device

    pairs = [[request.query, p] for p in request.passages]
    inputs = tokenizer(
        pairs,
        padding=True,
        truncation=True,
        max_length=512,
        return_tensors="pt",
    ).to(device)

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


@app.post("/rerank", response_model=RerankResponse)
async def rerank(request: RerankRequest):
    if not _load_complete:
        raise HTTPException(status_code=503, detail="model loading")
    if _load_failed or tokenizer is None or model is None:
        return RerankResponse(scores=[0.0] * len(request.passages), latency_ms=0.0)

    return await asyncio.to_thread(_rerank_sync, request)


@app.get("/live")
async def live():
    """Process is up (bind succeeded). Use for Kubernetes liveness."""
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    """Model load finished (success or degraded). Use for Kubernetes readiness."""
    if not _load_complete:
        raise HTTPException(status_code=503, detail="model loading")
    return {
        "status": "degraded" if _load_failed else "ok",
        "model": MODEL_NAME,
        "device": _device if not _load_failed else None,
    }


@app.get("/health")
async def health():
    """Backward-compatible health: mirrors /ready semantics."""
    if not _load_complete:
        raise HTTPException(status_code=503, detail="model loading")
    return {
        "status": "ok" if not _load_failed else "degraded",
        "model": MODEL_NAME,
        "device": _device if not _load_failed else None,
    }
