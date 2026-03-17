"""Lightweight injection scanner for index-time chunk screening.

Mirrors the Tier-1 core patterns from the planner's injection_scanner.py.
Scans each chunk at ingest time and returns a scan_status ('clean' or 'flagged')
stored in Milvus for the admin review queue.

This is intentionally a standalone copy (not an import from the planner service)
because the indexer runs as a separate container/CronJob.
"""

from __future__ import annotations

import re

_INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?", re.IGNORECASE),
    re.compile(r"disregard\s+(?:all\s+)?(?:previous|prior|above)", re.IGNORECASE),
    re.compile(r"forget\s+(?:everything|all)\s+(?:you\s+)?(?:were\s+)?told", re.IGNORECASE),
    re.compile(r"new\s+instructions?\s*:", re.IGNORECASE),
    re.compile(r"override\s+(?:your\s+)?(?:instructions?|prompt)", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+(?:a|an)\s", re.IGNORECASE),
    re.compile(r"pretend\s+you\s+are", re.IGNORECASE),
    re.compile(r"act\s+as\s+if\s+you", re.IGNORECASE),
    re.compile(r"system\s*:\s*", re.IGNORECASE),
    re.compile(r"<\|im_start\|>\s*system", re.IGNORECASE),
    re.compile(r"###\s*human\s*:", re.IGNORECASE),
    re.compile(r"\[INST\]\s*", re.IGNORECASE),
    re.compile(r"<\/?s(?:ystem)?>", re.IGNORECASE),
    re.compile(r"ignore\s+the\s+above", re.IGNORECASE),
    re.compile(r"ignore\s+above\b", re.IGNORECASE),
    re.compile(r"follow\s+these\s+instructions?\s+instead", re.IGNORECASE),
    re.compile(r"output\s+(?:only|just)\s+the\s+following", re.IGNORECASE),
    re.compile(r"print\s+(?:exactly|only)\s+this\s*:", re.IGNORECASE),
]


def scan_chunk_text(text: str, max_scan_chars: int = 32_000) -> str:
    """Scan a chunk for Tier-1 injection patterns.

    Returns 'flagged' if any pattern matches, 'clean' otherwise.
    """
    sample = text[:max_scan_chars].lower()
    for pat in _INJECTION_PATTERNS:
        if pat.search(sample):
            return "flagged"
    return "clean"
