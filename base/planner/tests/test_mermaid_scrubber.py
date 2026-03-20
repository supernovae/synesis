"""Deterministic Mermaid repair and validation in final_scrubber."""

from __future__ import annotations

from app.mermaid_postprocess import sanitize_mermaid


class TestMermaidScrubber:
    def test_preserves_valid_flowchart(self) -> None:
        src = (
            "# Architecture\n\n"
            "```mermaid\n"
            "graph TD\n"
            '    A["User Request"] --> B["Router"]\n'
            "```\n"
        )
        out, fixes, replaced = sanitize_mermaid(src)
        assert "```mermaid" in out
        assert "graph TD" in out
        assert replaced == 0

    def test_comments_spurious_markdown_bullet_in_flowchart(self) -> None:
        src = (
            "```mermaid\n"
            "graph TD\n"
            "    A[Service]\n"
            "    - Accidental markdown bullet\n"
            "```\n"
        )
        out, fixes, replaced = sanitize_mermaid(src)
        assert replaced == 0
        assert "%% Accidental markdown bullet" in out
        assert fixes > 0

    def test_repairs_unclosed_quote_on_same_line(self) -> None:
        src = "```mermaid\ngraph TD\n    GW[\"API Gateway\n    AG --> LB[\"Load Balancer\"]\n```\n"
        out, fixes, replaced = sanitize_mermaid(src)
        assert replaced == 0
        assert 'GW["API Gateway"]' in out
        assert fixes > 0

    def test_replaces_structurally_invalid_block(self) -> None:
        src = "```mermaid\ngraph TD\n    A[\n```\n"
        out, _fixes, replaced = sanitize_mermaid(src)
        assert replaced == 1
        assert "```mermaid" not in out
        assert "could not be rendered reliably" in out
