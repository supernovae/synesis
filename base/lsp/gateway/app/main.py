"""LSP Gateway -- FastAPI service wrapping 6 language analysis engines.

Provides deep type checking and symbol diagnostics beyond basic
linting. Called by the planner's lsp_analyzer node on code generation
failure to enrich error context for the worker's revision pass.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import asdict

from fastapi import FastAPI, HTTPException
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from pydantic import BaseModel, Field
from starlette.responses import Response

from .analyzers import ANALYZERS, get_analyzer, supported_languages
from .circuit_breaker import CircuitBreaker

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("synesis.lsp.gateway")

ANALYSIS_DURATION = Histogram(
    "synesis_lsp_analysis_duration_seconds",
    "LSP analysis duration in seconds",
    ["language", "engine"],
    buckets=[0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0],
)
ANALYSIS_DIAGNOSTICS = Counter(
    "synesis_lsp_diagnostics_count",
    "Total LSP diagnostics found",
    ["language", "severity"],
)
ANALYSIS_REQUESTS = Counter(
    "synesis_lsp_analysis_requests_total",
    "Total LSP analysis requests",
    ["language", "outcome"],
)

circuit_breakers: dict[str, CircuitBreaker] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    for _lang_key, analyzer in ANALYZERS.items():
        engine = analyzer.engine_name
        if engine not in circuit_breakers:
            circuit_breakers[engine] = CircuitBreaker(language=engine)
    logger.info(
        "lsp_gateway_started",
        extra={"engines": list(circuit_breakers.keys())},
    )
    yield


app = FastAPI(
    title="Synesis LSP Gateway",
    description="Deep code analysis for LLM-generated code",
    version="1.0.0",
    lifespan=lifespan,
)


class AnalyzeRequest(BaseModel):
    code: str
    language: str
    filename: str | None = None


class DiagnosticResponse(BaseModel):
    severity: str
    line: int
    column: int
    message: str
    rule: str = ""
    source: str = ""


class AnalyzeResponse(BaseModel):
    language: str
    engine: str
    diagnostics: list[DiagnosticResponse] = Field(default_factory=list)
    analysis_time_ms: float = 0.0
    error: str | None = None
    skipped: bool = False


class HealthResponse(BaseModel):
    status: str
    engines: dict[str, str]


class LanguageInfo(BaseModel):
    language: str
    engine: str
    file_extension: str


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(request: AnalyzeRequest):
    analyzer = get_analyzer(request.language)
    if analyzer is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported language: {request.language}. Supported: {', '.join(supported_languages())}",
        )

    cb = circuit_breakers.get(analyzer.engine_name)
    if cb and not cb.should_allow_request():
        ANALYSIS_REQUESTS.labels(
            language=request.language,
            outcome="circuit_open",
        ).inc()
        return AnalyzeResponse(
            language=analyzer.language,
            engine=analyzer.engine_name,
            skipped=True,
            error=f"Circuit breaker open for {analyzer.engine_name}",
        )

    result = await analyzer.analyze(
        code=request.code,
        filename=request.filename,
    )

    if result.error and not result.skipped:
        if cb:
            cb.record_failure()
        ANALYSIS_REQUESTS.labels(
            language=request.language,
            outcome="error",
        ).inc()
    else:
        if cb:
            cb.record_success()
        ANALYSIS_REQUESTS.labels(
            language=request.language,
            outcome="success",
        ).inc()

    ANALYSIS_DURATION.labels(
        language=analyzer.language,
        engine=analyzer.engine_name,
    ).observe(result.analysis_time_ms / 1000)

    for diag in result.diagnostics:
        ANALYSIS_DIAGNOSTICS.labels(
            language=analyzer.language,
            severity=diag.severity,
        ).inc()

    return AnalyzeResponse(
        language=result.language,
        engine=result.engine,
        diagnostics=[DiagnosticResponse(**asdict(d)) for d in result.diagnostics],
        analysis_time_ms=result.analysis_time_ms,
        error=result.error,
        skipped=result.skipped,
    )


@app.get("/health", response_model=HealthResponse)
async def health():
    engine_status: dict[str, str] = {}
    for engine, cb in circuit_breakers.items():
        engine_status[engine] = cb.state.name.lower()
    return HealthResponse(status="ok", engines=engine_status)


@app.get("/languages", response_model=list[LanguageInfo])
async def languages():
    seen: set[str] = set()
    result: list[LanguageInfo] = []
    for name, analyzer in ANALYZERS.items():
        engine = analyzer.engine_name
        if engine not in seen:
            seen.add(engine)
            result.append(
                LanguageInfo(
                    language=name,
                    engine=engine,
                    file_extension=analyzer.file_extension,
                )
            )
    return result


@app.get("/metrics")
async def metrics():
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST,
    )
