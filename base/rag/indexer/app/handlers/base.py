"""Base handler protocol and shared dataclasses for the unified indexer."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass
class RawDocument:
    """A fetched document before parsing/chunking."""

    doc_id: str
    name: str
    content: str | bytes
    source_url: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class Chunk:
    """A chunk produced by a handler's parse_and_chunk method."""

    text: str
    section: str = ""
    heading_path: str = ""
    chunk_index: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class BaseHandler(Protocol):
    """Protocol that all handler plugins must implement."""

    handler_type: str
    source_type: str

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        """Fetch documents from the configured source. Returns raw documents."""
        ...

    def parse_and_chunk(self, doc: RawDocument) -> list[Chunk]:
        """Parse a raw document and split into chunks."""
        ...
