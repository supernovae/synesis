"""Unified pattern scanner — merged from Planner and Yarn injection scanners.

Three tiers of compiled patterns:
  Tier 1 (core): instruction override, jailbreak, template injection
  Tier 2 (web/indirect): encoded payloads, link injection, hidden text, prompt leaking
  Tier 3 (output): signs the model complied with an injection
"""

from __future__ import annotations

import re
import time
from typing import Any

from .normalizer import detect_base64_payloads, normalize_for_scan
from .schemas import EventType, ScanResult

# ---------------------------------------------------------------------------
# Tier 1: Core injection patterns
# ---------------------------------------------------------------------------
CORE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?", re.IGNORECASE),
    re.compile(r"disregard\s+(?:all\s+)?(?:previous|prior|above)", re.IGNORECASE),
    re.compile(r"forget\s+(?:everything|all)\s+(?:you\s+)?(?:were\s+)?told", re.IGNORECASE),
    re.compile(r"new\s+instructions?\s*:", re.IGNORECASE),
    re.compile(r"override\s+(?:your\s+)?(?:instructions?|prompt)", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+(?:a|an)\s", re.IGNORECASE),
    re.compile(r"pretend\s+you\s+are", re.IGNORECASE),
    re.compile(r"act\s+as\s+if\s+you", re.IGNORECASE),
    re.compile(
        r"(?:^|\n)\s*system\s*:\s*(?:ignore|disregard|forget|override|follow\s+these\s+instructions|you\s+are\s+now|pretend|act\s+as)",
        re.IGNORECASE,
    ),
    re.compile(r"<\|im_start\|>\s*system", re.IGNORECASE),
    re.compile(r"###\s*human\s*:", re.IGNORECASE),
    re.compile(r"\[INST\]\s*", re.IGNORECASE),
    re.compile(r"<\/?s(?:ystem)?>", re.IGNORECASE),
    re.compile(r"ignore\s+the\s+above", re.IGNORECASE),
    re.compile(r"ignore\s+above\b", re.IGNORECASE),
    re.compile(r"follow\s+these\s+instructions?\s+instead", re.IGNORECASE),
    re.compile(r"output\s+(?:only|just)\s+the\s+following", re.IGNORECASE),
    re.compile(r"print\s+(?:exactly|only)\s+this\s*:", re.IGNORECASE),
    re.compile(r"(?:DAN|developer)\s+mode\s+(?:enabled|activated|on)", re.IGNORECASE),
    re.compile(r"(?:do\s+anything\s+now|unlimited\s+mode)", re.IGNORECASE),
    re.compile(
        r"\b(?:send|post|upload|exfiltrate|leak|forward|transmit)\b[\s\S]{0,120}\b(?:secrets?|tokens?|api[_ -]?keys?|passwords?|credentials?|\.env|private\s+keys?)\b[\s\S]{0,120}\b(?:https?:\/\/|webhook|external|remote|attacker|requestbin|pastebin)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:read|open|cat|print|dump|show)\b[\s\S]{0,80}\b(?:\.env\b|~\/\.ssh|id_rsa|id_ed25519|private[_ -]?key|aws[_ -]?credentials|kubeconfig|\/etc\/passwd)\b",
        re.IGNORECASE,
    ),
]

# ---------------------------------------------------------------------------
# Tier 2: Extended patterns (web, indirect injection, obfuscation)
# ---------------------------------------------------------------------------
WEB_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"base64[:\s]+[A-Za-z0-9+/=]{20,}", re.IGNORECASE),
    re.compile(r"\[[^\]\r\n]{0,2048}\]\(\s*javascript\s*:", re.IGNORECASE),
    re.compile(r"<a\b[^>\r\n]{0,2048}\bhref\s*=\s*[\"']?\s*javascript:", re.IGNORECASE),
    re.compile(r"[\u200b\u200c\u200d\u2060\ufeff]{3,}"),
    re.compile(r"data:text/html[;,]", re.IGNORECASE),
    re.compile(r"(?:reveal|show|print|repeat|echo)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)", re.IGNORECASE),
    re.compile(r"what\s+(?:are|is)\s+your\s+(?:system\s+)?(?:prompt|instructions)", re.IGNORECASE),
    re.compile(r"from\s+now\s+on\s+(?:you\s+)?(?:are|will|must|should)\b", re.IGNORECASE),
    re.compile(r"(?:assistant|ai|model)\s*:\s*(?:sure|okay|yes|I will)", re.IGNORECASE),
    re.compile(r"<!--\s*(?:system|instruction|prompt)", re.IGNORECASE),
    re.compile(
        r"(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0)[^<\n]{0,240}(?:ignore|system|instruction|prompt)",
        re.IGNORECASE,
    ),
    re.compile(
        r"!\[[^\]\r\n]{0,2048}\]\(\s*https?:\/\/[^\s)]{0,2048}(?:token|secret|api[_-]?key|password|env)=", re.IGNORECASE
    ),
]

# ---------------------------------------------------------------------------
# Tier 3: Output compliance indicators
# ---------------------------------------------------------------------------
OUTPUT_PATTERNS: list[re.Pattern[str]] = [
    re.compile(
        r"(?:^|\n)\s*system\s*:\s*(?:you\s+are|ignore|disregard|forget|override|follow\s+these\s+instructions)",
        re.IGNORECASE,
    ),
    re.compile(r"(?:my|the)\s+system\s+prompt\s+(?:is|says|reads)", re.IGNORECASE),
    re.compile(r"(?:here\s+(?:is|are)\s+)?my\s+(?:original\s+)?instructions?:", re.IGNORECASE),
    re.compile(r"I\s+(?:will|can|shall)\s+now\s+(?:act|behave|operate)\s+as", re.IGNORECASE),
    re.compile(r"(?:DAN|developer)\s+mode\s+(?:enabled|activated)", re.IGNORECASE),
    re.compile(r"<\|im_start\|>", re.IGNORECASE),
    re.compile(
        r"\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|NPM_TOKEN|DATABASE_URL)\s*[:=]\s*['\"]?[A-Za-z0-9_./+=:-]{12,}",
        re.IGNORECASE,
    ),
    re.compile(r"-----BEGIN\s+(?:RSA\s+|OPENSSH\s+|EC\s+|DSA\s+)?PRIVATE\s+KEY-----", re.IGNORECASE),
    re.compile(r"\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b", re.IGNORECASE),
    re.compile(
        r"!\[[^\]\r\n]{0,2048}\]\(\s*https?:\/\/[^\s)]{0,2048}(?:token|secret|api[_-]?key|password|env)=", re.IGNORECASE
    ),
]

CODE_NOISE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"^(show|print|repeat|echo)\s+(?:system\s+)?prompt$", re.IGNORECASE),
    re.compile(r"^(show|print|repeat|echo)\s+instructions?$", re.IGNORECASE),
]


def _classify_patterns(patterns_found: list[str]) -> EventType:
    """Heuristic mapping from matched pattern strings to event type."""
    joined = " ".join(patterns_found).lower()
    if any(
        w in joined
        for w in (
            "secret",
            "token",
            "api",
            "password",
            "credential",
            ".env",
            "private",
            "id_rsa",
            "id_ed25519",
            "kubeconfig",
        )
    ):
        if any(
            w in joined
            for w in (
                "http",
                "webhook",
                "external",
                "remote",
                "attacker",
                "requestbin",
                "pastebin",
                "upload",
                "exfiltrate",
            )
        ):
            return EventType.DATA_EXFILTRATION
        return EventType.CREDENTIAL_EXFIL
    if any(w in joined for w in ("ignore", "disregard", "override", "new instructions")):
        return EventType.SYSTEM_OVERRIDE
    if any(w in joined for w in ("dan", "pretend", "act as", "you are now", "unlimited")):
        return EventType.JAILBREAK_ROLEPLAY
    if any(w in joined for w in ("reveal", "show", "print", "repeat", "echo", "prompt", "instructions")):
        return EventType.PROMPT_LEAKAGE
    if any(w in joined for w in ("base64", "javascript", "data:text")):
        return EventType.CODE_EXEC_RISK
    if "im_start" in joined or "inst" in joined or "system:" in joined:
        return EventType.CONTEXT_CONFUSION
    return EventType.UNKNOWN


def _run_patterns(
    text: str,
    patterns: list[re.Pattern[str]],
    max_chars: int = 32_000,
) -> list[str]:
    found: list[str] = []
    chunk = text[:max_chars]
    for pat in patterns:
        m = pat.search(chunk)
        if m:
            found.append(m.group(0)[:80])
    return found


def _excerpt_around(text: str, patterns: list[re.Pattern[str]], max_chars: int = 32_000) -> str:
    chunk = text[:max_chars]
    for pat in patterns:
        m = pat.search(chunk)
        if m:
            start = max(0, m.start() - 50)
            end = min(len(chunk), m.end() + 50)
            return chunk[start:end].replace("\n", " ")
    return ""


def _is_code_like(text: str) -> bool:
    sample = text[:4000]
    if not sample.strip():
        return False
    lines = sample.splitlines()[:80]
    score = 0
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if re.search(r"^(//|#|/\*|\*|--)\s*", line):
            score += 1
        if re.search(r"[{}()[\];]", line):
            score += 1
        if re.search(r"(^|\s)(func|class|def|const|let|var|return|if|for|while|import|export|package)\b", line):
            score += 1
        if re.search(r"[:=]-?=?|=>", line):
            score += 1
        if re.search(r"\b[A-Za-z_]\w*\s*\(", line):
            score += 1
    return score >= 4


def _filter_code_noise(matches: list[str]) -> list[str]:
    out: list[str] = []
    for m in matches:
        mt = m.strip()
        if any(p.search(mt) for p in CODE_NOISE_PATTERNS):
            continue
        out.append(m)
    return out


def scan_text(text: str, source: str = "unknown", max_scan_chars: int = 32_000) -> ScanResult:
    """Tier-1 core scan (user input, RAG, conversation history)."""
    if not text:
        return ScanResult(source=source)
    t0 = time.monotonic()
    found = _run_patterns(text, CORE_PATTERNS, max_scan_chars)
    excerpt = _excerpt_around(text, CORE_PATTERNS, max_scan_chars) if found else ""
    event_type = _classify_patterns(found) if found else EventType.UNKNOWN
    confidence = min(0.5 + 0.15 * len(found), 1.0) if found else 0.0
    return ScanResult(
        detected=bool(found),
        patterns_found=found,
        source=source,
        excerpt=excerpt,
        tier="core",
        confidence=confidence,
        event_type=event_type,
        scanner_name="regex_core",
        latency_ms=(time.monotonic() - t0) * 1000,
    )


def scan_web_content(text: str, source: str = "web", max_scan_chars: int = 32_000) -> ScanResult:
    """Tier-1 + Tier-2 scan with normalization and base64 probing."""
    if not text:
        return ScanResult(source=source, tier="web")
    t0 = time.monotonic()
    # Check for zero-width cluster evasion on raw text before stripping
    raw_web_found = _run_patterns(text[:max_scan_chars], WEB_PATTERNS, max_scan_chars)
    normalized = normalize_for_scan(text)
    core_found = _run_patterns(normalized, CORE_PATTERNS, max_scan_chars)
    web_found = _run_patterns(normalized, WEB_PATTERNS, max_scan_chars)
    # Merge raw findings (zero-width cluster hits only fire on raw text)
    seen = set(web_found)
    for f in raw_web_found:
        if f not in seen:
            web_found.append(f)
            seen.add(f)
    b64_found = detect_base64_payloads(text, CORE_PATTERNS, max_chars=max_scan_chars)
    all_found = core_found + web_found + b64_found
    if _is_code_like(text):
        all_found = _filter_code_noise(all_found)
    excerpt = _excerpt_around(normalized, CORE_PATTERNS + WEB_PATTERNS, max_scan_chars) if all_found else ""
    event_type = _classify_patterns(all_found) if all_found else EventType.UNKNOWN
    confidence = min(0.5 + 0.12 * len(all_found), 1.0) if all_found else 0.0
    return ScanResult(
        detected=bool(all_found),
        patterns_found=all_found,
        source=source,
        excerpt=excerpt,
        tier="web",
        confidence=confidence,
        event_type=event_type,
        scanner_name="regex_web",
        latency_ms=(time.monotonic() - t0) * 1000,
    )


def scan_model_output(text: str, source: str = "model_output") -> ScanResult:
    """Tier-3 output guardrail: detect compliance with injected instructions."""
    if not text:
        return ScanResult(source=source, tier="output")
    t0 = time.monotonic()
    found = _run_patterns(text, OUTPUT_PATTERNS, max_chars=16_000)
    excerpt = _excerpt_around(text, OUTPUT_PATTERNS, max_chars=16_000) if found else ""
    confidence = min(0.6 + 0.15 * len(found), 1.0) if found else 0.0
    return ScanResult(
        detected=bool(found),
        patterns_found=found,
        source=source,
        excerpt=excerpt,
        tier="output",
        confidence=confidence,
        event_type=EventType.PROMPT_LEAKAGE if found else EventType.UNKNOWN,
        scanner_name="regex_output",
        latency_ms=(time.monotonic() - t0) * 1000,
    )


def redact_patterns(text: str, include_web: bool = False) -> str:
    """Replace all matching spans with [REDACTED]."""
    patterns = list(CORE_PATTERNS)
    if include_web:
        patterns.extend(WEB_PATTERNS)
    for pat in patterns:
        text = pat.sub("[REDACTED]", text)
    return text


# ---------------------------------------------------------------------------
# Batch helpers (RAG, web results, message lists)
# ---------------------------------------------------------------------------


def scan_and_filter_texts(
    texts: list[str],
    source_prefix: str = "chunk",
    action: str = "reduce",
    web: bool = False,
) -> tuple[list[str], bool, list[dict[str, Any]]]:
    """Scan a list of text blocks; filter/redact per action (reduce|block|log)."""
    scan_fn = scan_web_content if web else scan_text
    output: list[str] = []
    any_detected = False
    details: list[dict[str, Any]] = []
    for i, t in enumerate(texts):
        if not t:
            output.append(t)
            continue
        r = scan_fn(t, source=f"{source_prefix}_{i}")
        if r.detected:
            any_detected = True
            details.append({"index": i, "patterns": r.patterns_found, "source": r.source})
            if action == "reduce":
                output.append(redact_patterns(t, include_web=web))
            elif action == "block":
                continue
            else:
                output.append(t)
        else:
            output.append(t)
    return output, any_detected, details


def scan_messages(
    messages: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], bool, list[ScanResult]]:
    """Scan all roles in an OpenAI-shaped message list (all roles untrusted).

    Returns (sanitized_messages, any_detected, scan_results).
    """
    any_detected = False
    results: list[ScanResult] = []
    out: list[dict[str, Any]] = []

    for msg in messages:
        role = msg.get("role", "")
        new_msg = dict(msg)

        content = new_msg.get("content")
        if isinstance(content, str) and content:
            r = scan_text(content, source=f"msg_{role}")
            if r.detected:
                any_detected = True
                results.append(r)
                new_msg["content"] = redact_patterns(content)

        if role == "assistant" and new_msg.get("tool_calls"):
            tcs, tc_detected, tc_results = _scan_tool_calls(new_msg["tool_calls"])
            if tc_detected:
                any_detected = True
                results.extend(tc_results)
                new_msg["tool_calls"] = tcs

        out.append(new_msg)

    return out, any_detected, results


def _scan_tool_calls(
    tool_calls: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], bool, list[ScanResult]]:
    any_detected = False
    results: list[ScanResult] = []
    out: list[dict[str, Any]] = []
    for tc in tool_calls:
        tc_copy = dict(tc)
        fn = tc_copy.get("function")
        if isinstance(fn, dict) and isinstance(fn.get("arguments"), str):
            r = scan_text(fn["arguments"], source="tool_call_args")
            if r.detected:
                any_detected = True
                results.append(r)
                fn = dict(fn)
                fn["arguments"] = redact_patterns(fn["arguments"])
                tc_copy["function"] = fn
        out.append(tc_copy)
    return out, any_detected, results
