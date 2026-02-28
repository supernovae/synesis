"""Tests for performance-related changes: HTTP client, node timing, guided output."""

from __future__ import annotations

import logging
from unittest.mock import AsyncMock, patch

import pytest

from app.llm_telemetry import get_llm_http_client


class TestLLMHttpClient:
    """Persistent HTTP client — always returns shared instance to reduce connection churn."""

    def test_returns_shared_client_singleton(self):
        """get_llm_http_client returns the same instance on subsequent calls."""
        client1 = get_llm_http_client()
        client2 = get_llm_http_client()
        assert client1 is not None
        assert client1 is client2

    def test_client_has_response_hook(self):
        """Client is configured with response hook for telemetry."""
        client = get_llm_http_client()
        if client is not None:
            assert hasattr(client, "event_hooks")
            assert "response" in client.event_hooks
            assert len(client.event_hooks["response"]) >= 1


class TestDebugNodeTiming:
    """with_debug_node_timing logs at DEBUG when node completes."""

    @pytest.mark.asyncio
    async def test_node_timing_logs_at_debug(self, caplog):
        """Node wrapper logs latency at DEBUG level."""
        from app.graph import with_debug_node_timing

        async def dummy_node(state):
            return {"current_node": "dummy", "next_node": "end"}

        wrapped = with_debug_node_timing(dummy_node)
        with caplog.at_level(logging.DEBUG):
            result = await wrapped({"run_id": "test"})

        assert result["current_node"] == "dummy"
        assert any("dummy" in rec.message and "ms" in rec.message for rec in caplog.records)

    @pytest.mark.asyncio
    async def test_node_timing_uses_trace_latency_when_available(self, caplog):
        """When node returns node_traces with latency_ms, that value is logged."""
        from app.state import NodeTrace, NodeOutcome
        from app.graph import with_debug_node_timing

        trace = NodeTrace(
            node_name="test_node",
            reasoning="ok",
            confidence=1.0,
            outcome=NodeOutcome.SUCCESS,
            latency_ms=1234.5,
        )

        async def node_with_trace(state):
            return {"node_traces": [trace], "current_node": "test_node"}

        wrapped = with_debug_node_timing(node_with_trace)
        with caplog.at_level(logging.DEBUG):
            await wrapped({})

        assert any("123" in rec.message or "1234" in rec.message for rec in caplog.records)


class TestContextRefsResolver:
    """Context refs+cache — lighter payload between nodes."""

    def test_resolve_from_refs_and_cache(self):
        """When rag_context_refs and context_cache present, resolve to text list."""
        from app.context_resolver import get_resolved_rag_context

        state = {
            "rag_context_refs": ["abc123", "def456"],
            "context_cache": {"abc123": "First chunk.", "def456": "Second chunk."},
            "rag_context": [],  # Legacy; should be ignored when refs present
        }
        result = get_resolved_rag_context(state)
        assert result == ["First chunk.", "Second chunk."]

    def test_fallback_to_legacy_rag_context(self):
        """When no refs, use legacy rag_context."""
        from app.context_resolver import get_resolved_rag_context

        state = {"rag_context": ["legacy A", "legacy B"]}
        result = get_resolved_rag_context(state)
        assert result == ["legacy A", "legacy B"]

    def test_empty_cache_falls_back_to_legacy(self):
        """When refs exist but cache empty, fall back to legacy rag_context."""
        from app.context_resolver import get_resolved_rag_context

        state = {
            "rag_context_refs": ["missing"],
            "context_cache": {},
            "rag_context": ["fallback"],
        }
        result = get_resolved_rag_context(state)
        assert result == ["fallback"]

    def test_missing_ref_in_cache_yields_empty_string(self):
        """When cache exists but ref is missing, yield empty string for that slot."""
        from app.context_resolver import get_resolved_rag_context

        state = {
            "rag_context_refs": ["missing", "found"],
            "context_cache": {"found": "ok"},
        }
        result = get_resolved_rag_context(state)
        assert result == ["", "ok"]


class TestGuidedOutputFallback:
    """Supervisor and critic fall back to raw parse when structured output fails."""

    @patch("app.nodes.supervisor.supervisor_structured_llm")
    @patch("app.nodes.supervisor.supervisor_llm")
    @pytest.mark.asyncio
    async def test_supervisor_fallback_on_structured_failure(
        self, mock_raw_llm, mock_structured_llm
    ):
        """When structured output raises, supervisor falls back to raw parse."""
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
        from app.nodes.supervisor import supervisor_node
        from app.schemas import SupervisorOut

        mock_structured_llm.ainvoke = AsyncMock(side_effect=RuntimeError("vLLM down"))
        raw_json = '{"task_type":"code_generation","task_description":"hello","target_language":"python","route_to":"worker","task_is_trivial":true,"bypass_planner":true,"bypass_clarification":true,"rag_mode":"disabled","allowed_tools":["none"]}'
        mock_raw_llm.ainvoke = AsyncMock(return_value=AIMessage(content=raw_json))

        state = {
            "messages": [HumanMessage(content="hello world")],
            "task_description": "hello world",
            "last_user_content": "hello world",
            "conversation_history": [],
            "iteration_count": 0,
        }

        result = await supervisor_node(state)

        assert result.get("next_node") in ("worker", "context_curator", "respond")
        mock_raw_llm.ainvoke.assert_called_once()

    @patch("app.nodes.critic.discover_collections")
    @patch("app.nodes.critic.critic_structured_llm")
    @patch("app.nodes.critic.critic_llm")
    @pytest.mark.asyncio
    async def test_critic_fallback_on_structured_failure(
        self, mock_critic_llm, mock_critic_structured_llm, mock_discover_collections
    ):
        """When structured output raises, critic falls back to raw parse."""
        mock_discover_collections.return_value = []
        from langchain_core.messages import AIMessage
        from app.nodes.critic import critic_node

        mock_critic_structured_llm.ainvoke = AsyncMock(side_effect=RuntimeError("vLLM down"))
        raw_json = '{"what_if_analyses":[],"overall_assessment":"OK","approved":true,"confidence":0.9,"reasoning":"low risk","should_continue":false,"need_more_evidence":false}'
        mock_critic_llm.ainvoke = AsyncMock(return_value=AIMessage(content=raw_json))

        state = {
            "messages": [],
            "task_description": "hello",
            "generated_code": "print(1)",
            "target_language": "python",
            "iteration_count": 0,
            "max_iterations": 3,
        }

        result = await critic_node(state)

        assert "critic_approved" in result
        mock_critic_llm.ainvoke.assert_called_once()
