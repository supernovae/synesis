"""Tests for compiler token streaming configuration.

Validates:
  - structured_writer uses streaming=True so LangGraph emits
    on_chat_model_stream events for each token
  - The SSE generator in main.py accepts structured_writer tokens
    alongside worker tokens
  - The phase map assigns "Writing…" to the structured_writer node
"""

from __future__ import annotations

import pathlib


def _read_source(filename: str) -> str:
    """Read a source file from the planner app directory."""
    src = pathlib.Path(__file__).resolve().parent.parent / "app" / filename
    return src.read_text()


class TestCompilerStreamingEnabled:
    """Ensure the structured_writer ChatOpenAI is instantiated with streaming=True."""

    def test_streaming_true_in_compiler(self):
        source = _read_source("nodes/structured_writer.py")
        assert "streaming=True" in source
        assert "streaming=False" not in source


class TestSSEHandlerAcceptsCompilerTokens:
    """Ensure the on_chat_model_stream handler streams structured_writer tokens."""

    def test_handler_includes_structured_writer(self):
        source = _read_source("main.py")
        assert '"structured_writer"' in source
        assert 'lg_node in ("worker", "structured_writer")' in source

    def test_compiler_phase_is_writing(self):
        source = _read_source("main.py")
        assert '"structured_writer": "Writing' in source
