from __future__ import annotations

from app.stream_fixer import StreamingBlockFixer


def test_stream_fixer_repairs_mermaid_block() -> None:
    fixer = StreamingBlockFixer()
    chunks = [
        "Intro text\n",
        "```mermaid\n",
        "graph TD\n",
        "Ingress[Ingress (ALB)] A\n",
        "```\n",
    ]
    emitted: list[str] = []
    for c in chunks:
        emitted.extend(fixer.feed(c))
    emitted.extend(fixer.flush())

    out = "".join(emitted)
    assert "Ingress[\"Ingress (ALB)\"] --> A" in out
    assert "Failed to render diagram" not in out
