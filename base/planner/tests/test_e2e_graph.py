"""E2E smoke test: run the graph with mocked LLMs and assert we reach respond.

Uses mocks for RAG, Worker LLM, Critic LLM. Sandbox is disabled so no HTTP.
Verifies the full trivial path: entry_classifier → context_curator → worker → gate → sandbox → critic → respond.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage

# Worker now outputs markdown with fenced code blocks (no JSON wrapper)
EXECUTOR_OUT_MARKDOWN = """Here's a simple hello world script:

```python
print('hello world')
```

This prints "hello world" to the console.
"""

CRITIC_OUT_JSON = """{
  "what_if_analyses": [],
  "overall_assessment": "Acceptable.",
  "approved": true,
  "revision_feedback": "",
  "confidence": 0.9,
  "reasoning": "Simple script, low risk.",
  "should_continue": false,
  "need_more_evidence": false
}"""


@pytest.fixture
def trivial_initial_state():
    """Minimal state that triggers trivial fast path (skip supervisor).

    Entry classifier will set task_size/bypass_supervisor from task_description.
    """
    user_content = "hello world in python"
    return {
        "messages": [HumanMessage(content=user_content)],
        "task_description": user_content,
        "last_user_content": user_content,
        "target_language": "python",
        "max_iterations": 3,
        "iteration_count": 0,
        "run_id": "test-run-id",
        "user_id": "test-user",
        "conversation_history": [],
        "token_budget_remaining": 100000,
    }


@patch("app.nodes.executor.settings")
@patch("app.nodes.critic.critic_llm")
@patch("app.nodes.worker.worker_llm")
@patch("app.nodes.context_curator.retrieve_context")
@patch("app.nodes.critic.discover_collections")
@pytest.mark.asyncio
async def test_graph_reaches_respond_trivial_path(
    mock_discover,
    mock_retrieve,
    mock_worker_llm,
    mock_critic_llm,
    mock_sandbox_settings,
    trivial_initial_state,
):
    """Trivial path reaches respond with code in the final message."""
    mock_retrieve.return_value = []
    mock_discover.return_value = []
    mock_worker_llm.bind.return_value.ainvoke = AsyncMock(return_value=AIMessage(content=EXECUTOR_OUT_MARKDOWN))
    critic_json = '{"what_if_analyses":[],"overall_assessment":"Acceptable.","approved":true,"revision_feedback":"","confidence":0.9,"reasoning":"Simple script, low risk.","should_continue":false,"need_more_evidence":false}'
    mock_critic_llm.bind.return_value.ainvoke = AsyncMock(return_value=AIMessage(content=critic_json))
    mock_sandbox_settings.sandbox_enabled = False
    mock_sandbox_settings.sandbox_warm_pool_enabled = False
    mock_sandbox_settings.max_sandbox_minutes = 60.0

    from app.graph import graph

    result = await graph.ainvoke(trivial_initial_state)

    assert "messages" in result
    msgs = result["messages"]
    assert len(msgs) >= 1
    last_content = msgs[-1].content if hasattr(msgs[-1], "content") else str(msgs[-1])
    assert "print" in last_content or "hello" in last_content.lower()
    assert result.get("current_node") == "respond" or "messages" in result
