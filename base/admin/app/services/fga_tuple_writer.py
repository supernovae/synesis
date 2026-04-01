"""OpenFGA tuple writer — manages relationship tuples on lifecycle events.

Called by admin API on PAT create/revoke, org membership changes, feature
flag updates, and tool policy changes. Also provides a backfill function
for bootstrapping tuples from existing DB state.
"""

from __future__ import annotations

import logging
from typing import Any

from .authz_engine import _get_fga_client

logger = logging.getLogger("synesis.admin.fga_tuple_writer")


async def _write_tuples(writes: list[dict[str, str]]) -> bool:
    client = _get_fga_client()
    if client is None:
        logger.warning("fga_tuple_write_skipped: client not configured")
        return False
    try:
        from openfga_sdk import ClientTupleKey, ClientWriteRequest

        body = ClientWriteRequest(
            writes=[ClientTupleKey(user=w["user"], relation=w["relation"], object=w["object"]) for w in writes]
        )
        await client.write(body)
        return True
    except Exception:
        logger.exception("fga_tuple_write_failed")
        return False


async def _delete_tuples(deletes: list[dict[str, str]]) -> bool:
    client = _get_fga_client()
    if client is None:
        return False
    try:
        from openfga_sdk import ClientTupleKeyWithoutCondition, ClientWriteRequest

        body = ClientWriteRequest(
            deletes=[
                ClientTupleKeyWithoutCondition(user=d["user"], relation=d["relation"], object=d["object"])
                for d in deletes
            ]
        )
        await client.write(body)
        return True
    except Exception:
        logger.exception("fga_tuple_delete_failed")
        return False


async def on_pat_created(
    user_id: str,
    org_id: str = "",
    tenant_ids: list[str] | None = None,
    role: str = "user",
    scopes: list[str] | None = None,
) -> None:
    """Write tuples when a new PAT is created."""
    fga_user = f"user:{user_id}"
    writes: list[dict[str, str]] = []

    has_model_scope = not scopes or any(s.startswith("model") for s in scopes)
    has_coder_scope = not scopes or any(s.startswith("coder") for s in scopes)

    if has_model_scope:
        writes.append({"user": fga_user, "relation": "can_invoke", "object": "planner_endpoint:chat_completions"})
        writes.append({"user": fga_user, "relation": "can_read_public", "object": "rag_catalog:default"})

    if has_coder_scope:
        writes.append({"user": fga_user, "relation": "can_invoke", "object": "yarn_endpoint:completions"})
        writes.append({"user": fga_user, "relation": "can_invoke", "object": "yarn_endpoint:messages"})

    if org_id:
        writes.append({"user": fga_user, "relation": "member", "object": f"org:{org_id}"})
        if role in ("admin", "org_admin"):
            writes.append({"user": fga_user, "relation": "admin", "object": f"org:{org_id}"})
        writes.append({"user": f"org:{org_id}#member", "relation": "can_read_org", "object": "rag_catalog:default"})

    for tid in tenant_ids or []:
        writes.append({"user": fga_user, "relation": "member", "object": f"tenant:{tid}"})

    if role in ("platform_admin", "admin"):
        writes.append({"user": fga_user, "relation": "admin", "object": "platform:synesis"})

    if writes:
        await _write_tuples(writes)


async def on_pat_revoked(user_id: str) -> None:
    """Delete user-direct tuples when a PAT is revoked.

    Org/tenant membership tuples are left intact since the user may have
    other active tokens or a Keycloak session.
    """
    fga_user = f"user:{user_id}"
    deletes = [
        {"user": fga_user, "relation": "can_invoke", "object": "planner_endpoint:chat_completions"},
        {"user": fga_user, "relation": "can_invoke", "object": "yarn_endpoint:completions"},
        {"user": fga_user, "relation": "can_invoke", "object": "yarn_endpoint:messages"},
        {"user": fga_user, "relation": "can_read_public", "object": "rag_catalog:default"},
    ]
    await _delete_tuples(deletes)


async def on_org_member_added(user_id: str, org_id: str, is_admin: bool = False) -> None:
    fga_user = f"user:{user_id}"
    writes = [{"user": fga_user, "relation": "member", "object": f"org:{org_id}"}]
    if is_admin:
        writes.append({"user": fga_user, "relation": "admin", "object": f"org:{org_id}"})
    writes.append({"user": f"org:{org_id}#member", "relation": "can_read_org", "object": "rag_catalog:default"})
    await _write_tuples(writes)


async def on_org_member_removed(user_id: str, org_id: str) -> None:
    fga_user = f"user:{user_id}"
    deletes = [
        {"user": fga_user, "relation": "member", "object": f"org:{org_id}"},
        {"user": fga_user, "relation": "admin", "object": f"org:{org_id}"},
    ]
    await _delete_tuples(deletes)


async def on_platform_admin_granted(user_id: str) -> None:
    await _write_tuples([{"user": f"user:{user_id}", "relation": "admin", "object": "platform:synesis"}])


async def on_feature_enabled(user_or_userset: str, feature_id: str) -> None:
    await _write_tuples([{"user": user_or_userset, "relation": "enabled", "object": f"feature:{feature_id}"}])


async def on_feature_blocked(user_id: str, feature_id: str) -> None:
    await _write_tuples([{"user": f"user:{user_id}", "relation": "blocked", "object": f"feature:{feature_id}"}])


async def on_tool_blocked(user_id: str, tool_id: str) -> None:
    await _write_tuples([{"user": f"user:{user_id}", "relation": "blocked", "object": f"tool:{tool_id}"}])


async def on_platform_tool_blocked(tool_id: str) -> None:
    """Block a tool at the platform level (global abuse vector)."""
    await _write_tuples([{"user": f"tool:{tool_id}", "relation": "blocked_tool", "object": "platform_policy:default"}])


async def backfill_from_db(db_session: Any) -> dict[str, int]:
    """Backfill tuples from existing personal_access_tokens rows.

    Run once after initial OpenFGA deployment to sync DB state.
    Returns counts of tuples written.
    """
    from sqlalchemy import select

    from ..db.models import PersonalAccessToken

    stmt = select(PersonalAccessToken).where(PersonalAccessToken.revoked == False)
    result = await db_session.execute(stmt)
    tokens = result.scalars().all()

    written = 0
    for token in tokens:
        await on_pat_created(
            user_id=token.user_id,
            org_id=token.org_id or "",
            tenant_ids=list(token.tenant_ids or []),
            role=token.role or "user",
            scopes=list(token.scopes or []),
        )
        written += 1

    return {"tokens_processed": written}
