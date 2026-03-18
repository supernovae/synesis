"""Tests for integrity core, code fence rendering, and MCP integrity contract.

The text_only/legacy_hybrid routing tests have been removed; the unified pipeline
no longer has separate front door modes. See test_graph_routing.py for current
routing tests.
"""

from __future__ import annotations

import pytest

# ---------------------------------------------------------------------------
# Integrity core (no LangGraph deps)
# ---------------------------------------------------------------------------
from app.integrity_core import (
    IntegrityReport,
    IntegrityResult,
    check_python_syntax,
    run_all_checks,
)


class TestIntegrityCore:
    def test_run_all_checks_clean_code(self):
        report = run_all_checks("x = 1\nprint(x)", language="python")
        assert report.passed
        assert report.failures == []

    def test_run_all_checks_detects_secret(self):
        report = run_all_checks('API_KEY = "sk-1234567890abcdef"', language="python")
        assert not report.passed
        assert any(f.category == "secret" for f in report.failures)

    def test_run_all_checks_detects_network(self):
        report = run_all_checks("import requests\nrequests.get('http://x')", language="python")
        assert not report.passed
        assert any(f.category == "network" for f in report.failures)

    def test_run_all_checks_detects_dangerous_bash(self):
        report = run_all_checks("rm -rf /important", language="bash")
        assert not report.passed
        assert any(f.category == "dangerous" for f in report.failures)

    def test_run_all_checks_workspace_boundary(self):
        report = run_all_checks(
            "echo hi",
            language="bash",
            files_touched=["/outside/file.py"],
            target_workspace="/workspace",
        )
        assert not report.passed
        assert any(f.category == "workspace" for f in report.failures)

    def test_run_all_checks_size_limit(self):
        report = run_all_checks("x" * 200, language="python", max_code_chars=100)
        assert not report.passed
        assert any(f.category == "size" for f in report.failures)

    def test_python_syntax_check(self):
        result = check_python_syntax("def foo(:\n  pass", "python")
        assert result is not None and result.category == "path"

    def test_python_syntax_valid(self):
        assert check_python_syntax("def foo(): pass", "python") is None

    def test_report_aggregation(self):
        report = IntegrityReport()
        assert report.passed
        report.add(None)
        assert report.passed
        report.add(IntegrityResult(category="secret", evidence="test", remediation="fix"))
        assert not report.passed
        assert len(report.failures) == 1


# ---------------------------------------------------------------------------
# Code fence rendering
# ---------------------------------------------------------------------------


class TestCodeFenceRendering:
    """Verify that code snippets survive the text pipeline with fences intact."""

    def test_scrubber_preserves_fenced_blocks(self):
        """Final scrubber must not strip triple-backtick fenced code blocks."""
        try:
            from app.nodes.final_scrubber import final_scrubber_node
        except ImportError:
            pytest.skip("Requires langgraph/langchain (container-only)")

        import asyncio

        content = (
            "# Sticky Header\n\n"
            "Here is a CSS snippet:\n\n"
            "```css\n"
            ".header {\n"
            "  position: sticky;\n"
            "  top: 0;\n"
            "}\n"
            "```\n\n"
            "And some JavaScript:\n\n"
            "```javascript\n"
            "document.querySelector('.header').classList.add('stuck');\n"
            "```\n"
        )

        state = {"compiled_answer": content}
        result = asyncio.get_event_loop().run_until_complete(final_scrubber_node(state))
        scrubbed = result.get("scrubbed_answer", "")
        assert "```css" in scrubbed, "CSS fence was stripped"
        assert "```javascript" in scrubbed, "JavaScript fence was stripped"
        assert "position: sticky;" in scrubbed

    def test_scrubber_preserves_mermaid_blocks(self):
        try:
            from app.nodes.final_scrubber import final_scrubber_node
        except ImportError:
            pytest.skip("Requires langgraph/langchain (container-only)")

        import asyncio

        content = '# Architecture\n\n```mermaid\ngraph TD\n    A["User Request"] --> B["Router"]\n```\n'
        state = {"compiled_answer": content}
        result = asyncio.get_event_loop().run_until_complete(final_scrubber_node(state))
        scrubbed = result.get("scrubbed_answer", "")
        assert "```mermaid" in scrubbed
        assert "graph TD" in scrubbed


# ---------------------------------------------------------------------------
# MCP integrity tool contract
# ---------------------------------------------------------------------------


class TestMcpIntegrityContract:
    """Verify the MCP tool module can be imported and produces correct output."""

    def test_import_and_schema(self):
        try:
            from app.integrity_core import run_all_checks
        except ImportError:
            pytest.skip("integrity_core not on path")

        report = run_all_checks("print('hello')", language="python")
        result = {
            "passed": report.passed,
            "failures": [
                {"category": f.category, "evidence": f.evidence, "remediation": f.remediation} for f in report.failures
            ],
        }
        assert result["passed"] is True
        assert result["failures"] == []

    def test_failure_output_shape(self):
        from app.integrity_core import run_all_checks

        report = run_all_checks('secret = "sk-abcdefgh12345678"', language="python")
        assert not report.passed
        failure = report.failures[0]
        assert hasattr(failure, "category")
        assert hasattr(failure, "evidence")
        assert hasattr(failure, "remediation")
