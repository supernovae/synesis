"""Extract fenced code blocks from markdown for sandbox execution.

Replaces the JSON-wrapper output pipeline (StreamingCodeExtractor + validator).
The Worker now produces plain markdown; this utility extracts actionable code
blocks for the sandbox path.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class CodeBlock:
    """A single fenced code block extracted from markdown."""

    language: str = ""
    path: str = ""
    code: str = ""


_FENCE_RE = re.compile(
    r"```(\w+)?(?::(\S+))?\s*\n(.*?)```",
    re.DOTALL,
)

_NEEDS_INPUT_PHRASES = (
    "i need more information",
    "could you provide",
    "could you please provide",
    "could you clarify",
    "could you please clarify",
    "please specify",
    "please provide",
    "what would you like",
    "i need to know",
    "can you tell me",
    "before i can proceed",
    "i need clarification",
)

_STOP_REASON_MAP: dict[str, str] = {
    "i cannot proceed": "blocked_external",
    "missing dependency": "blocked_external",
    "missing credential": "blocked_external",
    "cannot reproduce": "cannot_reproduce",
    "environment mismatch": "cannot_reproduce",
    "unsafe request": "unsafe_request",
    "conflicts with safety": "unsafe_request",
    "security policy": "unsafe_request",
    "not in the execution plan": "needs_scope_expansion",
    "outside the scope": "needs_scope_expansion",
}


def extract_code_blocks(markdown: str) -> list[CodeBlock]:
    """Extract all fenced code blocks from markdown.

    Supports:
    - ```python\\ncode\\n```
    - ```python:path/to/file.py\\ncode\\n```
    """
    blocks: list[CodeBlock] = []
    for m in _FENCE_RE.finditer(markdown):
        lang = (m.group(1) or "").strip()
        path = (m.group(2) or "").strip()
        code = (m.group(3) or "").strip()
        if code:
            blocks.append(CodeBlock(language=lang, path=path, code=code))
    return blocks


def extract_primary_code(
    markdown: str,
    target_language: str = "",
) -> str:
    """Extract the primary code from markdown for sandbox execution.

    Prefers blocks matching target_language; falls back to all blocks.
    Skips tiny output blocks (single-word, shell prompts, etc.).
    """
    blocks = extract_code_blocks(markdown)
    if not blocks:
        return ""

    skip_langs = {"", "text", "output", "console"}
    code_blocks = [b for b in blocks if b.language.lower() not in skip_langs]
    if not code_blocks:
        code_blocks = blocks

    if target_language:
        lang_lower = target_language.lower()
        matching = [b for b in code_blocks if b.language.lower() == lang_lower]
        if matching:
            return "\n\n".join(b.code for b in matching)

    return "\n\n".join(b.code for b in code_blocks)


def extract_files_touched(markdown: str) -> list[str]:
    """Extract file paths from code block headers (```lang:path/file.py)."""
    blocks = extract_code_blocks(markdown)
    paths = []
    seen: set[str] = set()
    for b in blocks:
        if b.path and b.path not in seen:
            seen.add(b.path)
            paths.append(b.path)
    return paths


def extract_patch_ops(markdown: str) -> list[dict[str, str]]:
    """Build patch_ops from file-headed code blocks for multi-file tasks."""
    blocks = extract_code_blocks(markdown)
    ops = []
    for b in blocks:
        if b.path and b.code:
            ops.append({"path": b.path, "op": "modify", "text": b.code})
    return ops


def detect_needs_input(content: str) -> tuple[bool, str]:
    """Detect if the LLM is asking for more information."""
    lower = content.strip().lower()[:500]
    for phrase in _NEEDS_INPUT_PHRASES:
        if phrase in lower:
            first_para = content.strip().split("\n\n")[0]
            return True, first_para.strip()[:500]
    return False, ""


def detect_stop_reason(content: str) -> str:
    """Detect stop_reason signals from markdown output.

    Returns a valid stop_reason string or empty.
    """
    lower = content.strip().lower()[:600]
    for phrase, reason in _STOP_REASON_MAP.items():
        if phrase in lower:
            return reason
    return ""
