"""Lightweight injection scanner for index-time chunk screening.

Mirrors the Tier-1 core patterns from the planner's injection_scanner.py.
Scans each chunk at ingest time and returns a scan_status ('clean' or 'flagged')
stored in Milvus for the admin review queue.

This is intentionally a standalone copy (not an import from the planner service)
because the indexer runs as a separate container/CronJob.
"""

from __future__ import annotations

import re

NAMED_INJECTION_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "ignore_previous_instructions",
        re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?", re.IGNORECASE),
    ),
    ("disregard_previous", re.compile(r"disregard\s+(?:all\s+)?(?:previous|prior|above)", re.IGNORECASE)),
    ("forget_everything", re.compile(r"forget\s+(?:everything|all)\s+(?:you\s+)?(?:were\s+)?told", re.IGNORECASE)),
    ("new_instructions", re.compile(r"new\s+instructions?\s*:", re.IGNORECASE)),
    ("override_instructions", re.compile(r"override\s+(?:your\s+)?(?:instructions?|prompt)", re.IGNORECASE)),
    ("role_hijack_you_are_now", re.compile(r"you\s+are\s+now\s+(?:a|an)\s", re.IGNORECASE)),
    ("role_hijack_pretend", re.compile(r"pretend\s+you\s+are", re.IGNORECASE)),
    ("role_hijack_act_as", re.compile(r"act\s+as\s+if\s+you", re.IGNORECASE)),
    ("system_prompt_marker", re.compile(r"system\s*:\s*", re.IGNORECASE)),
    ("chatml_system_tag", re.compile(r"<\|im_start\|>\s*system", re.IGNORECASE)),
    ("markdown_human_prompt", re.compile(r"###\s*human\s*:", re.IGNORECASE)),
    ("llama_inst_tag", re.compile(r"\[INST\]\s*", re.IGNORECASE)),
    ("xml_system_tag", re.compile(r"<\/?s(?:ystem)?>", re.IGNORECASE)),
    ("ignore_the_above", re.compile(r"ignore\s+the\s+above", re.IGNORECASE)),
    ("ignore_above", re.compile(r"ignore\s+above\b", re.IGNORECASE)),
    ("follow_instead", re.compile(r"follow\s+these\s+instructions?\s+instead", re.IGNORECASE)),
    ("output_only_following", re.compile(r"output\s+(?:only|just)\s+the\s+following", re.IGNORECASE)),
    ("print_exactly_this", re.compile(r"print\s+(?:exactly|only)\s+this\s*:", re.IGNORECASE)),
]


def scan_chunk_text(text: str, max_scan_chars: int = 32_000) -> str:
    """Scan a chunk for Tier-1 injection patterns.

    Returns 'flagged' if any pattern matches, 'clean' otherwise.
    """
    sample = text[:max_scan_chars].lower()
    for _name, pat in NAMED_INJECTION_PATTERNS:
        if pat.search(sample):
            return "flagged"
    return "clean"


def scan_chunk_text_detailed(text: str, max_scan_chars: int = 32_000) -> tuple[str, list[str]]:
    """Scan a chunk and return (status, [matched_pattern_names]).

    Used by the admin review API to explain *why* a chunk was flagged.
    """
    sample = text[:max_scan_chars].lower()
    matched: list[str] = []
    for name, pat in NAMED_INJECTION_PATTERNS:
        if pat.search(sample):
            matched.append(name)
    return ("flagged" if matched else "clean", matched)
