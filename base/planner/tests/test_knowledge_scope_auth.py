from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.routers.knowledge import (
    KnowledgeSearchRequest,
    KnowledgeSubmitRequest,
    knowledge_search,
    knowledge_submit,
)


@pytest.mark.asyncio
async def test_knowledge_search_uses_authenticated_scope() -> None:
    req = KnowledgeSearchRequest(query="python", top_k=3)
    with (
        patch("app.routers.knowledge.build_metadata_filter", return_value='org_id == "org-1"') as mock_filter,
        patch("app.routers.knowledge.retrieve_multi_query_fused", new=AsyncMock(return_value=[])),
    ):
        out = await knowledge_search(req, scope=("org-1", ["tenant-a"]))
    assert out["count"] == 0
    kwargs = mock_filter.call_args.kwargs
    assert kwargs["caller_org_id"] == "org-1"
    assert kwargs["caller_tenant_ids"] == ["tenant-a"]


@pytest.mark.asyncio
async def test_knowledge_submit_org_scope_requires_org_context() -> None:
    req = KnowledgeSubmitRequest(
        domain="python",
        content="hello",
        visibility_scope="org",
    )
    with pytest.raises(HTTPException) as exc_info:
        await knowledge_submit(req, scope=("", []))
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_knowledge_submit_tenant_scope_enforces_membership() -> None:
    req = KnowledgeSubmitRequest(
        domain="python",
        content="hello",
        visibility_scope="tenant",
        tenant_id="tenant-z",
    )
    with pytest.raises(HTTPException) as exc_info:
        await knowledge_submit(req, scope=("org-1", ["tenant-a", "tenant-b"]))
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_knowledge_submit_applies_resolved_scope() -> None:
    req = KnowledgeSubmitRequest(
        domain="python",
        content="hello",
        visibility_scope="tenant",
        tenant_id="tenant-a",
    )
    with patch("app.routers.knowledge.submit_user_knowledge", new=AsyncMock(return_value="chunk-1")) as mock_submit:
        out = await knowledge_submit(req, scope=("org-1", ["tenant-a"]))
    assert out["status"] == "ingested"
    kwargs = mock_submit.await_args.kwargs
    assert kwargs["org_id"] == "org-1"
    assert kwargs["tenant_id"] == "tenant-a"
