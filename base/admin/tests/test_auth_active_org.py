"""Tests for deterministic active-org resolution in admin auth."""

from __future__ import annotations

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
