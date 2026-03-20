"""Preprocess microservice: HTML boilerplate removal (jusText) + simhash."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from synesis_telemetry import configure_logging, get_logger

from .hashing import text_simhash_decimal
from .html_clean import clean_html_to_text

configure_logging(service="synesis-preprocess-service")
logger = get_logger("synesis.preprocess_service")

app = FastAPI(title="Synesis Preprocess Service")


class CleanHtmlRequest(BaseModel):
    html: str = Field(default="", max_length=2_500_000)
    language: str = Field(default="English", max_length=32)


class CleanHtmlResponse(BaseModel):
    text: str


class SimhashBatchRequest(BaseModel):
    texts: list[str] = Field(default_factory=list, max_length=256)


class SimhashBatchResponse(BaseModel):
    simhashes: list[str]


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/v1/clean_html", response_model=CleanHtmlResponse)
async def clean_html(req: CleanHtmlRequest):
    try:
        text = clean_html_to_text(req.html, language=req.language)
        return CleanHtmlResponse(text=text)
    except Exception as e:
        logger.exception("clean_html failed")
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.post("/v1/simhash/batch", response_model=SimhashBatchResponse)
async def simhash_batch(req: SimhashBatchRequest):
    if not req.texts:
        return SimhashBatchResponse(simhashes=[])
    try:
        return SimhashBatchResponse(simhashes=[text_simhash_decimal(t) for t in req.texts])
    except Exception as e:
        logger.exception("simhash batch failed")
        raise HTTPException(status_code=502, detail=str(e)) from e
