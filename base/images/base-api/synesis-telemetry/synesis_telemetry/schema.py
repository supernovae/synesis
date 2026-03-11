"""Standard log event schema.

Every structured log emitted by Synesis services conforms to this shape.
The formatter produces it; log backends (Loki, Elastic) consume it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class LogEvent:
    """Canonical log event. Serialized to JSON by the formatter."""

    ts: str
    level: str
    service: str
    logger: str
    event: str
    run_id: str = ""
    user_id: str = ""
    node: str = ""
    data: dict[str, Any] = field(default_factory=dict)
