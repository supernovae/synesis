"""Authorization policy dashboard — OpenFGA tuple management, check debugger, status."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..auth import UserInfo
from ..rbac import require_platform_admin
from ..services.fga_contract import (
    fga_object,
    fga_relation,
    fga_subject,
    fga_tuple_key,
    fga_user_for_id,
    parse_fga_object,
)

logger = logging.getLogger("synesis.admin.authz")

router = APIRouter(prefix="/api/v1/authz", tags=["authz"])


# ── Models ────────────────────────────────────────────────────────────────────


class TupleWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    user: str = Field(..., min_length=1, max_length=320, description="e.g. user:alice or org:acme#member")
    relation: str = Field(..., min_length=1, max_length=64)
    object: str = Field(..., min_length=1, max_length=320, description="e.g. planner_endpoint:chat_completions")

    @field_validator("user", mode="after")
    @classmethod
    def validate_user(cls, value: str) -> str:
        return fga_subject(value)

    @field_validator("relation", mode="after")
    @classmethod
    def validate_relation(cls, value: str) -> str:
        return fga_relation(value)

    @field_validator("object", mode="after")
    @classmethod
    def validate_object(cls, value: str) -> str:
        return fga_object(*parse_fga_object(value))


class CheckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    user: str = Field(..., min_length=1, max_length=320)
    relation: str = Field(..., min_length=1, max_length=64)
    object: str = Field(..., min_length=1, max_length=320)

    @field_validator("user", mode="after")
    @classmethod
    def validate_user(cls, value: str) -> str:
        return fga_subject(value)

    @field_validator("relation", mode="after")
    @classmethod
    def validate_relation(cls, value: str) -> str:
        return fga_relation(value)

    @field_validator("object", mode="after")
    @classmethod
    def validate_object(cls, value: str) -> str:
        return fga_object(*parse_fga_object(value))


# ── Status ────────────────────────────────────────────────────────────────────


@router.get("/status")
async def authz_status(_admin: UserInfo = Depends(require_platform_admin)):
    """OpenFGA connection status, store info, and engine statistics."""
    from ..services.authz_engine import _get_fga_client, create_authz_engine

    engine = create_authz_engine()
    stats = engine.get_stats()
    client = _get_fga_client()

    store_info = None
    model_info = None
    if client:
        try:
            models_resp = await client.read_authorization_models({"page_size": 1})
            models = getattr(models_resp, "authorization_models", []) or []
            if models:
                m = models[0]
                model_info = {
                    "id": getattr(m, "id", ""),
                    "type_definitions_count": len(getattr(m, "type_definitions", []) or []),
                }
            import os

            store_info = {
                "store_id": os.getenv("SYNESIS_OPENFGA_STORE_ID", ""),
                "api_url": os.getenv("SYNESIS_OPENFGA_API_URL", ""),
            }
        except Exception as exc:
            logger.debug("authz_status_model_fetch_failed: %s", exc)

    return {
        **stats,
        "store": store_info,
        "latest_model": model_info,
    }


# ── Tuple management ─────────────────────────────────────────────────────────


@router.get("/tuples")
async def list_tuples(
    user: str = Query("", max_length=320),
    relation: str = Query("", max_length=64),
    object: str = Query("", max_length=320),
    _admin: UserInfo = Depends(require_platform_admin),
):
    """List tuples matching the optional filter (user, relation, object)."""
    from ..services.authz_engine import _get_fga_client

    client = _get_fga_client()
    if not client:
        raise HTTPException(status_code=503, detail="OpenFGA not configured")
    try:
        user = fga_subject(user) if user else ""
        relation = fga_relation(relation) if relation else ""
        object = fga_object(*parse_fga_object(object)) if object else ""
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        from openfga_sdk import ClientReadRequest

        body = ClientReadRequest()
        fga_tuple_key = {}
        if user:
            fga_tuple_key["user"] = user
        if relation:
            fga_tuple_key["relation"] = relation
        if object:
            fga_tuple_key["object"] = object
        if fga_tuple_key:
            from openfga_sdk import ReadRequestTupleKey

            body = ClientReadRequest(tuple_key=ReadRequestTupleKey(**fga_tuple_key))

        response = await client.read(body)
        tuples_raw = getattr(response, "tuples", []) or []
        result = []
        for t in tuples_raw:
            key = getattr(t, "key", t)
            result.append(
                {
                    "user": getattr(key, "user", ""),
                    "relation": getattr(key, "relation", ""),
                    "object": getattr(key, "object", ""),
                    "timestamp": str(getattr(t, "timestamp", "")),
                }
            )
        return {"tuples": result, "count": len(result)}
    except Exception as exc:
        logger.exception("authz_tuple_list_failed")
        raise HTTPException(status_code=500, detail=f"Failed to read tuples: {exc}") from exc


@router.post("/tuples", status_code=201)
async def write_tuple(
    body: TupleWrite,
    _admin: UserInfo = Depends(require_platform_admin),
):
    """Write a single tuple."""
    from ..services.admin_audit import record_admin_audit
    from ..services.fga_tuple_writer import _write_tuples

    ok = await _write_tuples([fga_tuple_key(body.user, body.relation, body.object)])
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to write tuple")
    await record_admin_audit(
        action="authz.tuple.write",
        status="success",
        summary=f"Wrote tuple: {body.user} #{body.relation} {body.object}",
        detail=body.model_dump(),
        user=_admin,
    )
    return {"ok": True}


@router.delete("/tuples")
async def delete_tuple(
    body: TupleWrite,
    _admin: UserInfo = Depends(require_platform_admin),
):
    """Delete a single tuple."""
    from ..services.admin_audit import record_admin_audit
    from ..services.fga_tuple_writer import _delete_tuples

    ok = await _delete_tuples([fga_tuple_key(body.user, body.relation, body.object)])
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to delete tuple")
    await record_admin_audit(
        action="authz.tuple.delete",
        status="success",
        summary=f"Deleted tuple: {body.user} #{body.relation} {body.object}",
        detail=body.model_dump(),
        user=_admin,
    )
    return {"ok": True}


# ── Check debugger ────────────────────────────────────────────────────────────


@router.post("/check")
async def run_check(
    body: CheckRequest,
    _admin: UserInfo = Depends(require_platform_admin),
):
    """Run an authorization check and return the result (debug tool)."""
    from ..services.authz_engine import fga_check

    object_type, object_id = parse_fga_object(body.object)
    allowed = await fga_check(body.user, body.relation, object_type, object_id)
    return {
        "user": body.user,
        "relation": body.relation,
        "object": body.object,
        "allowed": allowed,
    }


# ── User permissions summary ──────────────────────────────────────────────────


@router.get("/user-permissions/{user_id}")
async def user_permissions(
    user_id: str = Path(..., min_length=1, max_length=256),
    _admin: UserInfo = Depends(require_platform_admin),
):
    """Fetch the effective FGA permissions picture for a user.

    Reads all tuples where the user is the subject, and probes key relations.
    """
    from ..services.authz_engine import _get_fga_client, fga_check

    try:
        fga_user = fga_user_for_id(user_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    client = _get_fga_client()

    tuples = []
    if client:
        try:
            from openfga_sdk import ClientReadRequest, ReadRequestTupleKey

            body = ClientReadRequest(tuple_key=ReadRequestTupleKey(user=fga_user))
            response = await client.read(body)
            for t in getattr(response, "tuples", []) or []:
                key = getattr(t, "key", t)
                tuples.append(
                    {
                        "user": getattr(key, "user", ""),
                        "relation": getattr(key, "relation", ""),
                        "object": getattr(key, "object", ""),
                    }
                )
        except Exception:
            logger.debug("user_permissions_tuple_read_failed", exc_info=True)

    probes = [
        ("can_invoke", "planner_endpoint", "chat_completions"),
        ("can_invoke", "yarn_endpoint", "completions"),
        ("can_invoke", "yarn_endpoint", "messages"),
        ("can_read_public", "rag_catalog", "default"),
        ("admin", "platform", "synesis"),
    ]
    checks = {}
    for relation, obj_type, obj_id in probes:
        allowed = await fga_check(fga_user, relation, obj_type, obj_id)
        checks[f"{obj_type}:{obj_id}#{relation}"] = allowed

    return {
        "user_id": user_id,
        "fga_user": fga_user,
        "direct_tuples": tuples,
        "computed_checks": checks,
    }


# ── Schema types ──────────────────────────────────────────────────────────────


@router.get("/schema-types")
async def schema_types(_admin: UserInfo = Depends(require_platform_admin)):
    """Return the type definitions from the current authorization model."""
    from ..services.authz_engine import _get_fga_client

    client = _get_fga_client()
    if not client:
        raise HTTPException(status_code=503, detail="OpenFGA not configured")

    try:
        models_resp = await client.read_authorization_models({"page_size": 1})
        models = getattr(models_resp, "authorization_models", []) or []
        if not models:
            return {"types": [], "model_id": None}
        model = models[0]
        type_defs = []
        for td in getattr(model, "type_definitions", []) or []:
            relations = {}
            meta = getattr(td, "metadata", None)
            rel_meta = getattr(meta, "relations", {}) if meta else {}
            for rname in getattr(td, "relations", {}) or {}:
                relations[rname] = {
                    "directly_related": list(
                        str(getattr(rt, "type", ""))
                        + (f"#{getattr(rt, 'relation', '')}" if getattr(rt, "relation", "") else "")
                        for rt in (getattr(rel_meta.get(rname), "directly_related_user_types", []) or [])
                    )
                    if rel_meta.get(rname)
                    else []
                }
            type_defs.append({"type": getattr(td, "type", ""), "relations": relations})
        return {"types": type_defs, "model_id": getattr(model, "id", "")}
    except Exception as exc:
        logger.exception("authz_schema_types_failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
