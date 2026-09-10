#!/usr/bin/env python3
"""Fail if admin API routes are added without explicit auth coverage.

This is intentionally narrow and repo-specific. It catches common FastAPI
mistakes: a route decorator with no auth dependency, no router-level
auth dependency, and no service-token check in the handler body.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FASTAPI_AUTH_MARKERS = (
    "get_current_user",
    "require_admin",
    "require_platform_admin",
    "require_org_admin",
    "require_user",
    "require_readonly",
    "require_tenant_content_operator",
    "require_org_observability",
    "require_org_content_admin",
    "require_model_scope",
    "require_coder_scope",
    "require_fga",
    "require_service_or_platform_admin",
    "require_service_or_authenticated_user",
    "require_internal_service_token_request",
    "_verify_service_token",
)

FASTAPI_PUBLIC_ROUTES = {
    ("auth_router.py", "oidc_config"),
    ("auth_router.py", "oauth_token_exchange"),
    ("auth_router.py", "oauth_refresh"),
}


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def _decorated_routes(node: ast.AsyncFunctionDef | ast.FunctionDef) -> list[ast.Call]:
    routes: list[ast.Call] = []
    for decorator in node.decorator_list:
        if not isinstance(decorator, ast.Call):
            continue
        if _call_name(decorator.func) in {"get", "post", "put", "patch", "delete", "api_route"}:
            routes.append(decorator)
    return routes


def _defaults(node: ast.AsyncFunctionDef | ast.FunctionDef) -> list[str]:
    values: list[str] = []
    args = node.args.args
    defaults = [None] * (len(args) - len(node.args.defaults)) + list(node.args.defaults)
    for default in defaults:
        if default is not None:
            values.append(ast.unparse(default))
    for default in node.args.kw_defaults:
        if default is not None:
            values.append(ast.unparse(default))
    return values


def _router_level_auth(tree: ast.Module) -> bool:
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if _call_name(node.func) != "APIRouter":
            continue
        text = ast.unparse(node)
        if any(marker in text for marker in FASTAPI_AUTH_MARKERS):
            return True
    return False


def check_fastapi() -> list[str]:
    failures: list[str] = []
    routers_dir = ROOT / "base/admin/app/routers"
    for path in sorted(routers_dir.glob("*.py")):
        if path.name == "__init__.py":
            continue
        tree = ast.parse(path.read_text(), filename=str(path))
        router_has_auth = _router_level_auth(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef):
                continue
            routes = _decorated_routes(node)
            if not routes or (path.name, node.name) in FASTAPI_PUBLIC_ROUTES:
                continue
            auth_text = " ".join([*(ast.unparse(r) for r in routes), *_defaults(node), ast.unparse(node)])
            if router_has_auth or any(marker in auth_text for marker in FASTAPI_AUTH_MARKERS):
                continue
            failures.append(f"{path.relative_to(ROOT)}:{node.lineno} {node.name} lacks explicit auth dependency")
    return failures


def main() -> int:
    failures = check_fastapi()
    if failures:
        print("Auth/authz coverage check failed:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1
    print("Auth/authz route coverage check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
