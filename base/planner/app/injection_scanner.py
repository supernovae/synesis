"""Prompt-injection scanner — defense-in-depth for untrusted data.

Scans user messages, RAG context, web search results, conversation history,
execution feedback, and all other untrusted data for known injection patterns.
Only system prompts and graph state produced by our nodes are trusted.

Defense layers (Spotlighting + Instruction Hierarchy approach):
  1. Pattern scanning   — detect and redact known injection payloads (this module)
  2. Trust delimiters   — <context trust="untrusted"> tags around external data
  3. Instruction hierarchy — system prompt meta-instructions re: trust boundaries
  4. Datamarking        — [W]/[R] provenance prefixes per Spotlighting paper
  5. Output guardrail   — scan_model_output() for signs of injection compliance

Research references:
  - Spotlighting (Microsoft, arxiv 2403.14720): delimiting + datamarking
  - Prompt Fencing (arxiv 2511.19727): cryptographic trust boundaries
  - CaMeL (Google, arxiv 2503.18813): control/data flow separation
  - TrustRAG (arxiv 2501.00879): RAG corpus poisoning detection
  - SD-RAG (arxiv 2601.11199): sanitization at retrieval time
  - ICON (arxiv 2602.20708): inference-time correction
  - OWASP LLM Top 10 (2025): prompt injection (#1 risk)
"""

from __future__ import annotations

import base64
import logging
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("synesis.injection_scanner")

# ---------------------------------------------------------------------------
# Tier 1: Core injection patterns (user input, RAG, conversation history)
# Sources: OWASP, documented attacks, common obfuscations
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Tier 2: Extended patterns for web/external content (indirect injection)
# Covers obfuscation techniques attackers use in web pages and documents.
# ---------------------------------------------------------------------------
_WEB_INJECTION_PATTERNS = [
    # Encoded instruction attempts
    re.compile(r"base64[:\s]+[A-Za-z0-9+/=]{20,}", re.IGNORECASE),
    # Markdown/HTML link injection
    re.compile(r"\[.*?\]\(javascript\s*:", re.IGNORECASE),
    re.compile(r"<a\s+href\s*=\s*[\"']?javascript:", re.IGNORECASE),
    # Hidden text / invisible Unicode markers
    re.compile(r"[\u200b\u200c\u200d\u2060\ufeff]{3,}"),
    # Data URI payloads
    re.compile(r"data:text/html[;,]", re.IGNORECASE),
    # Prompt leaking attempts
    re.compile(r"(?:reveal|show|print|repeat|echo)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)", re.IGNORECASE),
    re.compile(r"what\s+(?:are|is)\s+your\s+(?:system\s+)?(?:prompt|instructions)", re.IGNORECASE),
    # Jailbreak framing
    re.compile(r"(?:DAN|developer)\s+mode\s+(?:enabled|activated|on)", re.IGNORECASE),
    re.compile(r"(?:do\s+anything\s+now|unlimited\s+mode)", re.IGNORECASE),
    # Role/persona hijacking via web content
    re.compile(r"from\s+now\s+on\s+(?:you\s+)?(?:are|will|must|should)\b", re.IGNORECASE),
    re.compile(r"(?:assistant|ai|model)\s*:\s*(?:sure|okay|yes|I will)", re.IGNORECASE),
    # XML/HTML comment injection
    re.compile(r"<!--\s*(?:system|instruction|prompt)", re.IGNORECASE),
]

# Zero-width and confusable characters used to evade pattern matching
_CONFUSABLE_MAP: dict[str, str] = {
    "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p",
    "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i",
    "\u04bb": "h", "\u0501": "d",
    "\uff49": "i", "\uff47": "g", "\uff4e": "n", "\uff4f": "o",
    "\uff52": "r", "\uff45": "e",
}


@dataclass
class ScanResult:
    """Result of injection scan on a text block."""

    detected: bool
    patterns_found: list[str]
    source: str
    excerpt: str = ""
    tier: str = "core"


def _normalize_confusables(text: str) -> str:
    """Replace Unicode homoglyphs (Cyrillic/fullwidth lookalikes) with ASCII.

    Attackers use visually identical Unicode chars to evade regex patterns
    (e.g., Cyrillic 'а' instead of Latin 'a' in "ignore previous instructions").
    """
    out: list[str] = []
    for ch in text:
        replacement = _CONFUSABLE_MAP.get(ch)
        if replacement:
            out.append(replacement)
        elif ord(ch) > 127:
            nfkd = unicodedata.normalize("NFKD", ch)
            ascii_approx = nfkd.encode("ascii", "ignore").decode("ascii")
            out.append(ascii_approx if ascii_approx else ch)
        else:
            out.append(ch)
    return "".join(out)


def _strip_zero_width(text: str) -> str:
    """Remove zero-width characters that can be used to split pattern matches."""
    return re.sub(r"[\u200b\u200c\u200d\u2060\ufeff]", "", text)


def _check_base64_payloads(text: str) -> list[str]:
    """Detect base64-encoded injection payloads hidden in web content."""
    findings: list[str] = []
    b64_re = re.compile(r"[A-Za-z0-9+/]{40,}={0,2}")
    for match in b64_re.finditer(text[:16_000]):
        try:
            decoded = base64.b64decode(match.group(0), validate=True).decode("utf-8", errors="ignore")
            if len(decoded) > 10:
                for pat in _INJECTION_PATTERNS:
                    if pat.search(decoded):
                        findings.append(f"base64_encoded:{pat.pattern[:60]}")
                        break
        except Exception:
            continue
    return findings


def _scan_with_patterns(
    text: str,
    patterns: list[re.Pattern],
    source: str,
    tier: str,
    max_scan_chars: int = 32_000,
) -> ScanResult:
    """Core scanner: run a list of compiled patterns against text."""
    if not text or not isinstance(text, str):
        return ScanResult(detected=False, patterns_found=[], source=source, tier=tier)

    to_scan = text[:max_scan_chars]
    patterns_found: list[str] = []

    for pat in patterns:
        match = pat.search(to_scan)
        if match:
            patterns_found.append(match.group(0)[:80])

    excerpt = ""
    if patterns_found:
        first_match = next(
            (m for p in patterns for m in [p.search(to_scan)] if m),
            None,
        )
        if first_match:
            start = max(0, first_match.start() - 50)
            end = min(len(to_scan), first_match.end() + 50)
            excerpt = to_scan[start:end].replace("\n", " ")

    return ScanResult(
        detected=len(patterns_found) > 0,
        patterns_found=patterns_found,
        source=source,
        excerpt=excerpt,
        tier=tier,
    )


def scan_text(text: str, source: str = "unknown", max_scan_chars: int = 32_000) -> ScanResult:
    """Scan text for Tier-1 (core) prompt-injection patterns.

    Used for user input, RAG chunks, and conversation history.
    """
    return _scan_with_patterns(text, _INJECTION_PATTERNS, source, tier="core", max_scan_chars=max_scan_chars)


def scan_web_content(text: str, source: str = "web", max_scan_chars: int = 32_000) -> ScanResult:
    """Scan web-sourced content with Tier-1 + Tier-2 (extended) patterns.

    Applies additional defenses for indirect injection via web pages:
      - Unicode homoglyph normalization (Cyrillic/fullwidth lookalikes)
      - Zero-width character stripping (split-pattern evasion)
      - Base64-encoded payload detection
      - Extended pattern set for jailbreaks, prompt leaking, role hijacking

    Returns ScanResult with tier="web".
    """
    if not text or not isinstance(text, str):
        return ScanResult(detected=False, patterns_found=[], source=source, tier="web")

    cleaned = _strip_zero_width(text)
    normalized = _normalize_confusables(cleaned)

    core = _scan_with_patterns(normalized, _INJECTION_PATTERNS, source, "web", max_scan_chars)
    extended = _scan_with_patterns(normalized, _WEB_INJECTION_PATTERNS, source, "web_extended", max_scan_chars)

    b64_findings = _check_base64_payloads(text[:max_scan_chars])

    all_patterns = core.patterns_found + extended.patterns_found + b64_findings
    detected = len(all_patterns) > 0
    excerpt = core.excerpt or extended.excerpt

    if detected:
        logger.warning(
            "injection_scan_web_content",
            extra={"source": source, "patterns": all_patterns[:5], "excerpt": excerpt[:200]},
        )

    return ScanResult(
        detected=detected,
        patterns_found=all_patterns,
        source=source,
        excerpt=excerpt,
        tier="web",
    )


def reduce_context_on_injection(text: str, pattern_match: str) -> str:
    """Reduce context by redacting spans around injection patterns.

    Conservative: replace matching substring with [REDACTED].
    Applies both Tier-1 and Tier-2 patterns.
    """
    for pat in _INJECTION_PATTERNS + _WEB_INJECTION_PATTERNS:
        text = pat.sub("[REDACTED]", text)
    return text


def scan_and_sanitize_web_results(
    texts: list[str],
    action: str = "reduce",
) -> tuple[list[str], bool, list[dict[str, Any]]]:
    """Scan web search results (snippets/fetched content) and sanitize.

    Like scan_and_filter_rag_context but uses the extended web scanner.
    Returns (sanitized_texts, any_detected, details).
    """
    sanitized: list[str] = []
    any_detected = False
    details: list[dict[str, Any]] = []

    for i, text in enumerate(texts):
        if not text:
            sanitized.append(text)
            continue
        r = scan_web_content(text, source=f"web_result_{i}")
        if r.detected:
            any_detected = True
            details.append({"index": i, "patterns": r.patterns_found, "source": r.source})
            if action == "reduce":
                sanitized.append(reduce_context_on_injection(text, ""))
            elif action == "block":
                continue
            else:
                sanitized.append(text)
        else:
            sanitized.append(text)

    return sanitized, any_detected, details


# ---------------------------------------------------------------------------
# Output guardrail: detect signs of injection compliance in model output
# ---------------------------------------------------------------------------

_OUTPUT_INJECTION_SIGNS = [
    re.compile(r"^system\s*:", re.IGNORECASE | re.MULTILINE),
    re.compile(r"(?:my|the)\s+system\s+prompt\s+(?:is|says|reads)", re.IGNORECASE),
    re.compile(r"(?:here\s+(?:is|are)\s+)?my\s+(?:original\s+)?instructions?:", re.IGNORECASE),
    re.compile(r"I\s+(?:will|can|shall)\s+now\s+(?:act|behave|operate)\s+as", re.IGNORECASE),
    re.compile(r"(?:DAN|developer)\s+mode\s+(?:enabled|activated)", re.IGNORECASE),
    re.compile(r"<\|im_start\|>", re.IGNORECASE),
]


def scan_model_output(output: str, source: str = "model_output") -> ScanResult:
    """Lightweight check for signs the model followed injected instructions.

    Looks for prompt leakage, unexpected role changes, and jailbreak compliance.
    This is a post-generation guardrail -- the last line of defense.
    """
    return _scan_with_patterns(output, _OUTPUT_INJECTION_SIGNS, source, tier="output", max_scan_chars=16_000)


# ---------------------------------------------------------------------------
# Existing API: user input + RAG scanning
# ---------------------------------------------------------------------------

def scan_user_input(
    user_content: str,
    conversation_history: list[str],
) -> tuple[bool, dict[str, Any]]:
    """Scan all user-facing input at API entry.

    Returns (detected, scan_result_dict for state).
    """
    results: list[ScanResult] = []

    if user_content:
        r = scan_text(user_content, source="user_message")
        results.append(r)
        if r.detected:
            logger.warning(
                "injection_scan_user_message",
                extra={"patterns": r.patterns_found, "excerpt": r.excerpt[:200]},
            )

    for i, turn in enumerate(conversation_history[-5:]):
        r = scan_text(turn, source=f"conversation_history_{i}")
        results.append(r)
        if r.detected:
            logger.warning(
                "injection_scan_conversation",
                extra={"patterns": r.patterns_found, "turn_index": i},
            )

    any_detected = any(r.detected for r in results)
    scan_result = {
        "detected": any_detected,
        "sources_scanned": [r.source for r in results],
        "patterns_found": list({p for r in results for p in r.patterns_found}),
        "details": [{"source": r.source, "patterns": r.patterns_found} for r in results if r.detected],
    }
    return any_detected, scan_result


def scan_and_filter_rag_context(
    rag_chunks: list[str],
    action: str = "reduce",
) -> tuple[list[str], bool, list[dict[str, Any]]]:
    """Scan RAG chunks for injection; filter or redact based on action.

    Returns (filtered_chunks, any_detected, details_for_logging).
    """
    filtered: list[str] = []
    any_detected = False
    details: list[dict[str, Any]] = []

    for i, chunk in enumerate(rag_chunks):
        if not chunk:
            filtered.append(chunk)
            continue
        r = scan_text(chunk, source=f"rag_chunk_{i}")
        if r.detected:
            any_detected = True
            details.append({"index": i, "patterns": r.patterns_found})
            if action == "reduce":
                filtered.append(reduce_context_on_injection(chunk, ""))
            elif action == "block":
                continue
            else:
                filtered.append(chunk)
        else:
            filtered.append(chunk)

    return filtered, any_detected, details
