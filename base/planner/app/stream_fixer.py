"""StreamingBlockFixer — inline JSON/YAML/Mermaid fixer for SSE token streams.

Sits between the LLM token stream and SSE emission.  Prose tokens pass
through with zero added latency.  When a fenced ``json`` / ``yaml`` /
``mermaid``
block is detected, tokens are buffered until the closing fence arrives,
the deterministic fixer runs, and the corrected block is emitted as a
single burst.

Typical user-perceived effect: prose streams normally → brief pause
(0.5-2s while the structured block buffers) → clean JSON/YAML appears
at once.
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger("synesis.stream_fixer")

_FENCE_OPEN = re.compile(r"^```(json|ya?ml|mermaid)\s*$", re.MULTILINE | re.IGNORECASE)
_FENCE_CLOSE = re.compile(r"^```\s*$", re.MULTILINE)

_PARTIAL_FENCE_MAX = 10


class StreamingBlockFixer:
    """Buffer fenced JSON/YAML blocks during SSE streaming, fix inline."""

    __slots__ = ("_block_lang", "_buf", "_fixes", "_in_block")

    def __init__(self) -> None:
        self._buf = ""
        self._in_block = False
        self._block_lang = ""
        self._fixes = 0

    @property
    def fixes(self) -> int:
        return self._fixes

    def feed(self, token: str) -> list[str]:
        """Accept a token; return fragments to emit (may be empty)."""
        self._buf += token
        return self._drain()

    def flush(self) -> list[str]:
        """End of stream — emit whatever remains unfixed."""
        if not self._buf:
            return []
        if self._in_block:
            fixed = self._fix_block(self._buf, self._block_lang)
            self._buf = ""
            self._in_block = False
            return [fixed]
        out = [self._buf]
        self._buf = ""
        return out

    # ── internals ──────────────────────────────────────────────────────

    def _drain(self) -> list[str]:
        out: list[str] = []
        changed = True
        while self._buf and changed:
            changed = False
            if not self._in_block:
                m = _FENCE_OPEN.search(self._buf)
                if m is None:
                    safe = len(self._buf) - _PARTIAL_FENCE_MAX
                    if safe > 0:
                        out.append(self._buf[:safe])
                        self._buf = self._buf[safe:]
                        changed = True
                else:
                    if m.start() > 0:
                        out.append(self._buf[: m.start()])
                    self._buf = self._buf[m.start() :]
                    self._in_block = True
                    self._block_lang = m.group(1).lower()
                    if self._block_lang == "yml":
                        self._block_lang = "yaml"
                    changed = True
            else:
                first_nl = self._buf.find("\n")
                if first_nl < 0:
                    break
                search_start = first_nl + 1
                m = _FENCE_CLOSE.search(self._buf, search_start)
                if m is None:
                    break
                block_end = m.end()
                full_block = self._buf[:block_end]
                self._buf = self._buf[block_end:]
                self._in_block = False
                out.append(self._fix_block(full_block, self._block_lang))
                changed = True
        return out

    def _fix_block(self, block: str, lang: str) -> str:
        """Apply deterministic fixes; return original on failure."""

        first_nl = block.find("\n")
        if first_nl < 0:
            return block
        opener = block[: first_nl + 1]
        rest = block[first_nl + 1 :]

        close_idx = rest.rfind("\n```")
        if close_idx < 0:
            return block
        body = rest[:close_idx]
        closer = rest[close_idx + 1 :]

        fixed: str | None = None
        if lang == "json":
            from .nodes.final_scrubber import _try_fix_json

            fixed = _try_fix_json(body)
        elif lang == "yaml":
            from .nodes.final_scrubber import _try_fix_yaml

            fixed = _try_fix_yaml(body)
        elif lang == "mermaid":
            from .mermaid_postprocess import sanitize_mermaid

            repaired, mermaid_fixes, mermaid_replaced = sanitize_mermaid(block)
            if mermaid_fixes > 0 or mermaid_replaced > 0:
                self._fixes += mermaid_fixes + mermaid_replaced
                logger.info(
                    "stream_block_fixed",
                    extra={
                        "lang": lang,
                        "body_len": len(body),
                        "total_fixes": self._fixes,
                        "mermaid_replaced": mermaid_replaced,
                    },
                )
                return repaired

        if fixed is not None:
            self._fixes += 1
            logger.info(
                "stream_block_fixed",
                extra={"lang": lang, "body_len": len(body), "total_fixes": self._fixes},
            )
            return f"{opener}{fixed}\n{closer}"
        return block
