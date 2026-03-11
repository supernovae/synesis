"""FinalScrubberNode — deterministic post-writer cleanup (no LLM).

Handles false precision labeling, duplicate paragraph removal, and
overgrown section detection.  A single safety-net pattern catches any
residual model artifacts that should not appear in user-facing output.
Fast (<100ms).
"""

from __future__ import annotations

import logging
import re
import time
from difflib import SequenceMatcher
from typing import Any

from ..schemas import FinalAnswerAudit
from ..state import NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.final_scrubber")

# Safety-net: combined pattern for artifacts that should NEVER appear in
# user-facing output (compiler uses enable_thinking=False).
# If this fires, something upstream is broken — log a warning.
_SAFETY_NET_RE = re.compile(
    r"<think>.*?</think>"  # thinking blocks
    r"|^(?:CLAIM|GROUNDS|WARRANT|REBUTTAL|QUALIFIER)\s*:.*$"  # Toulmin labels
    r"|(?:Thought|Thinking) for (?:less than )?\w+ seconds?\.?\n*"  # "Thought for X seconds"
    r"|<!--\s*section:.*?-->\s*",  # internal section markers (legacy)
    re.DOTALL | re.MULTILINE | re.IGNORECASE,
)

_SELF_NARRATION_RE = re.compile(
    r"^(Okay,? (?:I need|let me|let's)|Let me (?:start|think|tackle)|"
    r"Wait, |Hmm,? |Now,? I need |"
    r"Putting it all together|I need to ).*?(?:\n\n|\Z)",
    re.MULTILINE | re.DOTALL,
)

# False Precision Guard: detect unsupported specific numbers
_FALSE_PRECISION_RE = re.compile(
    r"(?<!\[Estimate\]\s)"
    r"(?:"
    r"~?\d{1,3}(?:\.\d+)?%"
    r"|\$[\d,]+(?:\.\d{2})?"
    r"|(?:~?\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|minutes?|hours?))"
    r"|(?:\d+(?:\.\d+)?x\s+(?:faster|slower|improvement|reduction|increase))"
    r")",
    re.IGNORECASE,
)

_HEADING_RE = re.compile(r"^#{1,3}\s+.+$", re.MULTILINE)
_FENCED_BLOCK_RE = re.compile(r"```[^\n]*\n.*?```", re.DOTALL)

_SECTION_OVERGROWTH_WORDS = 1200


def _strip_fenced_blocks(text: str) -> str:
    """Remove fenced code/diagram blocks for prose-only word counting.

    Diagrams (mermaid, etc.) and code examples should not inflate word counts
    or trigger overgrown-section warnings. This is used only for counting;
    the actual output text is never modified by this function.
    """
    return _FENCED_BLOCK_RE.sub("", text)


# Sources section validation patterns
_SOURCES_HEADING_RE = re.compile(r"^##\s+Sources\s*$", re.MULTILINE)
_INLINE_REF_RE = re.compile(r"\[(\d+)\]")
_SOURCE_LINE_RE = re.compile(r"^\[(\d+)\]\s+.+", re.MULTILINE)
_AUTHORITY_BADGE_RE = re.compile(r"\[(Canonical|Vetted|Community|External)\]", re.IGNORECASE)


def _protect_fenced_blocks(text: str) -> tuple[str, list[str]]:
    """Replace fenced code blocks with placeholders to protect them from regex cleanup."""
    blocks: list[str] = []

    def _stash(m: re.Match) -> str:
        blocks.append(m.group(0))
        return f"\x00FENCED{len(blocks) - 1}\x00"

    return _FENCED_BLOCK_RE.sub(_stash, text), blocks


def _restore_fenced_blocks(text: str, blocks: list[str]) -> str:
    """Restore fenced code blocks from placeholders."""
    for i, block in enumerate(blocks):
        text = text.replace(f"\x00FENCED{i}\x00", block)
    return text


def _strip_artifacts(text: str) -> tuple[str, int]:
    """Strip self-narration and any safety-net matches.

    Fenced code blocks (including mermaid diagrams) are protected.
    """
    text, blocks = _protect_fenced_blocks(text)
    count = 0

    safety_matches = _SAFETY_NET_RE.findall(text)
    if safety_matches:
        count += len(safety_matches)
        logger.warning(
            "scrubber_safety_net_fired",
            extra={"matches": len(safety_matches), "sample": str(safety_matches[0])[:120]},
        )
        text = _SAFETY_NET_RE.sub("", text)

    narration_matches = _SELF_NARRATION_RE.findall(text)
    count += len(narration_matches)
    text = _SELF_NARRATION_RE.sub("", text)

    text = re.sub(r"\n{3,}", "\n\n", text)
    text = _restore_fenced_blocks(text, blocks)
    return text.strip(), count


def _detect_false_precision(text: str) -> tuple[str, int]:
    """Find unsupported specific numbers and label them as estimates."""
    code_block_ranges: list[tuple[int, int]] = []
    for m in re.finditer(r"```.*?```", text, re.DOTALL):
        code_block_ranges.append((m.start(), m.end()))

    def _in_code_block(pos: int) -> bool:
        return any(s <= pos < e for s, e in code_block_ranges)

    count = 0
    offset = 0
    for m in _FALSE_PRECISION_RE.finditer(text):
        if _in_code_block(m.start()):
            continue
        line_start = text.rfind("\n", 0, m.start() + offset)
        line = text[line_start : m.end() + offset] if line_start >= 0 else ""
        if "|" in line:
            continue
        replacement = f"{m.group()} [Estimate]"
        text = text[: m.start() + offset] + replacement + text[m.end() + offset :]
        offset += len(" [Estimate]")
        count += 1
    return text, count


def _remove_duplicate_paragraphs(text: str) -> tuple[str, int]:
    """Remove paragraphs that are near-duplicates of earlier paragraphs.

    Fenced code/diagram blocks are always preserved — never treated as
    duplicate prose even if they appear similar.
    """
    paragraphs = text.split("\n\n")
    seen: list[str] = []
    result: list[str] = []
    removed = 0

    for para in paragraphs:
        stripped = para.strip()
        if not stripped:
            result.append(para)
            continue
        if stripped.startswith("```") or stripped.startswith("#") or len(stripped) < 80:
            seen.append(stripped)
            result.append(para)
            continue
        is_dup = False
        for prev in seen:
            if SequenceMatcher(None, stripped, prev).ratio() > 0.85:
                is_dup = True
                removed += 1
                break
        if not is_dup:
            seen.append(stripped)
            result.append(para)

    return "\n\n".join(result), removed


def _detect_overgrown_sections(text: str) -> list[str]:
    """Find sections exceeding the word limit.

    Fenced code/diagram blocks are excluded from the word count so that
    mermaid diagrams and code examples don't trigger false overgrowth warnings.
    """
    headings = list(_HEADING_RE.finditer(text))
    if not headings:
        return []

    overgrown: list[str] = []
    for i, heading in enumerate(headings):
        start = heading.end()
        end = headings[i + 1].start() if i + 1 < len(headings) else len(text)
        section_text = text[start:end]
        prose_only = _strip_fenced_blocks(section_text)
        word_count = len(prose_only.split())
        if word_count > _SECTION_OVERGROWTH_WORDS:
            overgrown.append(f"{heading.group().strip()} ({word_count} words)")
    return overgrown


def _validate_sources_section(text: str) -> tuple[str, int]:
    """Validate the ## Sources section: strip uncited sources, normalize badges.

    If no inline [N] citations exist anywhere in the body, the Sources
    section is kept as-is (it's provenance-based, not LLM-hallucinated).
    Only prune individual sources when inline citations ARE present but
    don't reference them.

    Returns (cleaned_text, sources_removed_count).
    """
    sources_match = _SOURCES_HEADING_RE.search(text)
    if not sources_match:
        return text, 0

    body_before_sources = text[: sources_match.start()]
    sources_section = text[sources_match.start() :]

    # Find all inline refs [N] in the body (before Sources heading)
    cited_nums = set(_INLINE_REF_RE.findall(body_before_sources))

    # If no inline citations exist, keep the full Sources section
    # (it was built from retrieval provenance, not LLM output)
    if not cited_nums:
        normalized = _AUTHORITY_BADGE_RE.sub(lambda m: f"[{m.group(1).title()}]", sources_section)
        return body_before_sources.rstrip() + "\n\n" + normalized.strip() + "\n", 0

    # Inline citations exist — prune sources not referenced
    source_lines = _SOURCE_LINE_RE.findall(sources_section)
    kept_lines: list[str] = []
    removed = 0
    for line in source_lines:
        line_match = re.match(r"^\[(\d+)\]", line)
        if line_match and line_match.group(1) in cited_nums:
            normalized = _AUTHORITY_BADGE_RE.sub(lambda m: f"[{m.group(1).title()}]", line)
            kept_lines.append(normalized)
        else:
            removed += 1

    if not kept_lines:
        return body_before_sources.rstrip() + "\n", removed

    new_sources = "## Sources\n\n" + "\n".join(kept_lines) + "\n"
    return body_before_sources.rstrip() + "\n\n" + new_sources, removed


async def final_scrubber_node(state: dict[str, Any]) -> dict[str, Any]:
    """Deterministic scrubber — no LLM, fast cleanup of compiler output."""
    start = time.monotonic()
    node_name = "final_scrubber"

    text = state.get("compiled_answer") or state.get("generated_code", "")
    if not text:
        return {
            "scrubbed_answer": "",
            "current_node": node_name,
        }

    text, artifact_count = _strip_artifacts(text)
    text, fp_count = _detect_false_precision(text)
    text, dup_count = _remove_duplicate_paragraphs(text)
    text, sources_removed = _validate_sources_section(text)
    overgrown = _detect_overgrown_sections(text)

    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    audit = FinalAnswerAudit(
        false_precision_count=fp_count,
        duplicate_paragraphs_removed=dup_count,
        uncited_sources_removed=sources_removed,
        overgrown_sections=overgrown,
        scrubber_applied=True,
    )

    latency = (time.monotonic() - start) * 1000
    logger.info(
        "scrubber_complete",
        extra={
            "artifacts_stripped": artifact_count,
            "false_precision": fp_count,
            "duplicates_removed": dup_count,
            "uncited_sources_removed": sources_removed,
            "overgrown_sections": len(overgrown),
            "output_len": len(text),
            "latency_ms": round(latency, 1),
        },
    )

    return {
        "scrubbed_answer": text,
        "final_answer_audit": audit.model_dump(),
        "current_node": node_name,
        "node_traces": [
            NodeTrace(
                node_name=node_name,
                reasoning=f"Scrubbed: {artifact_count} artifacts, {fp_count} false precision, {dup_count} dupes",
                confidence=1.0,
                outcome=NodeOutcome.SUCCESS,
                latency_ms=latency,
            )
        ],
    }
