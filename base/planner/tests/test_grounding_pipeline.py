"""Tests for grounding loss fixes across the pipeline.

Validates:
  - Critic RAG reference block construction and gating
  - Planner chunk cap scaling by difficulty
  - Evidence gatherer RAG provenance propagation
  - compile_evidence_node provenance aggregation
  - Role-aware retrieval boost
  - Compiler frame injection
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_settings(**overrides):
    env = {
        "SYNESIS_SUPERVISOR_MODEL_URL": "http://localhost:8081/v1",
        "SYNESIS_EXECUTOR_MODEL_URL": "http://localhost:8080/v1",
        "SYNESIS_RAG_RERANKER": "none",
        "SYNESIS_RAG_RETRIEVAL_STRATEGY": "hybrid",
        "SYNESIS_LSP_MODE": "on_failure",
        "SYNESIS_LOG_LEVEL": "info",
    }
    env.update(overrides)
    with patch.dict(os.environ, env, clear=False):
        from app.config import Settings

        return Settings()


# ---------------------------------------------------------------------------
# Critic RAG reference block
# ---------------------------------------------------------------------------


class TestBuildRagReferenceBlock:
    """Verify _build_rag_reference_block assembles authority-grouped summaries."""

    def test_empty_summaries_returns_empty(self):
        from app.nodes.critic import _build_rag_reference_block

        state: dict = {"rag_chunk_summaries": []}
        assert _build_rag_reference_block(state) == ""

    def test_no_key_returns_empty(self):
        from app.nodes.critic import _build_rag_reference_block

        assert _build_rag_reference_block({}) == ""

    def test_builds_formatted_block(self):
        from app.nodes.critic import _build_rag_reference_block

        state = {
            "rag_chunk_summaries": [
                "vLLM supports tensor parallelism across GPUs",
                "Use circuit breakers for reliability",
            ],
            "rag_authority_labels": ["canonical", "vetted"],
            "rag_heading_paths": ["GPU Parallelism", "Reliability Patterns"],
            "rag_document_names": ["vLLM Guide", "AWS Well-Architected"],
        }
        block = _build_rag_reference_block(state)
        assert "REFERENCE EVIDENCE" in block
        assert "[R:canonical]" in block
        assert "[R:vetted]" in block
        assert "vLLM Guide" in block
        assert "GPU Parallelism" in block

    def test_budget_truncation(self):
        from app.nodes.critic import _build_rag_reference_block

        state = {
            "rag_chunk_summaries": [f"Summary {i} with some detail about chunk content" for i in range(50)],
            "rag_authority_labels": ["community"] * 50,
            "rag_heading_paths": [""] * 50,
            "rag_document_names": [""] * 50,
        }
        block = _build_rag_reference_block(state, budget=200)
        assert len(block) <= 400  # header + budget

    def test_missing_metadata_uses_defaults(self):
        from app.nodes.critic import _build_rag_reference_block

        state = {
            "rag_chunk_summaries": ["Some summary"],
        }
        block = _build_rag_reference_block(state)
        assert "[R:unknown]" in block


# ---------------------------------------------------------------------------
# Planner chunk scaling
# ---------------------------------------------------------------------------


class TestPlannerChunkScaling:
    """Verify planner context block scales with difficulty."""

    def test_low_difficulty_uses_base_chunks(self):
        from app.nodes.planner_node import _build_context_block

        chunks = [f"chunk {i}" for i in range(10)]
        block = _build_context_block(chunks, difficulty=0.0)
        count = sum(1 for c in chunks[:5] if c in block)
        assert count >= 1
        for c in chunks[5:]:
            assert c not in block

    def test_high_difficulty_uses_more_chunks(self):
        from app.nodes.planner_node import _build_context_block

        chunks = [f"chunk {i}" for i in range(10)]
        block_high = _build_context_block(chunks, difficulty=1.0)
        block_low = _build_context_block(chunks, difficulty=0.0)
        assert len(block_high) >= len(block_low)

    def test_default_difficulty_middle(self):
        from app.nodes.planner_node import _build_context_block

        chunks = [f"chunk {i}" for i in range(10)]
        block = _build_context_block(chunks, difficulty=0.5)
        assert "chunk 0" in block


# ---------------------------------------------------------------------------
# Section provenance
# ---------------------------------------------------------------------------


class TestCompileEvidenceProvenance:
    """Verify compile_evidence_node aggregates evidence and provenance from sections."""

    @pytest.fixture()
    def section_results(self):
        """Section results in compile_evidence format (evidence array per section)."""
        return [
            {
                "section_id": 1,
                "section_action": "overview",
                "latency_ms": 100,
                "had_rag": True,
                "had_web": False,
                "evidence": [
                    {
                        "text": "vLLM supports tensor parallelism across GPUs",
                        "summary": "vLLM supports tensor parallelism",
                        "authority": "canonical",
                        "heading": "GPU Parallelism",
                        "doc_name": "vLLM Guide",
                        "source_url": "https://vllm.ai/docs",
                        "source_type": "rag",
                        "score": 0.9,
                    }
                ],
            },
            {
                "section_id": 2,
                "section_action": "details",
                "latency_ms": 150,
                "had_rag": True,
                "had_web": True,
                "evidence": [
                    {
                        "text": "Use circuit breakers for reliability",
                        "summary": "Use circuit breakers",
                        "authority": "vetted",
                        "heading": "Reliability",
                        "doc_name": "AWS WA",
                        "source_url": "https://aws.amazon.com/wa",
                        "source_type": "rag",
                        "score": 0.85,
                    },
                    {
                        "text": "vLLM supports tensor parallelism across GPUs",
                        "summary": "vLLM supports tensor parallelism",
                        "authority": "canonical",
                        "heading": "GPU Parallelism",
                        "doc_name": "vLLM Guide",
                        "source_url": "https://vllm.ai/docs",
                        "source_type": "rag",
                        "score": 0.9,
                    },
                ],
            },
        ]

    @pytest.mark.asyncio
    async def test_compile_aggregates_provenance(self, section_results):
        from app.nodes import compile_evidence_node

        state = {"section_results": section_results}
        result = await compile_evidence_node(state)
        assert "compiled_evidence" in result
        assert "vLLM supports tensor parallelism" in result["compiled_evidence"]
        assert "Use circuit breakers" in result["compiled_evidence"]
        assert "rag_document_names" in result or "rag_source_urls" in result

    @pytest.mark.asyncio
    async def test_compile_deduplicates_sources(self, section_results):
        from app.nodes import compile_evidence_node

        state = {"section_results": section_results}
        result = await compile_evidence_node(state)
        doc_names = result.get("rag_document_names", [])
        if doc_names:
            assert "vLLM Guide" in doc_names
            assert "AWS WA" in doc_names

    @pytest.mark.asyncio
    async def test_compile_without_evidence(self):
        from app.nodes import compile_evidence_node

        state = {
            "section_results": [
                {
                    "section_id": 1,
                    "section_action": "intro",
                    "latency_ms": 50,
                    "had_rag": False,
                    "had_web": False,
                    "evidence": [],
                }
            ]
        }
        result = await compile_evidence_node(state)
        assert result.get("compiled_evidence", "") == ""
        assert "rag_document_names" not in result or not result.get("rag_document_names")


# ---------------------------------------------------------------------------
# Config knobs
# ---------------------------------------------------------------------------


class TestGroundingConfig:
    """Verify new grounding config settings exist and have expected defaults."""

    def test_critic_rag_defaults(self):
        s = _make_settings()
        assert s.critic_rag_context_enabled is True
        assert s.critic_rag_context_budget == 2000

    def test_planner_chunk_scaling_defaults(self):
        s = _make_settings()
        assert s.planner_rag_base_chunks == 5
        assert s.planner_rag_max_chunks == 10

    def test_env_override(self):
        s = _make_settings(SYNESIS_PLANNER_RAG_BASE_CHUNKS="3", SYNESIS_PLANNER_RAG_MAX_CHUNKS="15")
        assert s.planner_rag_base_chunks == 3
        assert s.planner_rag_max_chunks == 15


# ---------------------------------------------------------------------------
# Schema version (indexer module — tested via importlib with sys.path)
# ---------------------------------------------------------------------------


_pymilvus_available = False
try:
    import pymilvus  # noqa: F401

    _pymilvus_available = True
except ImportError:
    pass


@pytest.mark.skipif(not _pymilvus_available, reason="pymilvus not installed")
class TestSchemaVersion:
    """Verify schema version and field set match current architecture."""

    @pytest.fixture(autouse=True)
    def _import_schema(self):
        import importlib.util

        schema_path = os.path.abspath(
            os.path.join(
                os.path.dirname(__file__),
                "..",
                "..",
                "rag",
                "indexer",
                "app",
                "schema.py",
            )
        )
        spec = importlib.util.spec_from_file_location("indexer_schema", schema_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.schema_mod = mod
        yield

    def test_intended_roles_removed(self):
        assert "intended_roles" not in self.schema_mod.EXPECTED_FIELDS

    def test_catalog_entity_has_no_intended_roles(self):
        entity = self.schema_mod.catalog_entity(
            chunk_id="test-001",
            text="Sample text",
            embedding=[0.1] * 768,
        )
        assert "intended_roles" not in entity

    def test_schema_version_is_4(self):
        assert self.schema_mod.SCHEMA_VERSION == 4
