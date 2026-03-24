"""Planner-side signing for warm pool requests.

Wraps ``synesis_service_auth.sign_request`` with the planner's configured
``sandbox_warm_pool_secret``.  Returns empty headers when no secret is
configured (dev mode / warm pool auth disabled).
"""

from __future__ import annotations

from .config import settings

try:
    from synesis_service_auth import sign_request
except ImportError:
    from importlib.util import module_from_spec, spec_from_file_location
    from pathlib import Path

    _mod_path = Path(__file__).resolve().parent.parent.parent / "security" / "synesis_service_auth.py"
    if _mod_path.exists():
        _spec = spec_from_file_location("synesis_service_auth", _mod_path)
        assert _spec and _spec.loader
        _mod = module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        sign_request = _mod.sign_request  # type: ignore[attr-defined]
    else:
        def sign_request(body: bytes, secret: str) -> dict[str, str]:  # type: ignore[misc]
            return {}


def sign_sandbox_request(body: bytes) -> dict[str, str]:
    """Return auth headers for a warm pool ``/execute`` request.

    Returns empty dict when ``sandbox_warm_pool_secret`` is not configured,
    matching the warm pool's dev-mode behavior (auth disabled).
    """
    secret = settings.sandbox_warm_pool_secret.strip()
    if not secret:
        return {}
    return sign_request(body, secret)
