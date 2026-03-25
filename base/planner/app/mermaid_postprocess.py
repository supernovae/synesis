"""Deterministic Mermaid repair and validation for user-facing markdown.

LLM output often contains almost-valid Mermaid.  We quote tricky labels,
fix common mistakes (markdown bullets inside flowcharts, dangling quotes),
and replace blocks that still fail cheap structural validation with a short
markdown note so clients never surface raw parser errors.
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger("synesis.mermaid_postprocess")

_MERMAID_BLOCK_RE = re.compile(r"(```mermaid\b)(.*?)(```)", re.DOTALL | re.IGNORECASE)

_MERMAID_BRACKET_LABEL_RE = re.compile(r'(\b[A-Za-z][\w-]*\[)([^\]"]*[(){}|][^\]"]*)(\])')
_MERMAID_DIAMOND_LABEL_RE = re.compile(r'(\b[A-Za-z][\w-]*\{)([^}"]*[()|\[\]][^}"]*)(\})')
# Unquoted colon inside [...] confuses some Mermaid builds (e.g. "HTTP: 443").
_MERMAID_BRACKET_COLON_LABEL_RE = re.compile(r'(\b[A-Za-z][\w-]*\[)([^\]"]*:[^\]"]*)(\])')

# Node id[inner] on a single line — inner must not contain [ or ] (avoids stadium [[...]]).
_MERMAID_BRACKET_NODE_RE = re.compile(r"(\b[A-Za-z][\w-]*\[)([^\[\]]+)\]")

_MERMAID_PLACEHOLDER = (
    "> **Diagram:** *This figure could not be rendered reliably. "
    "Relationships and components are described in the text above.*\n"
)

_FLOWCHART_HEAD_RE = re.compile(r"^\s*(graph\b|flowchart\b)", re.IGNORECASE)
# Markdown list line accidentally pasted inside a flowchart (often yields parse error: got MINUS).
_SPURIOUS_BULLET_LINE_RE = re.compile(r"^(\s*)-\s+(\S.*)$")
# Common malformed tail: `Ingress[Ingress (ALB)] A` (missing edge operator).
_DANGLING_NODE_TAIL_RE = re.compile(r"^(\s*.*?[\]\}\)])\s+([A-Za-z][\w-]*)\s*$")


def _mermaid_first_non_comment_line(body: str) -> str:
    for line in body.splitlines():
        t = line.strip()
        if not t or t.startswith("%%"):
            continue
        return t.lower()
    return ""


def _mermaid_is_flowchart_like(body: str) -> bool:
    """Whether to apply flowchart-only repairs (markdown bullets, etc.)."""
    head = _mermaid_first_non_comment_line(body)
    return bool(_FLOWCHART_HEAD_RE.match(head))


def _fix_spurious_markdown_bullets(body: str) -> tuple[str, int]:
    """Turn accidental markdown list lines inside flowcharts into %% comments.

    A line like ``    - Handles PCI`` is parsed as MINUS and breaks the diagram.
    """
    if not _mermaid_is_flowchart_like(body):
        return body, 0
    fixes = 0
    out: list[str] = []
    for line in body.splitlines():
        m = _SPURIOUS_BULLET_LINE_RE.match(line)
        if m:
            fixes += 1
            indent, rest = m.group(1), m.group(2)
            out.append(f"{indent}%% {rest}")
        else:
            out.append(line)
    return "\n".join(out), fixes


def _repair_line_unclosed_bracket_quote(line: str) -> tuple[str, int]:
    """Close ``id["label`` when ``]`` is missing from the line (odd ``"`` in bracket segment)."""
    if "[" not in line or "]" in line:
        return line, 0
    idx = line.rfind("[")
    rest = line[idx + 1 :]
    if not rest or '"' not in rest:
        return line, 0
    if rest.count('"') % 2 == 1:
        return line + '"]', 1
    return line, 0


def _fix_odd_quotes_in_bracket_nodes(line: str) -> tuple[str, int]:
    """If ``[...]`` has an odd number of ``"`` inside, append a closing quote before ``]``."""
    fixes = 0

    def _fix(m: re.Match) -> str:
        nonlocal fixes
        op, inner = m.group(1), m.group(2)
        if '"' in inner and inner.count('"') % 2 == 1:
            fixes += 1
            inner = inner + '"'
        return f"{op}{inner}]"

    return _MERMAID_BRACKET_NODE_RE.sub(_fix, line), fixes


def _repair_dangling_node_tail(line: str) -> tuple[str, int]:
    """Repair `Node[label] Next` into `Node[label] --> Next` for flowcharts."""
    raw = line.strip()
    if not raw or raw.startswith("%%"):
        return line, 0
    # Already has an explicit link/class/style continuation.
    if any(op in line for op in ("-->", "==>", "-.->", "---", ":::")):
        return line, 0
    m = _DANGLING_NODE_TAIL_RE.match(line)
    if not m:
        return line, 0
    return f"{m.group(1)} --> {m.group(2)}", 1


def _quote_special_mermaid_labels(content: str) -> tuple[str, int]:
    """Quote node labels that confuse the parser (parens, pipes, colons, etc.)."""
    fixes = 0

    def _quote(m: re.Match) -> str:
        nonlocal fixes
        fixes += 1
        return f'{m.group(1)}"{m.group(2)}"{m.group(3)}'

    out = content
    out = _MERMAID_BRACKET_LABEL_RE.sub(_quote, out)
    out = _MERMAID_BRACKET_COLON_LABEL_RE.sub(_quote, out)
    out = _MERMAID_DIAMOND_LABEL_RE.sub(_quote, out)
    return out, fixes


def _rough_delimiters_ok(body: str) -> bool:
    """Balance `[]`, `{}`, `()` ignoring text inside double-quoted strings."""
    stripped = re.sub(r'"(?:[^"\\]|\\.)*"', '""', body)
    return (
        stripped.count("[") == stripped.count("]")
        and stripped.count("{") == stripped.count("}")
        and stripped.count("(") == stripped.count(")")
    )


def _mermaid_basic_ok(body: str) -> bool:
    """Cheap structural checks after repairs; false negatives are acceptable, false positives are not."""
    if body.count('"') % 2 != 0:
        return False
    if not _rough_delimiters_ok(body):
        return False
    # Residual markdown bullets in flowcharts almost always break parsing.
    if _mermaid_is_flowchart_like(body):
        for line in body.splitlines():
            raw = line.strip()
            if not raw or raw.startswith("%%"):
                continue
            if _SPURIOUS_BULLET_LINE_RE.match(line) and not line.lstrip().startswith("%%"):
                return False
            # Reject residual malformed tails like `Node[label] Other`.
            if _DANGLING_NODE_TAIL_RE.match(line) and not any(op in line for op in ("-->", "==>", "-.->", "---", ":::")):
                return False
    return True


def sanitize_mermaid(text: str) -> tuple[str, int, int]:
    """Repair Mermaid blocks, quote tricky labels, drop blocks that still look invalid.

    Returns ``(text, label_fix_count, blocks_replaced_count)``.
    """
    label_fixes = 0
    blocks_replaced = 0

    def _fix_block(block_match: re.Match) -> str:
        nonlocal label_fixes, blocks_replaced
        opener = block_match.group(1)
        content = block_match.group(2)
        closer = block_match.group(3)

        bullet_fixes = 0
        content, bullet_fixes = _fix_spurious_markdown_bullets(content)
        label_fixes += bullet_fixes

        repaired_lines: list[str] = []
        is_flowchart = _mermaid_is_flowchart_like(content)
        for line in content.splitlines():
            ln, u1 = _repair_line_unclosed_bracket_quote(line)
            label_fixes += u1
            ln, u2 = _fix_odd_quotes_in_bracket_nodes(ln)
            label_fixes += u2
            if is_flowchart:
                ln, u3 = _repair_dangling_node_tail(ln)
                label_fixes += u3
            repaired_lines.append(ln)
        content = "\n".join(repaired_lines)

        content, qf = _quote_special_mermaid_labels(content)
        label_fixes += qf

        if _mermaid_basic_ok(content):
            return f"{opener}{content}{closer}"

        blocks_replaced += 1
        logger.warning(
            "mermaid_block_replaced_after_failed_validation",
            extra={"sample": content.strip()[:200]},
        )
        # Emit markdown only — do not keep a ```mermaid fence around a note (would confuse renderers).
        return _MERMAID_PLACEHOLDER.rstrip() + "\n\n"

    result = _MERMAID_BLOCK_RE.sub(_fix_block, text)
    return result, label_fixes, blocks_replaced
