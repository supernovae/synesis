"""Search provider abstraction -- pluggable search backend.

Defines a ``SearchProvider`` protocol so the search backend (currently SearXNG)
can be swapped for a permissively-licensed alternative without touching
downstream code (worker, context_curator, etc.).

License note: SearXNG is AGPL-3.0, consumed as a separate containerized
service (not bundled). The ``SearchProvider`` protocol ensures it can be
replaced when Synesis becomes an operator/product.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from .web_search import SearchResult


@runtime_checkable
class SearchProvider(Protocol):
    """Protocol for pluggable search backends.

    Implementations must provide an async ``search`` method that returns
    a list of ``SearchResult`` objects. The ``engine`` field on each result
    is used to determine trust tier via the engine-authority map.
    """

    async def search(
        self,
        query: str,
        profile: str = "web",
        max_results: int | None = None,
    ) -> list[SearchResult]: ...
