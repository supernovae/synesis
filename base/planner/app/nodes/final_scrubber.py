"""FinalScrubberNode — deterministic post-writer cleanup (no LLM).

Handles false precision labeling, duplicate paragraph removal, and
overgrown section detection.  A single safety-net pattern catches any
residual model artifacts that should no longer appear after the
DecisionRecord isolation boundary.  Fast (<100ms).
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

# Safety-net: combined pattern for artifacts that should NEVER appear after
# the DecisionRecord boundary (compiler uses enable_thinking=False and
# never sees raw Toulmin-labeled section text).
# If this fires, something upstream is broken — log a warning.
_SAFETY_NET_RE = re.compile(
    r"<think>.*?</think>"  # thinking blocks
    r"|^(?:CLAIM|GROUNDS|WARRANT|REBUTTAL|QUALIFIER)\s*:.*$"  # Toulmin labels
    r"|(?:Thought|Thinking) for (?:less than )?\w+ seconds?\.?\n*",  # "Thought for X seconds"
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

_SECTION_OVERGROWTH_WORDS = 1200


def _strip_artifacts(text: str) -> tuple[str, int]:
    """Strip self-narration and any safety-net matches."""
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
        line = text[line_start:m.end() + offset] if line_start >= 0 else ""
        if "|" in line:
            continue
        replacement = f"{m.group()} [Estimate]"
        text = text[:m.start() + offset] + replacement + text[m.end() + offset:]
        offset += len(" [Estimate]")
        count += 1
    return text, count


def _remove_duplicate_paragraphs(text: str) -> tuple[str, int]:
    """Remove paragraphs that are near-duplicates of earlier paragraphs."""
    paragraphs = text.split("\n\n")
    seen: list[str] = []
    result: list[str] = []
    removed = 0

    for para in paragraphs:
        stripped = para.strip()
        if not stripped:
            result.append(para)
            continue
        if stripped.startswith("#") or len(stripped) < 80:
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
    """Find sections exceeding the word limit."""
    headings = list(_HEADING_RE.finditer(text))
    if not headings:
        return []

    overgrown: list[str] = []
    for i, heading in enumerate(headings):
        start = heading.end()
        end = headings[i + 1].start() if i + 1 < len(headings) else len(text)
        section_text = text[start:end]
        word_count = len(section_text.split())
        if word_count > _SECTION_OVERGROWTH_WORDS:
            overgrown.append(f"{heading.group().strip()} ({word_count} words)")
    return overgrown


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
    overgrown = _detect_overgrown_sections(text)

    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    audit = FinalAnswerAudit(
        false_precision_count=fp_count,
        duplicate_paragraphs_removed=dup_count,
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
