"""Synesis Admin Service -- React SPA + JSON API backend.

Serves the React SPA for all non-API routes and provides
/api/v1/* JSON endpoints for the admin dashboard.
"""

from __future__ import annotations

import asyncio
import logging
import os as _os
from contextlib import asynccontextmanager
from pathlib import Path

from app.auth import UserInfo, get_current_user
from app.db.engine import engine
from app.internal_auth import ServicePrincipal, require_service_or_platform_admin
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from synesis_telemetry import CONTENT_TYPE_LATEST, configure_logging, generate_latest

configure_logging(service="synesis-admin")

logger = logging.getLogger("synesis.admin")


_reconciler_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.routers.provider_governance import seed_provider_configs
    from app.services.infra_pricing import ensure_table as ensure_infra_table
    from app.services.model_reconciler import reconcile
    from app.services.prompt_library import seed_default_prompt_profiles

    # Schema is managed by Alembic migrations (run in entrypoint.sh).
    logger.info("admin_db_ready")

    try:
        await ensure_infra_table()
    except Exception:
        logger.debug("infra_table_ensure_failed", exc_info=True)

    try:
        provider_count = await seed_provider_configs()
        if provider_count:
            logger.info("provider_seed_complete count=%d", provider_count)
    except Exception:
        logger.warning("provider_seed_failed", exc_info=True)

    try:
        prompt_seeded = await seed_default_prompt_profiles()
        if prompt_seeded:
            logger.info("prompt_profile_seed_complete count=%d", prompt_seeded)
    except Exception:
        logger.warning("prompt_profile_seed_failed", exc_info=True)

    try:
        boot = await reconcile()
        logger.info("model_reconcile_bootstrap %s", boot)
    except Exception:
        logger.warning("model_reconcile_bootstrap_failed", exc_info=True)

    _snapshot_counter = 0

    async def _background_reconciler():
        nonlocal _snapshot_counter
        from app.services.admin_audit import record_admin_audit

        await asyncio.sleep(15)
        while True:
            try:
                summary = await reconcile()
                if summary and (
                    summary.get("added") or summary.get("removed") or summary.get("updated") or summary.get("failed")
                ):
                    failed = int(summary.get("failed", 0) or 0)
                    await record_admin_audit(
                        user=None,
                        source="system",
                        action="models.reconcile.scheduled",
                        status="partial" if failed > 0 else "success",
                        summary=(
                            f"Scheduled LiteLLM reconcile: +{summary.get('added', 0)} added, "
                            f"~{summary.get('updated', 0)} updated, "
                            f"-{summary.get('removed', 0)} removed" + (f", !{failed} failed" if failed > 0 else "")
                        ),
                        detail=summary,
                    )
            except Exception as exc:
                logger.debug("background_reconcile_error", exc_info=True)
                await record_admin_audit(
                    user=None,
                    source="system",
                    action="models.reconcile.scheduled",
                    status="error",
                    summary="Scheduled LiteLLM reconcile raised an exception",
                    detail={"error": repr(exc)},
                )
            _snapshot_counter += 1
            if _snapshot_counter % 5 == 0:  # every ~5 min
                try:
                    from app.services.telemetry_scraper import scrape_all

                    await scrape_all()
                except Exception:
                    logger.debug("telemetry_scrape_error", exc_info=True)
            await asyncio.sleep(60)

    global _reconciler_task
    _reconciler_task = asyncio.create_task(_background_reconciler())

    yield

    if _reconciler_task and not _reconciler_task.done():
        _reconciler_task.cancel()
    await engine.dispose()


_openapi_enabled = _os.getenv("SYNESIS_ENABLE_OPENAPI", "false").lower() in {"1", "true", "yes"}

app = FastAPI(
    title="Synesis Admin",
    version="1.0.0",
    lifespan=lifespan,
    description="Operator API and React SPA. JSON routes are under /api/v1; interactive docs under /api/docs.",
    # Under /api so the SPA catch-all does not serve index.html for /docs.
    docs_url="/api/docs" if _openapi_enabled else None,
    redoc_url="/api/redoc" if _openapi_enabled else None,
    openapi_url="/api/openapi.json" if _openapi_enabled else None,
)

_cors_origins_env = _os.getenv("SYNESIS_CORS_ORIGINS", "")
_cors_origins = (
    [o.strip() for o in _cors_origins_env.split(",") if o.strip()]
    if _cors_origins_env
    else ["http://localhost:5173", "http://localhost:3000"]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from app.routers.acl import router as acl_router
from app.routers.admin_mcp import internal_router as admin_mcp_internal_router
from app.routers.assistant import router as assistant_router
from app.routers.audit import router as audit_router
from app.routers.auth_router import router as auth_router
from app.routers.authz import router as authz_router
from app.routers.conflict_groups import router as conflict_groups_router
from app.routers.conformance import router as conformance_router
from app.routers.dashboard import router as dashboard_router
from app.routers.developer_hub import router as developer_hub_router
from app.routers.evals import router as evals_router
from app.routers.feedback import router as feedback_router
from app.routers.feedback_loop import router as feedback_loop_router
from app.routers.governance import router as governance_router
from app.routers.ingestion import router as ingestion_router
from app.routers.ingestion_staged import router as ingestion_staged_router
from app.routers.integrations import router as integrations_router
from app.routers.models import router as models_router
from app.routers.observability import router as observability_router
from app.routers.patterns import router as patterns_router
from app.routers.pipeline import router as pipeline_router
from app.routers.planner_usage import router as planner_usage_router
from app.routers.provider_governance import router as provider_governance_router
from app.routers.providers import router as providers_router
from app.routers.rag import router as rag_router
from app.routers.security import router as security_router
from app.routers.serving import router as serving_router
from app.routers.settings import router as settings_router
from app.routers.taxonomy import router as taxonomy_router
from app.routers.testing_labs import router as testing_labs_router
from app.routers.tokens import router as tokens_router
from app.routers.traces import router as traces_router
from app.routers.usage import router as usage_router
from app.routers.yarn import router as yarn_router

app.include_router(admin_mcp_internal_router)
app.include_router(acl_router)
app.include_router(assistant_router)
app.include_router(authz_router)
app.include_router(audit_router)
app.include_router(auth_router)
app.include_router(conformance_router)
app.include_router(conflict_groups_router)
app.include_router(evals_router)
app.include_router(dashboard_router)
app.include_router(developer_hub_router)
app.include_router(models_router)
app.include_router(rag_router)
app.include_router(taxonomy_router)
app.include_router(pipeline_router)
app.include_router(planner_usage_router)
app.include_router(integrations_router)
app.include_router(feedback_router)
app.include_router(feedback_loop_router)
app.include_router(governance_router)
app.include_router(observability_router)
app.include_router(patterns_router)
app.include_router(traces_router)
app.include_router(providers_router)
app.include_router(settings_router)
app.include_router(tokens_router)
app.include_router(ingestion_router)
app.include_router(ingestion_staged_router)
app.include_router(usage_router)
app.include_router(provider_governance_router)
app.include_router(security_router)
app.include_router(serving_router)
app.include_router(testing_labs_router)
app.include_router(yarn_router)


@app.get("/api/v1/health")
async def health():
    return {"status": "ok", "service": "synesis-admin"}


@app.get("/api/v1/events")
async def sse_events(_user: UserInfo = Depends(get_current_user)):
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
                from sqlalchemy import text

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
async def metrics(_principal: ServicePrincipal | UserInfo = Depends(require_service_or_platform_admin)):
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
    # Unmatched API paths → 404. OpenAPI UI is registered on the app before this route (see docs_url).
    if full_path.startswith("api/") or full_path.startswith("metrics"):
        return Response(status_code=404)
    index = STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return {"message": "Synesis Admin API -- frontend not built"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)  # nosec B104
