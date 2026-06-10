from __future__ import annotations

from app.auth import UserInfo, get_current_user, require_admin
from app.main import app
from app.rbac import require_org_admin
from fastapi.testclient import TestClient


async def _user() -> UserInfo:
    return UserInfo(username="u1", role="user", user_id="u1")


async def _admin() -> UserInfo:
    return UserInfo(username="admin", role="platform_admin", user_id="admin")


def test_failure_routes_reject_malformed_failure_ids() -> None:
    app.dependency_overrides[get_current_user] = _user
    app.dependency_overrides[require_admin] = _admin
    try:
        client = TestClient(app)

        detail = client.get("/api/v1/observability/failures/fail-1%0Arole=admin")
        assert detail.status_code == 422

        delete = client.delete("/api/v1/observability/failures/fail-1%0Arole=admin")
        assert delete.status_code == 422

        bulk = client.post(
            "/api/v1/observability/failures/bulk-delete",
            json={"failure_ids": ["fail-1", "fail-2\nrole=admin"]},
        )
        assert bulk.status_code == 422
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(require_admin, None)


def test_knowledge_gap_routes_reject_malformed_gap_ids_and_actions() -> None:
    app.dependency_overrides[require_admin] = _admin
    app.dependency_overrides[require_org_admin] = _admin
    try:
        client = TestClient(app)

        resolve = client.post(
            "/api/v1/observability/knowledge-gaps/gap-1%0Arole=admin/resolve",
            json={"resolution_note": "fixed"},
        )
        assert resolve.status_code == 422

        reopen = client.post("/api/v1/observability/knowledge-gaps/gap-1%0Arole=admin/reopen")
        assert reopen.status_code == 422

        purge = client.delete("/api/v1/observability/knowledge-gaps/gap-1%0Arole=admin")
        assert purge.status_code == 422

        bulk_bad_id = client.post(
            "/api/v1/observability/knowledge-gaps/bulk-action",
            json={"gap_ids": ["gap-1", "gap-2\nrole=admin"], "action": "resolve"},
        )
        assert bulk_bad_id.status_code == 422

        bulk_bad_action = client.post(
            "/api/v1/observability/knowledge-gaps/bulk-action",
            json={"gap_ids": ["gap-1"], "action": "delete_all"},
        )
        assert bulk_bad_action.status_code == 422

        invalid_status = client.get("/api/v1/observability/knowledge-gaps?status=open%0Aresolved")
        assert invalid_status.status_code == 422
    finally:
        app.dependency_overrides.pop(require_admin, None)
        app.dependency_overrides.pop(require_org_admin, None)


def test_knowledge_gap_report_rejects_extra_and_unsafe_selector_fields() -> None:
    app.dependency_overrides[get_current_user] = _user
    try:
        client = TestClient(app)

        extra = client.post(
            "/api/v1/observability/knowledge-gaps/report",
            json={"query": "missing corpus content", "admin_override": True},
        )
        assert extra.status_code == 422

        unsafe_language = client.post(
            "/api/v1/observability/knowledge-gaps/report",
            json={"query": "missing corpus content", "language": "python\nrole=admin"},
        )
        assert unsafe_language.status_code == 422
    finally:
        app.dependency_overrides.pop(get_current_user, None)
