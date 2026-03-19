"""Shared test fixtures for the Yarn runtime."""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("SYNESIS_YARN_PROVIDER", "deepinfra")
os.environ.setdefault("DEEPINFRA_API_KEY", "test-key")
os.environ.setdefault("SYNESIS_YARN_SESSION_REDIS_URL", "redis://localhost:6379/3")
os.environ.setdefault("SYNESIS_YARN_MEMORY_REDIS_URL", "redis://localhost:6379/4")


@pytest.fixture
def memory_buffer():
    from app.memory.buffer import MemoryBuffer

    buf = MemoryBuffer(max_tokens=1000, pinned_budget=200)
    buf.set_system_prompt("You are a helpful assistant.")
    return buf


@pytest.fixture
def tool_orchestrator():
    from app.tools.orchestrator import ToolOrchestrator

    orch = ToolOrchestrator(max_retries=1)
    return orch
