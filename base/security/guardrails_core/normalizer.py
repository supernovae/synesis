"""Text normalization for evasion-resistant pattern matching.

Handles Unicode homoglyphs (Cyrillic/fullwidth lookalikes), zero-width
character stripping, and base64-encoded payload detection.
"""

from __future__ import annotations

import base64
import re
import unicodedata

_CONFUSABLE_MAP: dict[str, str] = {
    "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p",
    "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i",
    "\u04bb": "h", "\u0501": "d",
    "\uff49": "i", "\uff47": "g", "\uff4e": "n", "\uff4f": "o",
    "\uff52": "r", "\uff45": "e",
}

_ZERO_WIDTH_RE = re.compile(r"[\u200b\u200c\u200d\u2060\ufeff]")
_B64_CANDIDATE_RE = re.compile(r"[A-Za-z0-9+/]{40,}={0,2}")


def normalize_confusables(text: str) -> str:
    """Replace Unicode homoglyphs with ASCII equivalents."""
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


def strip_zero_width(text: str) -> str:
    """Remove zero-width characters that split pattern matches."""
    return _ZERO_WIDTH_RE.sub("", text)


def normalize_for_scan(text: str) -> str:
    """Full normalization pipeline: zero-width strip + confusable replacement."""
    return normalize_confusables(strip_zero_width(text))


def detect_base64_payloads(text: str, probe_patterns: list[re.Pattern[str]], max_chars: int = 16_000) -> list[str]:
    """Decode base64 blobs and probe for injection patterns inside them."""
    findings: list[str] = []
    for match in _B64_CANDIDATE_RE.finditer(text[:max_chars]):
        try:
            decoded = base64.b64decode(match.group(0), validate=True).decode("utf-8", errors="ignore")
            if len(decoded) > 10:
                for pat in probe_patterns:
                    if pat.search(decoded):
                        findings.append(f"base64_encoded:{pat.pattern[:60]}")
                        break
        except Exception:
            continue
    return findings
