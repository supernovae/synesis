"""Unit tests for the tool orchestrator."""

from __future__ import annotations

import json

import pytest
from app.tools.local_tools import handle_local_tool
from app.tools.orchestrator import ToolOrchestrator
from app.tools.schema_validator import ToolValidationError, validate_tool_args


class TestSchemaValidator:
    def test_valid_args(self):
        schema = {"inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}}}
        result = validate_tool_args("test", {"q": "hello"}, schema)
        assert result == {"q": "hello"}

    def test_string_args_parsed(self):
        schema = {"inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}}}
        result = validate_tool_args("test", '{"q": "hello"}', schema)
        assert result == {"q": "hello"}

    def test_invalid_json_raises(self):
        with pytest.raises(ToolValidationError):
            validate_tool_args("test", "not json", {})

    def test_schema_violation_raises(self):
        schema = {
            "inputSchema": {
                "type": "object",
                "properties": {"count": {"type": "integer"}},
                "required": ["count"],
            }
        }
        with pytest.raises(ToolValidationError):
            validate_tool_args("test", {"count": "not_a_number"}, schema)

    def test_empty_schema_passes(self):
        result = validate_tool_args("test", {"anything": "goes"}, {})
        assert result == {"anything": "goes"}


class TestLocalTools:
    @pytest.mark.asyncio
    async def test_escalate_tool(self):
        result = await handle_local_tool(
            "synesis_escalate",
            {"reason": "need RAG", "query": "search for docs"},
        )
        assert result["_escalate"] is True
        assert result["query"] == "search for docs"

    @pytest.mark.asyncio
    async def test_unknown_tool(self):
        result = await handle_local_tool("nonexistent", {})
        assert "error" in result


class TestToolOrchestrator:
    @pytest.mark.asyncio
    async def test_list_tools_includes_locals(self, tool_orchestrator: ToolOrchestrator):
        tools = tool_orchestrator.list_tools()
        names = {t["function"]["name"] for t in tools}
        assert "synesis_escalate" in names

    @pytest.mark.asyncio
    async def test_execute_escalate(self, tool_orchestrator: ToolOrchestrator):
        call = {
            "id": "tc_1",
            "function": {
                "name": "synesis_escalate",
                "arguments": json.dumps({"reason": "test", "query": "test query"}),
            },
        }
        result = await tool_orchestrator.execute_tool_call(call)
        assert result.escalate is True
        assert result.escalate_query == "test query"

    @pytest.mark.asyncio
    async def test_execute_unknown_tool(self, tool_orchestrator: ToolOrchestrator):
        call = {
            "id": "tc_2",
            "function": {"name": "nonexistent_tool", "arguments": "{}"},
        }
        result = await tool_orchestrator.execute_tool_call(call)
        assert result.is_error is True

    @pytest.mark.asyncio
    async def test_execute_invalid_json(self, tool_orchestrator: ToolOrchestrator):
        call = {
            "id": "tc_3",
            "function": {"name": "synesis_escalate", "arguments": "not json"},
        }
        result = await tool_orchestrator.execute_tool_call(call)
        assert result.is_error is True
