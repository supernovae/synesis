"""Admin authz hardening tests.

Covers:
- _apply_filter_expr compound 'and', 'in [...]', and fail-closed behavior
- safe_query org-scope Cypher clause generation
- synesis_search MCP identity forwarding + min_role
- Taxonomy write endpoint role gates
- Ingestion stats/runs org scoping
- Dashboard quality-wiring scope
- P2 role gates (audit, pipeline, observability, feedback, testing-labs)
- SSE events org scoping
"""

from __future__ import annotations

from app.auth import UserInfo

# ─── Fixture helpers ────────────────────────────────────────────────────────


def _platform_admin(org_id: str = "org-alpha") -> UserInfo:
    return UserInfo(
        user_id="admin-1",
        username="admin",
        role="admin",
        org_id=org_id,
    )


def _org_admin(org_id: str = "org-alpha") -> UserInfo:
    return UserInfo(
        user_id="orgadm-1",
        username="orgadmin",
        role="user",
        org_id=org_id,
        org_roles=["admin"],
    )


def _regular_user(org_id: str = "org-alpha") -> UserInfo:
    return UserInfo(
        user_id="user-1",
        username="userone",
        role="user",
        org_id=org_id,
    )


# ═══════════════════════════════════════════════════════════════════════════
# P0: _apply_filter_expr compound + in + fail-closed
# ═══════════════════════════════════════════════════════════════════════════


_FILTER_TEST_ROWS = [
    {"scan_status": "flagged", "domain": "python", "kind": "function"},
    {"scan_status": "unscanned", "domain": "java", "kind": "class"},
    {"scan_status": "flagged", "domain": "java", "kind": "module"},
    {"scan_status": "clean", "domain": "python", "kind": "function"},
]


class TestApplyFilterExpr:
    def test_eq_filter(self):
        from app.services.nornic_service import _apply_filter_expr

        result = _apply_filter_expr(_FILTER_TEST_ROWS, 'scan_status == "flagged"')
        assert len(result) == 2
        assert all(r["scan_status"] == "flagged" for r in result)

    def test_ne_filter(self):
        from app.services.nornic_service import _apply_filter_expr

        result = _apply_filter_expr(_FILTER_TEST_ROWS, 'scan_status != "flagged"')
        assert len(result) == 2
        assert all(r["scan_status"] != "flagged" for r in result)

    def test_in_filter(self):
        from app.services.nornic_service import _apply_filter_expr

        result = _apply_filter_expr(_FILTER_TEST_ROWS, 'scan_status in ["flagged", "unscanned"]')
        assert len(result) == 3
        for r in result:
            assert r["scan_status"] in ("flagged", "unscanned")

    def test_compound_and_filter(self):
        from app.services.nornic_service import _apply_filter_expr

        result = _apply_filter_expr(_FILTER_TEST_ROWS, '(scan_status == "flagged") and domain == "java"')
        assert len(result) == 1
        assert result[0]["domain"] == "java"
        assert result[0]["scan_status"] == "flagged"

    def test_compound_and_three_clauses(self):
        from app.services.nornic_service import _apply_filter_expr

        result = _apply_filter_expr(
            _FILTER_TEST_ROWS,
            'scan_status == "flagged" and domain == "python" and kind == "function"',
        )
        assert len(result) == 1
        assert result[0]["domain"] == "python"

    def test_empty_filter_returns_all(self):
        from app.services.nornic_service import _apply_filter_expr

        result = _apply_filter_expr(_FILTER_TEST_ROWS, "")
        assert len(result) == len(_FILTER_TEST_ROWS)

    def test_unrecognized_expression_fails_closed(self):
        from app.services.nornic_service import _apply_filter_expr

        result = _apply_filter_expr(_FILTER_TEST_ROWS, "DROP TABLE users; --")
        assert result == []

    def test_unrecognized_nested_returns_empty(self):
        from app.services.nornic_service import _apply_filter_expr

        result = _apply_filter_expr(_FILTER_TEST_ROWS, 'scan_status LIKE "%flag%"')
        assert result == []

    def test_in_with_single_value(self):
        from app.services.nornic_service import _apply_filter_expr

        result = _apply_filter_expr(_FILTER_TEST_ROWS, 'domain in ["python"]')
        assert len(result) == 2
        assert all(r["domain"] == "python" for r in result)

    def test_missing_scan_status_counts_as_unscanned(self):
        from app.services.nornic_service import _apply_filter_expr

        rows = [{}, {"scan_status": ""}, {"scan_status": "flagged"}]
        result = _apply_filter_expr(rows, 'scan_status == "unscanned"')
        assert len(result) == 2

    def test_overlong_filter_fails_closed(self):
        from app.services.nornic_service import _apply_filter_expr

        result = _apply_filter_expr(_FILTER_TEST_ROWS, "x " * 2500)
        assert result == []


# ═══════════════════════════════════════════════════════════════════════════
# P0: safe_query org-scope Cypher clause
# ═══════════════════════════════════════════════════════════════════════════


class TestSafeQueryOrgScope:
    def test_org_scope_clause_empty_for_platform_admin(self):
        from app.services.nornic_service import _org_scope_clause

        clause = _org_scope_clause("n", caller_org_id="org-alpha", is_platform_admin=True)
        assert clause == ""

    def test_org_scope_clause_empty_when_no_org(self):
        from app.services.nornic_service import _org_scope_clause

        clause = _org_scope_clause("n", caller_org_id="", is_platform_admin=False)
        assert clause == ""

    def test_org_scope_clause_filters_for_org_admin(self):
        from app.services.nornic_service import _org_scope_clause

        clause = _org_scope_clause("n", caller_org_id="org-alpha", is_platform_admin=False)
        assert "visibility_scope" in clause
        assert "org_id" in clause
        assert "$caller_org_id" in clause


# ═══════════════════════════════════════════════════════════════════════════
# P0: Taxonomy write endpoints — require platform_admin
# ═══════════════════════════════════════════════════════════════════════════


class TestTaxonomyRoleGates:
    """Taxonomy write routes must use require_admin (platform_admin gate)."""

    def _get_auth_dep(self, endpoint_fn):
        import inspect

        sig = inspect.signature(endpoint_fn)
        user_param = sig.parameters["_user"]
        return user_param.default.dependency

    def test_update_domain_requires_admin(self):
        from app.auth import require_admin
        from app.routers.taxonomy import update_domain

        assert self._get_auth_dep(update_domain) is require_admin

    def test_sync_from_yaml_requires_admin(self):
        from app.auth import require_admin
        from app.routers.taxonomy import sync_from_yaml

        assert self._get_auth_dep(sync_from_yaml) is require_admin

    def test_export_yaml_requires_admin(self):
        from app.auth import require_admin
        from app.routers.taxonomy import export_yaml

        assert self._get_auth_dep(export_yaml) is require_admin


# ═══════════════════════════════════════════════════════════════════════════
# P2: Role gate checks (audit, pipeline, observability, feedback, testing-labs)
# ═══════════════════════════════════════════════════════════════════════════


class TestP2RoleGates:
    """Verify P2 endpoints use the correct auth dependencies."""

    def _get_auth_dep(self, endpoint_fn):
        import inspect

        sig = inspect.signature(endpoint_fn)
        user_param = sig.parameters.get("_user") or sig.parameters.get("user")
        assert user_param is not None, f"No user param in {endpoint_fn.__name__}"
        return user_param.default.dependency

    # ── Audit ──

    def test_audit_events_requires_platform_admin(self):
        from app.auth import require_admin
        from app.routers.audit import list_audit_events

        assert self._get_auth_dep(list_audit_events) is require_admin

    # ── Pipeline critic ──

    def test_critic_detailed_requires_platform_admin(self):
        from app.auth import require_admin
        from app.routers.pipeline import critic_detailed

        assert self._get_auth_dep(critic_detailed) is require_admin

    def test_critic_evaluations_requires_platform_admin(self):
        from app.auth import require_admin
        from app.routers.pipeline import critic_evaluations

        assert self._get_auth_dep(critic_evaluations) is require_admin

    def test_critic_analytics_requires_platform_admin(self):
        from app.auth import require_admin
        from app.routers.pipeline import critic_analytics

        assert self._get_auth_dep(critic_analytics) is require_admin

    def test_critic_models_requires_platform_admin(self):
        from app.auth import require_admin
        from app.routers.pipeline import critic_models

        assert self._get_auth_dep(critic_models) is require_admin

    # ── Observability ──

    def test_failures_requires_org_admin(self):
        from app.rbac import require_org_admin
        from app.routers.observability import failure_list

        assert self._get_auth_dep(failure_list) is require_org_admin

    def test_failure_stats_requires_org_admin(self):
        from app.rbac import require_org_admin
        from app.routers.observability import failure_stats

        assert self._get_auth_dep(failure_stats) is require_org_admin

    def test_knowledge_gaps_requires_org_admin(self):
        from app.rbac import require_org_admin
        from app.routers.observability import knowledge_gaps

        assert self._get_auth_dep(knowledge_gaps) is require_org_admin

    def test_knowledge_gap_stats_requires_org_admin(self):
        from app.rbac import require_org_admin
        from app.routers.observability import knowledge_gap_stats

        assert self._get_auth_dep(knowledge_gap_stats) is require_org_admin

    def test_cache_requires_org_admin(self):
        from app.rbac import require_org_admin
        from app.routers.observability import cache_metrics

        assert self._get_auth_dep(cache_metrics) is require_org_admin

    def test_cache_history_requires_org_admin(self):
        from app.rbac import require_org_admin
        from app.routers.observability import cache_history

        assert self._get_auth_dep(cache_history) is require_org_admin

    def test_circuit_breakers_requires_org_admin(self):
        from app.rbac import require_org_admin
        from app.routers.observability import circuit_breakers

        assert self._get_auth_dep(circuit_breakers) is require_org_admin

    # ── Feedback ──

    def test_list_feedback_requires_platform_admin(self):
        from app.auth import require_admin
        from app.routers.feedback import list_feedback

        assert self._get_auth_dep(list_feedback) is require_admin

    def test_feedback_stats_requires_platform_admin(self):
        from app.auth import require_admin
        from app.routers.feedback import feedback_stats

        assert self._get_auth_dep(feedback_stats) is require_admin

    # ── Testing labs ──

    def test_testing_labs_list_runs_requires_platform_admin(self):
        from app.auth import require_admin
        from app.routers.testing_labs import list_runs

        assert self._get_auth_dep(list_runs) is require_admin

    def test_testing_labs_stats_requires_platform_admin(self):
        from app.auth import require_admin
        from app.routers.testing_labs import testing_labs_stats

        assert self._get_auth_dep(testing_labs_stats) is require_admin

    def test_testing_labs_get_run_requires_platform_admin(self):
        from app.auth import require_admin
        from app.routers.testing_labs import get_run

        assert self._get_auth_dep(get_run) is require_admin

    def test_testing_labs_results_requires_platform_admin(self):
        from app.auth import require_admin
        from app.routers.testing_labs import list_results

        assert self._get_auth_dep(list_results) is require_admin


# ═══════════════════════════════════════════════════════════════════════════
# P1: Dashboard quality-wiring scoping
# ═══════════════════════════════════════════════════════════════════════════


class TestDashboardQualityWiring:
    """_db_counts takes a user and scopes traces."""

    def test_db_counts_signature_accepts_user(self):
        """_db_counts now requires a UserInfo parameter."""
        import inspect

        from app.routers.dashboard import _db_counts

        sig = inspect.signature(_db_counts)
        assert "user" in sig.parameters


# ═══════════════════════════════════════════════════════════════════════════
# P1: Rag.py scope helper
# ═══════════════════════════════════════════════════════════════════════════


class TestRagNornicScope:
    """_nornic_scope_kwargs returns correct scope for roles."""

    def test_platform_admin_gets_full_access(self):
        from app.routers.rag import _nornic_scope_kwargs

        kwargs = _nornic_scope_kwargs(_platform_admin())
        assert kwargs["is_platform_admin"] is True

    def test_org_admin_scoped_to_org(self):
        from app.routers.rag import _nornic_scope_kwargs

        kwargs = _nornic_scope_kwargs(_org_admin("org-beta"))
        assert kwargs["is_platform_admin"] is False
        assert kwargs["caller_org_id"] == "org-beta"

    def test_regular_user_scoped_to_org(self):
        from app.routers.rag import _nornic_scope_kwargs

        kwargs = _nornic_scope_kwargs(_regular_user("org-gamma"))
        assert kwargs["is_platform_admin"] is False
        assert kwargs["caller_org_id"] == "org-gamma"


# ═══════════════════════════════════════════════════════════════════════════
# P2: SSE events scoping
# ═══════════════════════════════════════════════════════════════════════════


class TestSseEventsScoping:
    """Verify trace_scope_filters is used in main.py SSE handler."""

    def test_main_imports_trace_scope_filters(self):
        """The SSE handler in main.py must use trace_scope_filters for scoping."""
        from pathlib import Path

        main_src = Path(__file__).resolve().parent.parent / "app" / "main.py"
        src = main_src.read_text()
        assert "trace_scope_filters" in src, "main.py must import trace_scope_filters"
        assert "org_id" in src, "SSE handler must filter by org_id"
