"""Synesis Admin Service -- React SPA + JSON API backend.

Serves the React SPA for all non-API routes and provides
/api/v1/* JSON endpoints for the admin dashboard.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from app.db.engine import engine
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from synesis_telemetry import CONTENT_TYPE_LATEST, configure_logging, generate_latest

configure_logging(service="synesis-admin")

logger = logging.getLogger("synesis.admin")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Schema is managed by Alembic migrations (run in entrypoint.sh).
    logger.info("admin_db_ready")
    yield
    await engine.dispose()


app = FastAPI(title="Synesis Admin", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from app.routers.assistant import router as assistant_router
from app.routers.auth_router import router as auth_router
from app.routers.conflict_groups import router as conflict_groups_router
from app.routers.dashboard import router as dashboard_router
from app.routers.feedback import router as feedback_router
from app.routers.integrations import router as integrations_router
from app.routers.models import router as models_router
from app.routers.observability import router as observability_router
from app.routers.pipeline import router as pipeline_router
from app.routers.rag import router as rag_router
from app.routers.settings import router as settings_router
from app.routers.taxonomy import router as taxonomy_router
from app.routers.ingestion import router as ingestion_router
from app.routers.traces import router as traces_router

app.include_router(assistant_router)
app.include_router(auth_router)
app.include_router(conflict_groups_router)
app.include_router(dashboard_router)
app.include_router(models_router)
app.include_router(rag_router)
app.include_router(taxonomy_router)
app.include_router(pipeline_router)
app.include_router(integrations_router)
app.include_router(feedback_router)
app.include_router(observability_router)
app.include_router(traces_router)
app.include_router(settings_router)
app.include_router(ingestion_router)


@app.get("/api/v1/health")
async def health():
    return {"status": "ok", "service": "synesis-admin"}


@app.get("/api/v1/events")
async def sse_events():
    """SSE endpoint for real-time admin dashboard notifications.

    Polls the traces table for new arrivals and emits events. Clients
    use this to invalidate TanStack Query caches without polling.
    """
    import asyncio
    import json
    import time

    from fastapi.responses import StreamingResponse

    async def event_stream():
        last_check = time.time()
        while True:
            await asyncio.sleep(5)
            try:
                from app.db.engine import async_session
                from sqlalchemy import func, select, text

                async with async_session() as session:
                    row = (
                        await session.execute(
                            text("SELECT COUNT(*)::int AS cnt FROM traces WHERE timestamp >= :ts"),
                            {"ts": last_check},
                        )
                    ).one()
                    new_count = row.cnt or 0
                    if new_count > 0:
                        yield f"data: {json.dumps({'type': 'new_traces', 'count': new_count})}\n\n"
                last_check = time.time()
            except Exception:
                yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/metrics")
async def metrics():
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


STATIC_DIR = Path(__file__).parent.parent / "static"

if STATIC_DIR.is_dir():
    assets_dir = STATIC_DIR / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="static-assets")

    def _mount_static_file(filename: str, resolved_path: Path) -> None:
        """Register a GET route that serves a single known static file."""

        @app.get(f"/{filename}")
        async def serve_static_file() -> FileResponse:
            return FileResponse(resolved_path)

    for name in ("vite.svg", "favicon.ico"):
        static_file = STATIC_DIR / name
        if static_file.exists():
            _mount_static_file(name, static_file)


@app.get("/")
async def serve_root():
    index = STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return {"message": "Synesis Admin API -- frontend not built"}


@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    if full_path.startswith("api/") or full_path.startswith("metrics"):
        return Response(status_code=404)
    index = STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return {"message": "Synesis Admin API -- frontend not built"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)  # nosec B104
