"""Tests for deterministic active-org resolution in admin auth."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock, patch

import jwt
import pytest


def test_parse_org_claim_single_org():
    from app.auth import _parse_org_claim

    payload = {"organization": {"org-a": {"name": "Org A", "roles": ["member"]}}}
    org_id, org_name, org_roles = _parse_org_claim(payload)
    assert org_id == "org-a"
    assert org_name == "Org A"
    assert org_roles == ["member"]


def test_parse_org_claim_multi_org_requires_selection():
    from app.auth import _parse_org_claim

    payload = {
        "organization": {
            "org-a": {"name": "Org A", "roles": ["member"]},
            "org-b": {"name": "Org B", "roles": ["admin"]},
        }
    }
    with pytest.raises(jwt.InvalidTokenError):
        _parse_org_claim(payload)


def test_parse_org_claim_multi_org_with_requested_org():
    from app.auth import _parse_org_claim

    payload = {
        "organization": {
            "org-a": {"name": "Org A", "roles": ["member"]},
            "org-b": {"name": "Org B", "roles": ["admin"]},
        }
    }
    org_id, org_name, org_roles = _parse_org_claim(payload, requested_org_id="org-b")
    assert org_id == "org-b"
    assert org_name == "Org B"
    assert org_roles == ["admin"]


def test_parse_org_claim_rejects_malformed_requested_org():
    from app.auth import _parse_org_claim

    payload = {"organization": {"org-a": {"name": "Org A", "roles": ["member"]}}}
    with pytest.raises(jwt.InvalidTokenError, match="requested_org_id"):
        _parse_org_claim(payload, requested_org_id="org-a\nrole=admin")


def test_parse_org_claim_honors_active_org_claim():
    from app.auth import _parse_org_claim

    payload = {
        "active_org_id": "org-b",
        "organization": {
            "org-a": {"name": "Org A", "roles": ["member"]},
            "org-b": {"name": "Org B", "roles": ["admin"]},
        },
    }
    org_id, org_name, org_roles = _parse_org_claim(payload)
    assert org_id == "org-b"
    assert org_name == "Org B"
    assert org_roles == ["admin"]


def test_parse_org_claim_rejects_malformed_active_org_claim():
    from app.auth import _parse_org_claim

    payload = {
        "active_org_id": "org-b\nrole=admin",
        "organization": {
            "org-a": {"name": "Org A", "roles": ["member"]},
            "org-b": {"name": "Org B", "roles": ["admin"]},
        },
    }
    with pytest.raises(jwt.InvalidTokenError, match="active_org_id"):
        _parse_org_claim(payload)


@pytest.mark.parametrize("azp", [None, "another-client", ""])
def test_keycloak_token_requires_expected_authorized_party(azp):
    from app import auth

    payload = {"sub": "u1", "preferred_username": "user", "azp": azp}
    client = Mock()
    client.get_signing_key_from_jwt.return_value = SimpleNamespace(key="public-key")
    with (
        patch.object(auth, "_get_jwks_client", return_value=client),
        patch.object(auth.jwt, "decode", return_value=payload),
        pytest.raises(jwt.InvalidTokenError, match="not issued for Synesis Admin"),
    ):
        auth._verify_keycloak_token("token")


def test_keycloak_token_accepts_expected_authorized_party():
    from app import auth

    payload = {"sub": "u1", "preferred_username": "user", "azp": "synesis-admin"}
    client = Mock()
    client.get_signing_key_from_jwt.return_value = SimpleNamespace(key="public-key")
    with (
        patch.object(auth, "_get_jwks_client", return_value=client),
        patch.object(auth.jwt, "decode", return_value=payload),
    ):
        user = auth._verify_keycloak_token("token")
    assert user.user_id == "u1"


def test_configured_keycloak_audience_is_also_verified():
    from app import auth

    payload = {"sub": "u1", "azp": "synesis-admin"}
    client = Mock()
    client.get_signing_key_from_jwt.return_value = SimpleNamespace(key="public-key")
    decode = Mock(return_value=payload)
    with (
        patch.object(auth, "KEYCLOAK_AUDIENCE", "synesis-admin-api"),
        patch.object(auth, "_get_jwks_client", return_value=client),
        patch.object(auth.jwt, "decode", decode),
    ):
        auth._verify_keycloak_token("token")
    assert decode.call_args.kwargs["audience"] == "synesis-admin-api"
    assert decode.call_args.kwargs["options"] == {"verify_aud": True}
