"""Handler registry with auto-discovery.

All handler modules in this package are auto-registered on import.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import BaseHandler

_REGISTRY: dict[str, type[BaseHandler]] = {}


def register(handler_cls: type[BaseHandler]) -> type[BaseHandler]:
    """Class decorator to register a handler by its handler_type."""
    _REGISTRY[handler_cls.handler_type] = handler_cls
    return handler_cls


def get_handler(handler_type: str) -> BaseHandler:
    """Instantiate a handler by type name."""
    _discover()
    cls = _REGISTRY.get(handler_type)
    if cls is None:
        available = ", ".join(sorted(_REGISTRY.keys()))
        raise ValueError(f"Unknown handler type '{handler_type}'. Available: {available}")
    return cls()


def list_handlers() -> list[str]:
    """Return sorted list of registered handler type names."""
    _discover()
    return sorted(_REGISTRY.keys())


_discovered = False


def _discover() -> None:
    """Import all handler modules once to trigger registration."""
    global _discovered
    if _discovered:
        return
    _discovered = True
    from . import (  # noqa: F401
        arxiv_paper,
        github_code,
        github_markdown,
        html_document,
        license_spdx,
        markdown_file,
        openapi_spec,
        pdf_document,
        seed_corpus,
        web_page,
    )
