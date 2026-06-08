"""Tests for the governance control plane API.

Mocks the database layer and auth to exercise constitution CRUD,
clause CRUD, policy CRUD, lifecycle transitions, and the effective
governance query endpoint.

Run from ``base/admin/``::

    PYTHONPATH=. uv run pytest tests/test_governance.py -v
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

_auth_ctx: dict[str, object] = {"user": None}


def _make_user_override():
    """Build a dependency override that matches get_current_user's signature."""
    from app.auth import UserInfo

    class _Override:
        async def __call__(
            self,
            request: Request = None,  # type: ignore[assignment]
        ) -> UserInfo:
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


@pytest.fixture()
def admin_client():
    from app.auth import UserInfo, get_current_user
    from app.internal_auth import require_service_or_authenticated_user
    from app.main import app

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
    app.dependency_overrides[require_service_or_authenticated_user] = _make_user_override()
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(require_service_or_authenticated_user, None)


@pytest.fixture()
def reader_client():
    from app.auth import UserInfo, get_current_user
    from app.main import app

    _auth_ctx["user"] = UserInfo(
        username="reader",
        role="user",
        user_id="u-2",
        org_id="org-1",
        org_name="TestOrg",
        tenant_ids=[],
        acl_groups=[],
    )
    app.dependency_overrides[get_current_user] = _make_user_override()
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture()
def platform_admin_client():
    from app.auth import UserInfo, get_current_user
    from app.main import app

    _auth_ctx["user"] = UserInfo(
        username="platform-admin",
        role="platform_admin",
        user_id="u-platform",
        org_id="org-1",
        org_name="TestOrg",
        tenant_ids=["t-1"],
        acl_groups=[],
    )
    app.dependency_overrides[get_current_user] = _make_user_override()
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.pop(get_current_user, None)


# ── Mock DB session ──────────────────────────────────────────────────────────


class FakeRow:
    """Simulates a SQLAlchemy model instance with attribute access."""

    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


class FakeScalarResult:
    def __init__(self, items):
        self._items = items

    def all(self):
        return self._items

    def __iter__(self):
        return iter(self._items)


class FakeResult:
    def __init__(self, items=None, scalar=None):
        self._items = items or []
        self._scalar = scalar

    def scalars(self):
        return FakeScalarResult(self._items)

    def scalar(self):
        return self._scalar

    def scalar_one_or_none(self):
        return self._items[0] if self._items else None

    def all(self):
        return [(row,) for row in self._items]


class FakeSession:
    def __init__(self):
        self.added = []
        self.deleted = []
        self._execute_results = []

    def add(self, obj):
        self.added.append(obj)

    async def delete(self, obj):
        self.deleted.append(obj)

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
        if self._execute_results:
            return self._execute_results.pop(0)
        return FakeResult()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


@pytest.fixture(autouse=True)
def _mock_db():
    with patch("app.routers.governance.async_session") as mock_session:
        session = FakeSession()
        mock_session.return_value = session

        @asynccontextmanager
        async def ctx():
            yield session

        mock_session.side_effect = ctx
        yield session


# ── Constitution CRUD ────────────────────────────────────────────────────────


class TestConstitutionCRUD:
    def test_create_constitution(self, admin_client, _mock_db):
        resp = admin_client.post(
            "/api/v1/governance/constitutions",
            json={
                "name": "Platform Safety",
                "scope": "platform",
                "maturity_mode": "base",
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "Platform Safety"
        assert data["status"] == "draft"
        assert data["version"] == 1
        assert data["scope"] == "org"

    def test_create_constitution_invalid_scope(self, admin_client, _mock_db):
        resp = admin_client.post(
            "/api/v1/governance/constitutions",
            json={
                "name": "Bad",
                "scope": "galaxy",
            },
        )
        assert resp.status_code == 400

    def test_create_constitution_invalid_maturity(self, admin_client, _mock_db):
        resp = admin_client.post(
            "/api/v1/governance/constitutions",
            json={
                "name": "Bad",
                "maturity_mode": "legendary",
            },
        )
        assert resp.status_code == 400

    def test_reader_cannot_create(self, reader_client, _mock_db):
        resp = reader_client.post(
            "/api/v1/governance/constitutions",
            json={
                "name": "Forbidden",
            },
        )
        assert resp.status_code == 403

    def test_list_constitutions_empty(self, admin_client, _mock_db):
        resp = admin_client.get("/api/v1/governance/constitutions")
        assert resp.status_code == 200
        data = resp.json()
        assert data["constitutions"] == []

    def test_get_constitution_not_found(self, admin_client, _mock_db):
        resp = admin_client.get("/api/v1/governance/constitutions/nonexistent")
        assert resp.status_code == 404

    def test_update_draft_constitution(self, admin_client, _mock_db):
        row = FakeRow(
            id=1,
            constitution_id="c-1",
            name="Draft",
            version=1,
            status="draft",
            scope="org",
            scope_value="org-1",
            precedence=0,
            description="",
            provenance_source="",
            provenance_owner="",
            provenance_checksum="",
            effective_from=None,
            effective_until=None,
            maturity_mode="base",
            created_by="admin",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        _mock_db._execute_results = [FakeResult(items=[row])]
        resp = admin_client.put(
            "/api/v1/governance/constitutions/c-1",
            json={
                "name": "Updated",
                "description": "New desc",
            },
        )
        assert resp.status_code == 200
        assert row.name == "Updated"
        assert row.description == "New desc"

    def test_update_active_constitution_rejected(self, admin_client, _mock_db):
        row = FakeRow(
            id=1,
            constitution_id="c-2",
            name="Active",
            version=1,
            status="active",
            scope="org",
            scope_value="org-1",
            precedence=0,
            description="",
            provenance_source="",
            provenance_owner="",
            provenance_checksum="",
            effective_from=None,
            effective_until=None,
            maturity_mode="base",
            created_by="admin",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        _mock_db._execute_results = [FakeResult(items=[row])]
        resp = admin_client.put(
            "/api/v1/governance/constitutions/c-2",
            json={
                "name": "Should Fail",
            },
        )
        assert resp.status_code == 409


# ── Constitution Lifecycle ───────────────────────────────────────────────────


class TestConstitutionLifecycle:
    def test_activate_draft(self, admin_client, _mock_db):
        row = FakeRow(
            id=1,
            constitution_id="c-3",
            name="Ready",
            version=1,
            status="draft",
            scope="org",
            scope_value="org-1",
            precedence=0,
            description="",
            provenance_source="",
            provenance_owner="",
            provenance_checksum="",
            effective_from=None,
            effective_until=None,
            maturity_mode="guided",
            created_by="admin",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        _mock_db._execute_results = [
            FakeResult(items=[row]),
            FakeResult(items=[]),
            FakeResult(),
        ]
        resp = admin_client.post("/api/v1/governance/constitutions/c-3/activate")
        assert resp.status_code == 200
        assert row.status == "active"

    def test_activate_dry_run(self, admin_client, _mock_db):
        row = FakeRow(
            id=1,
            constitution_id="c-4",
            name="Preview",
            version=1,
            status="draft",
            scope="org",
            scope_value="org-1",
            precedence=0,
            description="",
            provenance_source="",
            provenance_owner="",
            provenance_checksum="",
            effective_from=None,
            effective_until=None,
            maturity_mode="base",
            created_by="admin",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        _mock_db._execute_results = [
            FakeResult(items=[row]),
            FakeResult(items=[]),
        ]
        resp = admin_client.post("/api/v1/governance/constitutions/c-4/activate?dry_run=true")
        assert resp.status_code == 200
        data = resp.json()
        assert data["dry_run"] is True
        assert data["would_activate"] is True
        assert row.status == "draft"

    def test_deprecate_active(self, admin_client, _mock_db):
        row = FakeRow(
            id=1,
            constitution_id="c-5",
            name="Dep",
            version=1,
            status="active",
            scope="org",
            scope_value="org-1",
            precedence=0,
            description="",
            provenance_source="",
            provenance_owner="",
            provenance_checksum="abc",
            effective_from=None,
            effective_until=None,
            maturity_mode="governed",
            created_by="admin",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        _mock_db._execute_results = [FakeResult(items=[row])]
        resp = admin_client.post("/api/v1/governance/constitutions/c-5/deprecate")
        assert resp.status_code == 200
        assert row.status == "deprecated"

    def test_deprecate_draft_rejected(self, admin_client, _mock_db):
        row = FakeRow(
            id=1,
            constitution_id="c-6",
            name="Bad",
            version=1,
            status="draft",
            scope="org",
            scope_value="org-1",
            precedence=0,
            description="",
            provenance_source="",
            provenance_owner="",
            provenance_checksum="",
            effective_from=None,
            effective_until=None,
            maturity_mode="base",
            created_by="admin",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        _mock_db._execute_results = [FakeResult(items=[row])]
        resp = admin_client.post("/api/v1/governance/constitutions/c-6/deprecate")
        assert resp.status_code == 409


# ── Clause CRUD ──────────────────────────────────────────────────────────────


class TestClauseCRUD:
    def test_create_clause(self, admin_client, _mock_db):
        parent = FakeRow(
            id=1,
            constitution_id="c-1",
            name="Parent",
            version=1,
            status="draft",
            scope="org",
            scope_value="org-1",
            precedence=0,
            description="",
            provenance_source="",
            provenance_owner="",
            provenance_checksum="",
            effective_from=None,
            effective_until=None,
            maturity_mode="base",
            created_by="admin",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        _mock_db._execute_results = [FakeResult(items=[parent])]
        resp = admin_client.post(
            "/api/v1/governance/constitutions/c-1/clauses",
            json={
                "category": "safety",
                "constraint_kind": "hard",
                "statement": "No secrets in code",
                "priority": 100,
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["category"] == "safety"
        assert data["constraint_kind"] == "hard"
        assert data["statement"] == "No secrets in code"

    def test_create_clause_invalid_category(self, admin_client, _mock_db):
        resp = admin_client.post(
            "/api/v1/governance/constitutions/c-1/clauses",
            json={
                "category": "nonsense",
                "constraint_kind": "hard",
            },
        )
        assert resp.status_code == 400

    def test_create_clause_invalid_constraint_kind(self, admin_client, _mock_db):
        resp = admin_client.post(
            "/api/v1/governance/constitutions/c-1/clauses",
            json={
                "category": "quality",
                "constraint_kind": "mandatory",
            },
        )
        assert resp.status_code == 400

    def test_delete_clause(self, admin_client, _mock_db):
        clause = FakeRow(
            id=10,
            clause_id="cl-1",
            constitution_id="c-1",
            category="quality",
            constraint_kind="guiding",
            statement="Test",
            machine_rule=None,
            applicability=None,
            evidence_requirements=None,
            actions=None,
            validation_recipe_id=None,
            enabled=True,
            priority=0,
        )
        _mock_db._execute_results = [FakeResult(items=[clause])]
        resp = admin_client.delete("/api/v1/governance/clauses/cl-1")
        assert resp.status_code == 200
        assert resp.json()["deleted"] == "cl-1"

    def test_delete_clause_not_found(self, admin_client, _mock_db):
        resp = admin_client.delete("/api/v1/governance/clauses/nonexistent")
        assert resp.status_code == 404


# ── Policy CRUD ──────────────────────────────────────────────────────────────


class TestPolicyCRUD:
    def test_create_policy(self, admin_client, _mock_db):
        resp = admin_client.post(
            "/api/v1/governance/policies",
            json={
                "name": "Max Tool Calls",
                "rule_type": "threshold",
                "rule_config": {"max_tool_calls": 20},
                "category": "safety",
                "constraint_kind": "guiding",
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "Max Tool Calls"
        assert data["rule_type"] == "threshold"

    def test_create_policy_invalid_rule_type(self, admin_client, _mock_db):
        resp = admin_client.post(
            "/api/v1/governance/policies",
            json={
                "name": "Bad",
                "rule_type": "magic",
            },
        )
        assert resp.status_code == 400

    def test_create_policy_rejects_unknown_rule_config_key(self, admin_client, _mock_db):
        resp = admin_client.post(
            "/api/v1/governance/policies",
            json={
                "name": "Bad Threshold",
                "rule_type": "threshold",
                "rule_config": {"max_tool_calls": 20, "invented_security_bypass": True},
            },
        )
        assert resp.status_code == 400
        assert "invented_security_bypass" in resp.json()["detail"]

    def test_create_policy_rejects_invalid_threshold_value(self, admin_client, _mock_db):
        resp = admin_client.post(
            "/api/v1/governance/policies",
            json={
                "name": "Bad Threshold",
                "rule_type": "threshold",
                "rule_config": {"max_tool_calls": True},
            },
        )
        assert resp.status_code == 400
        assert "max_tool_calls" in resp.json()["detail"]

    def test_create_feature_toggle_rejects_unknown_rule_config_key(self, admin_client, _mock_db):
        resp = admin_client.post(
            "/api/v1/governance/policies",
            json={
                "name": "Bad Feature Toggle",
                "rule_type": "feature_toggle",
                "rule_config": {"invented_toggle": True},
            },
        )
        assert resp.status_code == 400
        assert "invented_toggle" in resp.json()["detail"]

    def test_update_policy_rejects_unknown_rule_config_key(self, admin_client, _mock_db):
        policy = FakeRow(
            id=21,
            policy_id="p-2",
            name="Update Me",
            description="",
            scope="org",
            scope_value="org-1",
            org_id="org-1",
            category="quality",
            constraint_kind="guiding",
            rule_type="threshold",
            rule_config={},
            enabled=True,
            priority=0,
            created_by="admin",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        _mock_db._execute_results = [FakeResult(items=[policy])]
        resp = admin_client.put(
            "/api/v1/governance/policies/p-2",
            json={
                "rule_config": {
                    "max_tool_calls": 20,
                    "invented_security_bypass": True,
                }
            },
        )
        assert resp.status_code == 400
        assert "invented_security_bypass" in resp.json()["detail"]

    def test_delete_policy(self, admin_client, _mock_db):
        policy = FakeRow(
            id=20,
            policy_id="p-1",
            name="Delete Me",
            description="",
            scope="org",
            scope_value="org-1",
            org_id="org-1",
            category="quality",
            constraint_kind="guiding",
            rule_type="threshold",
            rule_config={},
            enabled=True,
            priority=0,
            created_by="admin",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        _mock_db._execute_results = [FakeResult(items=[policy])]
        resp = admin_client.delete("/api/v1/governance/policies/p-1")
        assert resp.status_code == 200
        assert resp.json()["deleted"] == "p-1"


# ── Effective Governance ─────────────────────────────────────────────────────


class TestEffectiveGovernance:
    def test_effective_empty(self, admin_client, _mock_db):
        _mock_db._execute_results = [
            FakeResult(items=[]),
            FakeResult(items=[]),
        ]
        resp = admin_client.get("/api/v1/governance/effective")
        assert resp.status_code == 200
        data = resp.json()
        assert data["rules"] == []
        assert data["total"] == 0

    def test_summary_empty(self, admin_client, _mock_db):
        _mock_db._execute_results = [
            FakeResult(items=[]),
            FakeResult(items=[]),
            FakeResult(scalar=0),
            FakeResult(items=[]),
        ]
        resp = admin_client.get("/api/v1/governance/summary")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_policies"] == 0


class TestCapabilityMatrixCanonicalSelectors:
    def test_create_override_rejects_non_canonical_selector(self, platform_admin_client, _mock_db):
        deployment = FakeRow(
            id=1,
            role="coder",
            model="qwen3/qwen3.6-35b-a3b",
            served_name="synesis-coder",
            is_active=True,
        )
        _mock_db._execute_results = [
            FakeResult(items=[deployment]),  # canonical selector snapshot from active deployments
        ]
        resp = platform_admin_client.post(
            "/api/v1/governance/capability-matrix/overrides",
            json={
                "selector_type": "exact_model",
                "selector": "synesis-codre",
                "scope": "platform",
                "enabled": True,
                "capabilities": {"yarn.reducers_enabled": True},
            },
        )
        assert resp.status_code == 400
        assert "Non-canonical selector" in resp.json()["detail"]

    def test_create_override_accepts_canonical_selector(self, platform_admin_client, _mock_db):
        deployment = FakeRow(
            id=2,
            role="coder",
            model="qwen3/qwen3.6-35b-a3b",
            served_name="synesis-coder",
            is_active=True,
        )
        _mock_db._execute_results = [
            FakeResult(items=[deployment]),  # canonical selector snapshot
            FakeResult(items=[]),  # no selector conflict
        ]
        resp = platform_admin_client.post(
            "/api/v1/governance/capability-matrix/overrides",
            json={
                "selector_type": "exact_model",
                "selector": "synesis-coder",
                "scope": "platform",
                "enabled": True,
                "capabilities": {"yarn.reducers_enabled": True},
            },
        )
        assert resp.status_code == 201
        assert resp.json()["selector"] == "synesis-coder"

    def test_update_override_rejects_non_canonical_selector(self, platform_admin_client, _mock_db):
        existing = FakeRow(
            id=10,
            policy_id="cm-override-1",
            name="Legacy selector",
            scope="platform",
            scope_value="org-1",
            org_id="",
            category="tooling",
            constraint_kind="hard",
            rule_type="feature_toggle",
            rule_config={
                "kind": "capability_matrix_v1",
                "row_type": "override",
                "version": 1,
                "selector_type": "exact_model",
                "selector": "synesis-coder",
                "priority": 10,
                "capabilities": {"yarn.reducers_enabled": True},
            },
            enabled=True,
            priority=10,
            updated_at=datetime.now(UTC),
        )
        deployment = FakeRow(
            id=3,
            role="coder",
            model="qwen3/qwen3.6-35b-a3b",
            served_name="synesis-coder",
            is_active=True,
        )
        _mock_db._execute_results = [
            FakeResult(items=[existing]),  # existing policy
            FakeResult(items=[deployment]),  # canonical selector snapshot
        ]
        resp = platform_admin_client.put(
            "/api/v1/governance/capability-matrix/overrides/cm-override-1",
            json={
                "selector_type": "exact_model",
                "selector": "synesis-coder-typo",
                "scope": "platform",
                "enabled": True,
                "priority": 10,
                "capabilities": {"yarn.reducers_enabled": True},
            },
        )
        assert resp.status_code == 400
        assert "Non-canonical selector" in resp.json()["detail"]
