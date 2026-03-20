"""Spam scoring microservice — small HF sequence classifier (CPU)."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from synesis_telemetry import configure_logging, get_logger

from .classifier import load_model, spam_probabilities

configure_logging(service="synesis-spam-service")
logger = get_logger("synesis.spam_service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    logger.info("spam-service ready")
    yield


app = FastAPI(title="Synesis Spam Service", lifespan=lifespan)


class SpamBatchRequest(BaseModel):
    texts: list[str] = Field(default_factory=list, max_length=128)


class SpamBatchResponse(BaseModel):
    scores: list[float]


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/v1/spam/batch", response_model=SpamBatchResponse)
async def spam_batch(req: SpamBatchRequest):
    if not req.texts:
        return SpamBatchResponse(scores=[])
    safe = [t if (t or "").strip() else " " for t in req.texts]
    try:
        scores = await asyncio.to_thread(spam_probabilities, safe)
        return SpamBatchResponse(scores=scores)
    except Exception as e:
        logger.exception("spam batch failed")
        raise HTTPException(status_code=502, detail=str(e)) from e
