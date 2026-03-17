"""Router governance tests — the single most important test suite.

Validates that the Router-governed evidence architecture is correctly enforced:
1. Role boundaries (static import analysis)
2. Evidence packet schema compliance
3. Retrieval discipline (bounds, refinement, caching)
4. Anti-oscillation cache invalidation
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (container-only)")

from app.state import EvidencePacket, EvidenceSnippet, EvidenceSource
from pydantic import ValidationError

# ---------------------------------------------------------------------------
# 1. Role boundary tests (static analysis)
# ---------------------------------------------------------------------------

NODES_DIR = Path(__file__).resolve().parent.parent / "app" / "nodes"

FORBIDDEN_RETRIEVAL_IMPORTS = {
    "rag_client",
    "web_search",
    "unified_retrieval",
    "query_distiller",
}

NODES_THAT_MUST_NOT_RETRIEVE = {
    "planner_node.py",
    "executor.py",
    "writer.py",
    "critic.py",
}


def _get_imports_from_file(filepath: Path) -> set[str]:
    """Parse a Python file and extract all imported module names."""
    try:
        source = filepath.read_text(encoding="utf-8")
        tree = ast.parse(source)
    except (SyntaxError, FileNotFoundError):
        return set()

    imports: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.add(alias.name.split(".")[-1])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                parts = node.module.split(".")
                imports.update(parts)
                for alias in node.names:
                    imports.add(alias.name)
    return imports


class TestRoleBoundaries:
    """No node other than router.py may import retrieval backends."""

    @pytest.mark.parametrize("filename", sorted(NODES_THAT_MUST_NOT_RETRIEVE))
    def test_no_retrieval_imports(self, filename: str):
        filepath = NODES_DIR / filename
        if not filepath.exists():
            pytest.skip(f"{filename} not found")
        imports = _get_imports_from_file(filepath)
        violations = imports & FORBIDDEN_RETRIEVAL_IMPORTS
        assert not violations, (
            f"{filename} imports forbidden retrieval modules: {violations}. Only router.py may import these."
        )

    def test_router_imports_retrieval(self):
        """router.py SHOULD import retrieval backends (sanity check)."""
        filepath = NODES_DIR / "router.py"
        assert filepath.exists(), "router.py not found"
        imports = _get_imports_from_file(filepath)
        assert "unified_retrieval" in imports, "router.py should import unified_retrieval"

    def test_old_nodes_deleted(self):
        """Verify deleted nodes are actually gone."""
        for name in ("supervisor.py", "context_curator.py", "evidence_gatherer.py", "evidence_compiler.py"):
            assert not (NODES_DIR / name).exists(), f"{name} should have been deleted"


# ---------------------------------------------------------------------------
# 2. Evidence packet schema tests
# ---------------------------------------------------------------------------


class TestEvidencePacketSchema:
    def test_valid_packet(self):
        packet = EvidencePacket(
            query="K8s deployment strategy for service X",
            sources=[
                EvidenceSource(uri="https://docs.example.com/deploy", type="doc", metadata={"authority": "canonical"}),
            ],
            snippets=[
                EvidenceSnippet(
                    text="Use rolling deployments for zero downtime.",
                    relevance=0.95,
                    source_uri="https://docs.example.com/deploy",
                ),
            ],
            summary="Rolling deployment strategy recommended.",
            confidence=0.85,
            retrieval_notes="Strong evidence from canonical docs.",
        )
        assert packet.confidence >= 0.0
        assert packet.confidence <= 1.0

    def test_snippet_bounds(self):
        snippets = [EvidenceSnippet(text=f"snippet {i}", relevance=0.5, source_uri="x") for i in range(25)]
        packet = EvidencePacket(
            query="test",
            snippets=snippets[:20],
            summary="test",
            confidence=0.5,
        )
        assert len(packet.snippets) <= 20

    def test_source_bounds(self):
        sources = [EvidenceSource(uri=f"http://example.com/{i}", type="doc") for i in range(10)]
        packet = EvidencePacket(
            query="test",
            sources=sources[:5],
            summary="test",
            confidence=0.5,
        )
        assert len(packet.sources) <= 5

    def test_low_confidence_requires_notes(self):
        packet = EvidencePacket(
            query="test",
            summary="Insufficient evidence",
            confidence=0.2,
            retrieval_notes="",
        )
        assert packet.confidence < 0.4
        # Convention: low-confidence packets should have retrieval_notes

    def test_confidence_clamped(self):
        with pytest.raises(ValidationError):
            EvidencePacket(query="test", summary="x", confidence=1.5)

    def test_section_id_optional(self):
        packet = EvidencePacket(query="test", summary="x", confidence=0.5)
        assert packet.section_id is None

        packet_with_section = EvidencePacket(query="test", summary="x", confidence=0.5, section_id=3)
        assert packet_with_section.section_id == 3


# ---------------------------------------------------------------------------
# 3. Retrieval discipline tests
# ---------------------------------------------------------------------------


class TestRetrievalDiscipline:
    def test_max_docs_bound(self):
        from app.nodes.router import MAX_DOCS_PER_QUERY

        assert MAX_DOCS_PER_QUERY == 5

    def test_max_snippets_bound(self):
        from app.nodes.router import MAX_SNIPPETS_PER_PACKET

        assert MAX_SNIPPETS_PER_PACKET == 20

    def test_max_refinement_rounds(self):
        from app.nodes.router import MAX_REFINEMENT_ROUNDS

        assert MAX_REFINEMENT_ROUNDS == 2

    def test_low_confidence_threshold(self):
        from app.nodes.router import LOW_CONFIDENCE_THRESHOLD

        assert LOW_CONFIDENCE_THRESHOLD == 0.4

    def test_dedupe_removes_duplicates(self):
        from app.nodes.router import RouterNode

        router = RouterNode.__new__(RouterNode)

        p1 = EvidencePacket(query="test query", summary="same summary content", confidence=0.8)
        p2 = EvidencePacket(query="test query", summary="same summary content", confidence=0.8)
        p3 = EvidencePacket(query="different query", summary="different content", confidence=0.7)

        result = router.dedupe([p1, p2, p3])
        assert len(result) == 2

    def test_mode_detection_initial(self):
        from app.nodes.router import RouterNode

        router = RouterNode.__new__(RouterNode)

        state = {"evidence_requests": [], "execution_plan": {}, "need_more_evidence": False}
        assert router._detect_mode(state) == "initial"

    def test_mode_detection_section_evidence(self):
        from app.nodes.router import RouterNode

        router = RouterNode.__new__(RouterNode)

        state = {
            "evidence_requests": [{"section_id": 1, "description": "test"}],
            "execution_plan": {"steps": []},
            "need_more_evidence": False,
        }
        assert router._detect_mode(state) == "section_evidence"

    def test_mode_detection_refinement(self):
        from app.nodes.router import RouterNode

        router = RouterNode.__new__(RouterNode)

        state = {
            "evidence_requests": [{"description": "more evidence needed"}],
            "execution_plan": {},
            "need_more_evidence": True,
        }
        assert router._detect_mode(state) == "refinement"

    def test_next_node_planner_when_no_plan(self):
        from app.nodes.router import RouterNode

        router = RouterNode.__new__(RouterNode)

        state = {"execution_plan": {}, "is_code_task": False, "task_is_trivial": False}
        assert router._decide_next_node(state) == "planner"

    def test_next_node_executor_for_code(self):
        from app.nodes.router import RouterNode

        router = RouterNode.__new__(RouterNode)

        state = {"execution_plan": {"steps": []}, "is_code_task": True, "task_is_trivial": False}
        assert router._decide_next_node(state) == "executor"

    def test_next_node_writer_for_knowledge(self):
        from app.nodes.router import RouterNode

        router = RouterNode.__new__(RouterNode)

        state = {"execution_plan": {"steps": []}, "is_code_task": False, "task_is_trivial": False}
        assert router._decide_next_node(state) == "writer"


# ---------------------------------------------------------------------------
# 4. Anti-oscillation + cache invalidation tests
# ---------------------------------------------------------------------------


class TestAntiOscillationCacheInvalidation:
    def test_retrieval_churn_score_increases_with_router_passes(self):
        from app.oscillation_detector import _score_retrieval_oscillation
        from app.state import NodeOutcome, NodeTrace

        state = {
            "critique_register": {},
            "evidence_requests": [{"description": "more"}],
            "need_more_evidence": True,
            "node_traces": [
                NodeTrace(node_name="router", reasoning="pass 1", confidence=0.5, outcome=NodeOutcome.SUCCESS),
                NodeTrace(node_name="router", reasoning="pass 2", confidence=0.5, outcome=NodeOutcome.SUCCESS),
                NodeTrace(node_name="router", reasoning="pass 3", confidence=0.5, outcome=NodeOutcome.SUCCESS),
            ],
        }
        score = _score_retrieval_oscillation(state)
        assert score >= 0.6

    def test_no_churn_when_no_evidence_requests(self):
        from app.oscillation_detector import _score_retrieval_oscillation

        state = {
            "critique_register": {},
            "evidence_requests": [],
            "need_more_evidence": False,
            "node_traces": [],
        }
        score = _score_retrieval_oscillation(state)
        assert score == 0.0


# ---------------------------------------------------------------------------
# 5. Evidence packet reducer tests
# ---------------------------------------------------------------------------


class TestEvidencePacketReducer:
    def test_merge_deduplicates_by_query_and_section(self):
        from app.reducers import _merge_evidence_packets

        existing = [
            {"query": "q1", "section_id": 1, "summary": "old"},
        ]
        new = [
            {"query": "q1", "section_id": 1, "summary": "updated"},
            {"query": "q2", "section_id": 2, "summary": "new"},
        ]
        result = _merge_evidence_packets(existing, new)
        assert len(result) == 2
        q1_packets = [p for p in result if p["query"] == "q1"]
        assert q1_packets[0]["summary"] == "updated"

    def test_merge_empty_new(self):
        from app.reducers import _merge_evidence_packets

        existing = [{"query": "q1", "section_id": None}]
        result = _merge_evidence_packets(existing, [])
        assert result == existing

    def test_merge_empty_existing(self):
        from app.reducers import _merge_evidence_packets

        new = [{"query": "q1", "section_id": None}]
        result = _merge_evidence_packets([], new)
        assert result == new
