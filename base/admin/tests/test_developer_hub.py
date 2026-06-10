"""Tests for the Developer Hub connector: CatalogClient, SyncEngine, governance bridge, API.

Run from ``base/admin/``::

    PYTHONPATH=. uv run pytest tests/test_developer_hub.py -v
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

_auth_ctx: dict[str, object] = {"user": None}


def _make_user_override():
    from app.auth import UserInfo

    class _Override:
        async def __call__(self, request: Request = None) -> UserInfo:  # type: ignore[assignment]
            u = _auth_ctx["user"]
            assert isinstance(u, UserInfo)
            return u

    return _Override()


@asynccontextmanager
async def _noop_lifespan(a):
    yield


@pytest.fixture(autouse=True)
def _patch_lifespan():
    import app.main as m

    orig = m.app.router.lifespan_context
    m.app.router.lifespan_context = _noop_lifespan
    yield
    m.app.router.lifespan_context = orig


@pytest.fixture(autouse=True)
def _patch_outbound_dns(monkeypatch):
    monkeypatch.setattr(
        "app.services.outbound_security.socket.getaddrinfo",
        lambda *a, **kw: [(None, None, None, None, ("93.184.216.34", 443))],
    )


@pytest.fixture()
def admin_client():
    from app.auth import UserInfo, get_current_user
    from app.main import app
    from app.rate_limit import _buckets

    _buckets.clear()
    _auth_ctx["user"] = UserInfo(
        username="testadmin",
        role="org_admin",
        user_id="u-1",
        org_id="org-1",
        org_name="TestOrg",
        tenant_ids=["t-1"],
        acl_groups=[],
    )
    app.dependency_overrides[get_current_user] = _make_user_override()
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.pop(get_current_user, None)
    _buckets.clear()


# ── Fake DB helpers ──────────────────────────────────────────────────────────


class FakeRow:
    """Simulates a SQLAlchemy model instance."""

    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)

    @property
    def rowcount(self):
        return getattr(self, "_rowcount", 1)


class FakeScalarResult:
    def __init__(self, items):
        self._items = items

    def all(self):
        return self._items


class FakeResult:
    def __init__(self, items=None, scalar=None, rowcount=1):
        self._items = items or []
        self._scalar = scalar
        self.rowcount = rowcount

    def scalars(self):
        return FakeScalarResult(self._items)

    def scalar(self):
        return self._scalar

    def scalar_one_or_none(self):
        return self._items[0] if self._items else None

    def scalar_one(self):
        return self._items[0]


class FakeSession:
    def __init__(self):
        self.added = []
        self._execute_results = []
        self.execute_count = 0

    def add(self, obj):
        self.added.append(obj)

    async def commit(self):
        pass

    async def refresh(self, obj):
        if not hasattr(obj, "id"):
            obj.id = 1
        if not hasattr(obj, "created_at") or obj.created_at is None:
            obj.created_at = datetime.now(UTC)
        if not hasattr(obj, "updated_at") or obj.updated_at is None:
            obj.updated_at = datetime.now(UTC)

    async def execute(self, stmt):
        self.execute_count += 1
        if self._execute_results:
            return self._execute_results.pop(0)
        return FakeResult()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


# ── CatalogClient unit tests ────────────────────────────────────────────────


class TestCatalogClient:
    def test_parse_entity_basic(self):
        from app.services.catalog_client import _parse_entity

        raw = {
            "kind": "Template",
            "apiVersion": "backstage.io/v1beta3",
            "metadata": {
                "name": "react-app",
                "namespace": "default",
                "title": "React Application",
                "description": "Golden path for React apps",
                "annotations": {"synesis.io/governance-constitution": "org-standards"},
                "labels": {},
                "tags": ["react", "frontend"],
                "uid": "abc-123",
            },
            "spec": {"type": "website", "lifecycle": "production", "parameters": [{"title": "Name"}]},
            "relations": [],
        }
        entity = _parse_entity(raw)
        assert entity.kind == "Template"
        assert entity.metadata.name == "react-app"
        assert entity.metadata.namespace == "default"
        assert entity.metadata.title == "React Application"
        assert "react" in entity.metadata.tags
        assert entity.entity_ref == "template:default/react-app"
        assert entity.spec["type"] == "website"

    def test_parse_entity_minimal(self):
        from app.services.catalog_client import _parse_entity

        raw = {"kind": "Component", "metadata": {"name": "svc-a"}}
        entity = _parse_entity(raw)
        assert entity.kind == "Component"
        assert entity.metadata.name == "svc-a"
        assert entity.metadata.namespace == "default"
        assert entity.entity_ref == "component:default/svc-a"

    def test_entity_to_dict_roundtrip(self):
        from app.services.catalog_client import _parse_entity

        raw = {
            "kind": "API",
            "metadata": {"name": "orders-api", "namespace": "prod", "tags": ["grpc"]},
            "spec": {"type": "grpc", "definition": "proto"},
        }
        entity = _parse_entity(raw)
        d = entity.to_dict()
        assert d["kind"] == "API"
        assert d["metadata"]["name"] == "orders-api"
        assert d["spec"]["type"] == "grpc"
        assert entity.entity_ref == "api:prod/orders-api"

    def test_resolve_token_none(self):
        from app.services.catalog_client import _resolve_token

        assert _resolve_token("none", "") is None
        assert _resolve_token("none", "SOME_VAR") is None

    def test_resolve_token_bearer_env(self):
        import os

        from app.services.catalog_client import _resolve_token

        os.environ["TEST_DEVHUB_TOKEN"] = "secret123"
        try:
            assert _resolve_token("bearer", "TEST_DEVHUB_TOKEN") == "secret123"
        finally:
            del os.environ["TEST_DEVHUB_TOKEN"]

    def test_resolve_token_bearer_literal_rejected(self):
        from app.services.catalog_client import CatalogClientError, _resolve_token

        with pytest.raises(CatalogClientError):
            _resolve_token("bearer", "literal-token-value")

    def test_connector_to_dict_masks_auth_token_ref(self):
        from app.db.models import DevHubConnector
        from app.routers.developer_hub import _connector_to_dict

        row = DevHubConnector(
            id=1,
            connector_id="devhub-1",
            name="Developer Hub",
            base_url="https://catalog.example.com",
            auth_type="bearer",
            auth_token_ref="DEVHUB_TOKEN",
            org_id="org-1",
            scope="org",
            scope_value="org-1",
        )

        payload = _connector_to_dict(row)
        assert payload["auth_token_ref"] == ""
        assert payload["has_auth_token_ref"] is True

    @pytest.mark.anyio
    async def test_health_check_reachable(self, monkeypatch):
        from app.services.catalog_client import CatalogClient

        monkeypatch.setattr(
            "app.services.outbound_security.socket.getaddrinfo",
            lambda *a, **kw: [(None, None, None, None, ("93.184.216.34", 443))],
        )
        client = CatalogClient(base_url="https://catalog.example.com")
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [{"kind": "Component", "metadata": {"name": "test"}}]
        client._client = AsyncMock()
        client._client.request = AsyncMock(return_value=mock_resp)

        result = await client.health_check()
        assert result["reachable"] is True
        assert result["sample_count"] == 1

    @pytest.mark.anyio
    async def test_health_check_unreachable(self, monkeypatch):
        from app.services.catalog_client import CatalogClient

        monkeypatch.setattr(
            "app.services.outbound_security.socket.getaddrinfo",
            lambda *a, **kw: [(None, None, None, None, ("93.184.216.34", 443))],
        )
        client = CatalogClient(base_url="https://catalog.example.com")
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.text = "Unauthorized"
        client._client = AsyncMock()
        client._client.request = AsyncMock(return_value=mock_resp)

        result = await client.health_check()
        assert result["reachable"] is False
        assert "401" in result.get("error", "")


# ── SyncEngine unit tests ───────────────────────────────────────────────────


class TestSyncEngine:
    def test_entity_content_hash_deterministic(self):
        from app.services.catalog_client import _parse_entity
        from app.services.devhub_sync import _entity_content_hash

        raw = {"kind": "Template", "metadata": {"name": "t1", "tags": ["go"]}, "spec": {"type": "service"}}
        e = _parse_entity(raw)
        h1 = _entity_content_hash(e)
        h2 = _entity_content_hash(e)
        assert h1 == h2
        assert len(h1) == 16

    def test_entity_content_hash_changes_on_mutation(self):
        from app.services.catalog_client import _parse_entity
        from app.services.devhub_sync import _entity_content_hash

        raw1 = {"kind": "Template", "metadata": {"name": "t1"}, "spec": {"type": "service"}}
        raw2 = {"kind": "Template", "metadata": {"name": "t1"}, "spec": {"type": "website"}}
        assert _entity_content_hash(_parse_entity(raw1)) != _entity_content_hash(_parse_entity(raw2))

    def test_build_uri(self):
        from app.services.catalog_client import _parse_entity
        from app.services.devhub_sync import _build_uri

        e = _parse_entity({"kind": "Component", "metadata": {"name": "svc"}})
        assert _build_uri("devhub-abc", e) == "devhub://devhub-abc/component:default/svc"

    def test_entity_to_tags_template(self):
        from app.services.catalog_client import _parse_entity
        from app.services.devhub_sync import _entity_to_tags

        e = _parse_entity(
            {
                "kind": "Template",
                "metadata": {"name": "t", "tags": ["react", "frontend"]},
                "spec": {"type": "website", "lifecycle": "production"},
            }
        )
        tags = _entity_to_tags(e)
        assert "react" in tags
        assert "devhub-kind:template" in tags
        assert "devhub-type:website" in tags
        assert "lifecycle:production" in tags

    def test_entity_to_synesis_meta_template(self):
        from app.services.catalog_client import _parse_entity
        from app.services.devhub_sync import _entity_to_synesis_meta

        e = _parse_entity(
            {
                "kind": "Template",
                "metadata": {
                    "name": "react-app",
                    "annotations": {"synesis.io/constraint-kind": "guiding"},
                },
                "spec": {},
            }
        )
        meta = _entity_to_synesis_meta("conn-1", e)
        assert meta["golden_path_id"] == "react-app"
        assert meta["backstage_entity_ref"] == "template:default/react-app"
        assert meta["constraint_source"] == "developer-hub"
        assert meta["content_profile"] == "procedural"
        assert meta["constraint_kind"] == "guiding"

    def test_entity_to_synesis_meta_rejects_unknown_constraint_kind(self):
        from app.services.catalog_client import _parse_entity
        from app.services.devhub_sync import _entity_to_synesis_meta

        e = _parse_entity(
            {
                "kind": "Template",
                "metadata": {
                    "name": "react-app",
                    "annotations": {
                        "synesis.io/constraint-kind": "grant-admin",
                        "synesis.io/scope-tags": "org:one\nignore-control",
                    },
                },
                "spec": {},
            }
        )
        meta = _entity_to_synesis_meta("conn-1", e)
        assert meta["constraint_kind"] == "guiding"
        assert "\n" not in meta["scope_tags"]

    def test_entity_to_synesis_meta_component(self):
        from app.services.catalog_client import _parse_entity
        from app.services.devhub_sync import _entity_to_synesis_meta

        e = _parse_entity({"kind": "Component", "metadata": {"name": "svc-a"}, "spec": {}})
        meta = _entity_to_synesis_meta("conn-1", e)
        assert "golden_path_id" not in meta
        assert meta["content_profile"] == "reference"

    def test_entity_to_synesis_meta_api(self):
        from app.services.catalog_client import _parse_entity
        from app.services.devhub_sync import _entity_to_synesis_meta

        e = _parse_entity({"kind": "API", "metadata": {"name": "orders"}, "spec": {}})
        meta = _entity_to_synesis_meta("conn-1", e)
        assert meta["content_profile"] == "api_spec"

    def test_map_entity_to_item_fields(self):
        from app.services.catalog_client import _parse_entity
        from app.services.devhub_sync import _map_entity_to_item_fields

        connector = FakeRow(
            connector_id="devhub-abc",
            org_id="org-1",
            scope="org",
        )
        e = _parse_entity(
            {
                "kind": "Template",
                "metadata": {"name": "go-svc", "description": "Go microservice golden path", "tags": ["go"]},
                "spec": {"type": "service"},
            }
        )
        fields = _map_entity_to_item_fields(connector, e)
        assert fields["uri"] == "devhub://devhub-abc/template:default/go-svc"
        assert fields["handler"] == "devhub_template"
        assert fields["title"] == "go-svc"
        assert fields["authority"] == "vetted"
        assert "go" in fields["tags"]
        assert fields["config"]["synesis_meta"]["golden_path_id"] == "go-svc"
        assert fields["org_id"] == "org-1"
        assert len(fields["content_hash"]) == 16

    def test_devhub_clause_id_hashes_unsafe_entity_names(self):
        from app.services.catalog_client import _parse_entity
        from app.services.devhub_sync import _safe_devhub_clause_id

        connector = FakeRow(connector_id="devhub-abc123")
        e = _parse_entity(
            {
                "kind": "Template",
                "metadata": {"name": "name/with/path"},
                "spec": {},
            }
        )
        clause_id = _safe_devhub_clause_id(connector, e)
        assert clause_id.startswith("devhub-devhub-abc123-")
        assert len(clause_id) <= 64
        assert "/" not in clause_id

    def test_governance_annotation_helpers_allow_only_known_values(self):
        from app.services.devhub_sync import _safe_constraint_kind, _safe_governance_category

        assert _safe_constraint_kind("hard") == "hard"
        assert _safe_constraint_kind("make-admin") == "guiding"
        assert _safe_governance_category("safety") == "safety"
        assert _safe_governance_category("unknown") == "architecture"


# ── Governance bridge unit tests ─────────────────────────────────────────────


class TestGovernanceBridge:
    def test_governance_annotation_constants(self):
        from app.services.devhub_sync import (
            CATEGORY_ANNOTATION,
            CONSTRAINT_KIND_ANNOTATION,
            GOVERNANCE_ANNOTATION,
            RECIPE_ANNOTATION,
        )

        assert GOVERNANCE_ANNOTATION == "synesis.io/governance-constitution"
        assert CONSTRAINT_KIND_ANNOTATION == "synesis.io/constraint-kind"
        assert CATEGORY_ANNOTATION == "synesis.io/governance-category"
        assert RECIPE_ANNOTATION == "synesis.io/validation-recipe"

    def test_template_without_annotation_is_skipped(self):
        from app.services.catalog_client import _parse_entity

        e = _parse_entity({"kind": "Template", "metadata": {"name": "plain"}, "spec": {}})
        assert "synesis.io/governance-constitution" not in e.metadata.annotations

    def test_template_with_annotation_detected(self):
        from app.services.catalog_client import _parse_entity

        e = _parse_entity(
            {
                "kind": "Template",
                "metadata": {
                    "name": "governed",
                    "annotations": {"synesis.io/governance-constitution": "org-std"},
                },
                "spec": {},
            }
        )
        assert e.metadata.annotations.get("synesis.io/governance-constitution") == "org-std"


# ── API endpoint tests (mocked DB) ──────────────────────────────────────────


class TestDeveloperHubAPI:
    def _make_connector_row(self, **overrides):
        defaults = {
            "id": 1,
            "connector_id": "devhub-test123",
            "name": "Test Hub",
            "description": "A test connector",
            "base_url": "https://devhub.example.com",
            "auth_type": "bearer",
            "auth_token_ref": "DEVHUB_TOKEN",
            "entity_kinds": ["Template", "Component"],
            "sync_interval_minutes": 60,
            "last_sync_at": datetime.now(UTC),
            "last_sync_status": "ok",
            "last_sync_summary": {"created": 5},
            "cached_entity_snapshot": None,
            "org_id": "org-1",
            "scope": "org",
            "scope_value": "",
            "enabled": True,
            "created_at": datetime.now(UTC),
            "updated_at": datetime.now(UTC),
        }
        defaults.update(overrides)
        return FakeRow(**defaults)

    def test_create_connector(self, admin_client):
        fake_sess = FakeSession()

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.post(
                "/api/v1/developer-hub/connectors",
                json={
                    "name": "My Hub",
                    "base_url": "https://devhub.example.com",
                    "auth_type": "bearer",
                    "auth_token_ref": "MY_TOKEN",
                    "entity_kinds": ["Template"],
                },
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "My Hub"
        assert data["base_url"] == "https://devhub.example.com"
        assert data["auth_type"] == "bearer"
        assert "Template" in data["entity_kinds"]
        assert data["connector_id"].startswith("devhub-")
        assert len(fake_sess.added) == 2  # connector + audit event

    def test_create_connector_invalid_auth_type(self, admin_client):
        fake_sess = FakeSession()

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.post(
                "/api/v1/developer-hub/connectors",
                json={"name": "Bad", "base_url": "https://example.com", "auth_type": "kerberos"},
            )
        assert resp.status_code == 422

    def test_create_connector_rejects_unsupported_oauth(self, admin_client):
        fake_sess = FakeSession()

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.post(
                "/api/v1/developer-hub/connectors",
                json={"name": "Bad", "base_url": "https://example.com", "auth_type": "oauth"},
            )
        assert resp.status_code == 422
        assert fake_sess.execute_count == 0

    def test_create_connector_rejects_unknown_fields(self, admin_client):
        fake_sess = FakeSession()

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.post(
                "/api/v1/developer-hub/connectors",
                json={
                    "name": "Bad",
                    "base_url": "https://example.com",
                    "auth_type": "none",
                    "role": "platform_admin",
                },
            )
        assert resp.status_code == 422
        assert fake_sess.execute_count == 0

    def test_create_connector_invalid_entity_kind(self, admin_client):
        fake_sess = FakeSession()

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.post(
                "/api/v1/developer-hub/connectors",
                json={"name": "Bad", "base_url": "https://example.com", "entity_kinds": ["InvalidKind"]},
            )
        assert resp.status_code == 422

    def test_list_connectors(self, admin_client):
        row = self._make_connector_row()
        fake_sess = FakeSession()
        fake_sess._execute_results = [
            FakeResult(items=[row]),
            FakeResult(scalar=1),
        ]

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.get("/api/v1/developer-hub/connectors")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1
        assert len(data["connectors"]) == 1
        assert data["connectors"][0]["connector_id"] == "devhub-test123"

    def test_list_connectors_rejects_malformed_org_filter_before_db(self, admin_client):
        fake_sess = FakeSession()

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.get("/api/v1/developer-hub/connectors?org_id=org-1%0Arole=admin")
        assert resp.status_code == 422
        assert fake_sess.execute_count == 0

    def test_get_connector(self, admin_client):
        row = self._make_connector_row()
        fake_sess = FakeSession()
        fake_sess._execute_results = [FakeResult(items=[row])]

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.get("/api/v1/developer-hub/connectors/devhub-test123")
        assert resp.status_code == 200
        assert resp.json()["name"] == "Test Hub"

    def test_get_connector_not_found(self, admin_client):
        fake_sess = FakeSession()
        fake_sess._execute_results = [FakeResult(items=[])]

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.get("/api/v1/developer-hub/connectors/devhub-missing")
        assert resp.status_code == 404

    def test_get_connector_rejects_malformed_id_before_db(self, admin_client):
        fake_sess = FakeSession()

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.get("/api/v1/developer-hub/connectors/not-a-devhub-id")
        assert resp.status_code == 422
        assert fake_sess.execute_count == 0

    def test_update_connector(self, admin_client):
        row = self._make_connector_row(name="Updated Hub")
        fake_sess = FakeSession()
        fake_sess._execute_results = [
            FakeResult(items=[row]),
            FakeResult(rowcount=1),
            FakeResult(items=[row]),
        ]

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.patch(
                "/api/v1/developer-hub/connectors/devhub-test123",
                json={"name": "Updated Hub"},
            )
        assert resp.status_code == 200

    def test_update_connector_no_fields(self, admin_client):
        fake_sess = FakeSession()

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.patch(
                "/api/v1/developer-hub/connectors/devhub-test123",
                json={},
            )
        assert resp.status_code == 400

    def test_delete_connector(self, admin_client):
        row = self._make_connector_row()
        fake_sess = FakeSession()
        fake_sess._execute_results = [FakeResult(items=[row]), FakeResult(rowcount=1)]

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.delete("/api/v1/developer-hub/connectors/devhub-test123")
        assert resp.status_code == 200
        assert resp.json()["status"] == "deleted"

    def test_delete_connector_not_found(self, admin_client):
        fake_sess = FakeSession()
        fake_sess._execute_results = [FakeResult(items=[])]

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.delete("/api/v1/developer-hub/connectors/devhub-missing")
        assert resp.status_code == 404

    def test_get_cache_empty(self, admin_client):
        row = self._make_connector_row(cached_entity_snapshot=None)
        fake_sess = FakeSession()
        fake_sess._execute_results = [FakeResult(items=[row])]

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.get("/api/v1/developer-hub/connectors/devhub-test123/cache")
        assert resp.status_code == 200
        assert resp.json()["has_cache"] is False

    def test_get_cache_populated(self, admin_client):
        snapshot = {
            "entities": [
                {"kind": "Template", "metadata": {"name": "t1"}},
                {"kind": "Component", "metadata": {"name": "c1"}},
                {"kind": "MadeUpKind", "metadata": {"name": "ignored"}},
            ],
            "synced_at": "2026-03-30T00:00:00Z",
        }
        row = self._make_connector_row(cached_entity_snapshot=snapshot)
        fake_sess = FakeSession()
        fake_sess._execute_results = [FakeResult(items=[row])]

        @asynccontextmanager
        async def mock_session():
            yield fake_sess

        with patch("app.routers.developer_hub.async_session", mock_session):
            resp = admin_client.get("/api/v1/developer-hub/connectors/devhub-test123/cache")
        assert resp.status_code == 200
        data = resp.json()
        assert data["has_cache"] is True
        assert data["entity_count"] == 3
        assert "Template" in data["entity_kinds"]
        assert "MadeUpKind" not in data["entity_kinds"]


# ── SyncResult / PreviewItem model tests ─────────────────────────────────────


class TestSyncModels:
    def test_sync_result_to_dict(self):
        from app.services.devhub_sync import SyncResult

        r = SyncResult(created=3, updated=1, unchanged=5, errors=0)
        d = r.to_dict()
        assert d["created"] == 3
        assert d["updated"] == 1
        assert d["unchanged"] == 5

    def test_sync_result_truncates_errors(self):
        from app.services.devhub_sync import SyncResult

        r = SyncResult(error_messages=[f"err-{i}" for i in range(30)])
        assert len(r.to_dict()["error_messages"]) == 20

    def test_preview_item_to_dict(self):
        from app.services.devhub_sync import PreviewItem

        p = PreviewItem(
            entity_ref="template:default/go-svc",
            kind="Template",
            name="go-svc",
            action="create",
            golden_path_id="go-svc",
            content_profile="procedural",
        )
        d = p.to_dict()
        assert d["entity_ref"] == "template:default/go-svc"
        assert d["action"] == "create"
        assert d["golden_path_id"] == "go-svc"
