"""GLiNER extraction microservice — schema-driven NER for frame extraction.

Loads a GLiNER model at startup and exposes a /v1/extract endpoint that
accepts entity label schemas and returns extracted spans with confidence.

Inference is offloaded to a thread pool so health probes and concurrent
requests are never blocked by a running forward pass.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .extractor import extract, load_model

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("gliner_service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    logger.info("gliner-service ready")
    yield


app = FastAPI(title="Synesis GLiNER Service", lifespan=lifespan)


class ExtractionSchema(BaseModel):
    entities: dict[str, str] = Field(
        ...,
        description="Label -> description mapping for entity extraction",
    )
    classification: dict[str, list[str]] | None = Field(
        default=None,
        description="Optional classification config with categories list",
    )


class ExtractRequest(BaseModel):
    text: str
    schema_: ExtractionSchema = Field(..., alias="schema")
    threshold: float = Field(default=0.4, ge=0.0, le=1.0)

    model_config = {"populate_by_name": True}


class SpanResult(BaseModel):
    text: str
    start: int
    end: int
    confidence: float


class ExtractResponse(BaseModel):
    entities: dict[str, list[SpanResult]]
    classification: str = ""


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/v1/extract", response_model=ExtractResponse)
async def extract_endpoint(req: ExtractRequest):
    if not req.text or not req.text.strip():
        return ExtractResponse(entities={}, classification="")

    categories = None
    if req.schema_.classification:
        categories = req.schema_.classification.get("categories", [])

    try:
        result = await asyncio.to_thread(
            extract,
            text=req.text,
            entity_labels=req.schema_.entities,
            classification_categories=categories,
            threshold=req.threshold,
        )
        return ExtractResponse(**result)
    except Exception as e:
        logger.exception("extraction failed")
        raise HTTPException(status_code=502, detail=str(e)) from e
