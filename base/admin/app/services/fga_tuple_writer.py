"""OpenFGA tuple writer — manages relationship tuples on lifecycle events.

Called by admin API on PAT create/revoke, org membership changes, feature
flag updates, and tool policy changes. Also provides a backfill function
for bootstrapping tuples from existing DB state.
"""

from __future__ import annotations

import logging
from typing import Any

from ..token_scopes import has_token_scope
from .authz_engine import _get_fga_client
from .fga_contract import fga_object, fga_subject, fga_tuple_key, fga_user_for_id

logger = logging.getLogger("synesis.admin.fga_tuple_writer")


async def _write_tuples(writes: list[dict[str, str]]) -> bool:
    try:
        safe_writes = [fga_tuple_key(w["user"], w["relation"], w["object"]) for w in writes]
    except (KeyError, ValueError):
        logger.warning("fga_tuple_write_rejected_invalid_tuple")
        return False
    client = _get_fga_client()
    if client is None:
        logger.warning("fga_tuple_write_skipped: client not configured")
        return False
    try:
        from openfga_sdk import ClientTupleKey, ClientWriteRequest

        body = ClientWriteRequest(
            writes=[ClientTupleKey(user=w["user"], relation=w["relation"], object=w["object"]) for w in safe_writes]
        )
        await client.write(body)
        return True
    except Exception:
        logger.exception("fga_tuple_write_failed")
        return False


async def _delete_tuples(deletes: list[dict[str, str]]) -> bool:
    try:
        safe_deletes = [fga_tuple_key(d["user"], d["relation"], d["object"]) for d in deletes]
    except (KeyError, ValueError):
        logger.warning("fga_tuple_delete_rejected_invalid_tuple")
        return False
    client = _get_fga_client()
    if client is None:
        return False
    try:
        from openfga_sdk import ClientTupleKeyWithoutCondition, ClientWriteRequest

        body = ClientWriteRequest(
            deletes=[
                ClientTupleKeyWithoutCondition(user=d["user"], relation=d["relation"], object=d["object"])
                for d in safe_deletes
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
    try:
        fga_user = fga_user_for_id(user_id)
    except ValueError:
        logger.warning("fga_tuple_write_skipped_invalid_user_id")
        return
    writes: list[dict[str, str]] = []

    has_model_scope = not scopes or has_token_scope(scopes, "model")
    has_coder_scope = not scopes or has_token_scope(scopes, "coder")

    if has_model_scope:
        writes.append({"user": fga_user, "relation": "can_invoke", "object": "planner_endpoint:chat_completions"})
        writes.append({"user": fga_user, "relation": "can_read_public", "object": "rag_catalog:default"})

    if has_coder_scope:
        writes.append({"user": fga_user, "relation": "can_invoke", "object": "yarn_endpoint:completions"})
        writes.append({"user": fga_user, "relation": "can_invoke", "object": "yarn_endpoint:messages"})

    safe_org_id = ""
    if org_id:
        try:
            safe_org_id = fga_object("org", org_id).split(":", 1)[1]
        except ValueError:
            logger.warning("fga_tuple_write_skipped_invalid_org_id")

    if safe_org_id:
        writes.append({"user": fga_user, "relation": "member", "object": fga_object("org", safe_org_id)})
        if role in ("admin", "org_admin"):
            writes.append({"user": fga_user, "relation": "admin", "object": fga_object("org", safe_org_id)})
        writes.append(
            {
                "user": fga_subject(f"org:{safe_org_id}#member"),
                "relation": "can_read_org",
                "object": "rag_catalog:default",
            }
        )

    for tid in tenant_ids or []:
        try:
            tenant_id = fga_object("tenant", tid).split(":", 1)[1]
        except ValueError:
            logger.warning("fga_tuple_write_skipped_invalid_tenant_id")
            continue
        writes.append({"user": fga_user, "relation": "member", "object": fga_object("tenant", tenant_id)})

    if role in ("platform_admin", "admin"):
        writes.append({"user": fga_user, "relation": "admin", "object": "platform:synesis"})

    if writes:
        await _write_tuples(writes)


async def on_pat_revoked(user_id: str) -> None:
    """Delete user-direct tuples when a PAT is revoked.

    Org/tenant membership tuples are left intact since the user may have
    other active tokens or a Keycloak session.
    """
    try:
        fga_user = fga_user_for_id(user_id)
    except ValueError:
        logger.warning("fga_tuple_delete_skipped_invalid_user_id")
        return
    deletes = [
        {"user": fga_user, "relation": "can_invoke", "object": "planner_endpoint:chat_completions"},
        {"user": fga_user, "relation": "can_invoke", "object": "yarn_endpoint:completions"},
        {"user": fga_user, "relation": "can_invoke", "object": "yarn_endpoint:messages"},
        {"user": fga_user, "relation": "can_read_public", "object": "rag_catalog:default"},
    ]
    await _delete_tuples(deletes)


async def on_org_member_added(user_id: str, org_id: str, is_admin: bool = False) -> None:
    try:
        fga_user = fga_user_for_id(user_id)
        org_object = fga_object("org", org_id)
        org_member = fga_subject(f"{org_object}#member")
    except ValueError:
        logger.warning("fga_tuple_write_skipped_invalid_org_membership")
        return
    writes = [{"user": fga_user, "relation": "member", "object": org_object}]
    if is_admin:
        writes.append({"user": fga_user, "relation": "admin", "object": org_object})
    writes.append({"user": org_member, "relation": "can_read_org", "object": "rag_catalog:default"})
    await _write_tuples(writes)


async def on_org_member_removed(user_id: str, org_id: str) -> None:
    try:
        fga_user = fga_user_for_id(user_id)
        org_object = fga_object("org", org_id)
    except ValueError:
        logger.warning("fga_tuple_delete_skipped_invalid_org_membership")
        return
    deletes = [
        {"user": fga_user, "relation": "member", "object": org_object},
        {"user": fga_user, "relation": "admin", "object": org_object},
    ]
    await _delete_tuples(deletes)


async def on_platform_admin_granted(user_id: str) -> None:
    try:
        fga_user = fga_user_for_id(user_id)
    except ValueError:
        logger.warning("fga_tuple_write_skipped_invalid_user_id")
        return
    await _write_tuples([{"user": fga_user, "relation": "admin", "object": "platform:synesis"}])


async def on_feature_enabled(user_or_userset: str, feature_id: str) -> None:
    try:
        tuple_key = fga_tuple_key(user_or_userset, "enabled", fga_object("feature", feature_id))
    except ValueError:
        logger.warning("fga_tuple_write_skipped_invalid_feature_tuple")
        return
    await _write_tuples([tuple_key])


async def on_feature_blocked(user_id: str, feature_id: str) -> None:
    try:
        tuple_key = fga_tuple_key(fga_user_for_id(user_id), "blocked", fga_object("feature", feature_id))
    except ValueError:
        logger.warning("fga_tuple_write_skipped_invalid_feature_tuple")
        return
    await _write_tuples([tuple_key])


async def on_tool_blocked(user_id: str, tool_id: str) -> None:
    try:
        tuple_key = fga_tuple_key(fga_user_for_id(user_id), "blocked", fga_object("tool", tool_id))
    except ValueError:
        logger.warning("fga_tuple_write_skipped_invalid_tool_tuple")
        return
    await _write_tuples([tuple_key])


async def on_platform_tool_blocked(tool_id: str) -> None:
    """Block a tool at the platform level (global abuse vector)."""
    try:
        tuple_key = fga_tuple_key(fga_object("tool", tool_id), "blocked_tool", "platform_policy:default")
    except ValueError:
        logger.warning("fga_tuple_write_skipped_invalid_platform_tool_tuple")
        return
    await _write_tuples([tuple_key])


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
