from __future__ import annotations

import pytest
from app.routers.tokens import TokenCreate, _effective_tenant_ids
from pydantic import ValidationError


def test_token_create_rejects_malformed_tenant_id() -> None:
    with pytest.raises(ValidationError, match="tenant_id"):
        TokenCreate(name="coder", tenant_ids=["tenant-1\nrole=admin"])


def test_token_create_rejects_oversized_tenant_id_without_truncating() -> None:
    with pytest.raises(ValidationError, match="tenant_id"):
        TokenCreate(name="coder", tenant_ids=["t" * 65])


def test_token_create_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError, match="org_id"):
        TokenCreate(name="coder", org_id="org-admin")


def test_token_create_dedupes_valid_tenant_ids() -> None:
    body = TokenCreate(name="coder", tenant_ids=["tenant-1", "tenant-1", "tenant-2"])

    assert body.tenant_ids == ["tenant-1", "tenant-2"]


def test_effective_tenant_ids_drops_malformed_stored_values() -> None:
    assert _effective_tenant_ids(["tenant-1", "tenant-2\nrole=admin", "tenant-3"]) == ["tenant-1", "tenant-3"]
