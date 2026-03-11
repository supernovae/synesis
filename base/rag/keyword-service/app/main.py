"""Keyword extraction microservice — lightweight alternative to in-process KeyBERT.

Delegates embedding to the TEI embedder service; performs ngram extraction,
cosine ranking, and MMR locally with numpy.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from synesis_telemetry import configure_logging, get_logger

from .embed_client import EmbedClient
from .extractor import extract_keywords, extract_keywords_batch

configure_logging(service="synesis-keyword-service")
logger = get_logger("synesis.keyword_service")

_embedder: EmbedClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _embedder
    _embedder = EmbedClient()
    logger.info("keyword-service ready (embedder=%s)", _embedder.url)
    yield


app = FastAPI(title="Synesis Keyword Service", lifespan=lifespan)


class KeywordRequest(BaseModel):
    text: str
    top_n: int = Field(default=8, ge=1, le=50)
    ngram_range: tuple[int, int] = (1, 2)
    use_mmr: bool = True
    diversity: float = Field(default=0.5, ge=0.0, le=1.0)


class KeywordResult(BaseModel):
    keywords: list[tuple[str, float]]


class BatchKeywordRequest(BaseModel):
    texts: list[str]
    top_n: int = Field(default=8, ge=1, le=50)
    ngram_range: tuple[int, int] = (1, 2)
    use_mmr: bool = True
    diversity: float = Field(default=0.5, ge=0.0, le=1.0)


class BatchKeywordResult(BaseModel):
    results: list[list[tuple[str, float]]]


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/v1/keywords", response_model=KeywordResult)
async def keywords_single(req: KeywordRequest):
    if not req.text or not req.text.strip():
        return KeywordResult(keywords=[])
    try:
        kws = extract_keywords(
            req.text,
            _embedder,
            top_n=req.top_n,
            ngram_range=req.ngram_range,
            use_mmr=req.use_mmr,
            diversity=req.diversity,
        )
        return KeywordResult(keywords=kws)
    except Exception as e:
        logger.exception("keyword extraction failed")
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.post("/v1/keywords/batch", response_model=BatchKeywordResult)
async def keywords_batch(req: BatchKeywordRequest):
    if not req.texts:
        return BatchKeywordResult(results=[])
    try:
        results = extract_keywords_batch(
            req.texts,
            _embedder,
            top_n=req.top_n,
            ngram_range=req.ngram_range,
            use_mmr=req.use_mmr,
            diversity=req.diversity,
        )
        return BatchKeywordResult(results=results)
    except Exception as e:
        logger.exception("batch keyword extraction failed")
        raise HTTPException(status_code=502, detail=str(e)) from e
