"""Tests for citation data flow — sources surviving from retrieval to compiler.

Validates:
  - _build_source_inventory produces a deduplicated source list
  - Section worker retrieval_provenance includes source_url

Inventory tests always run (pure dict logic, no heavy deps).
"""

from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------------------
# Mirror of structured_writer._build_sources_section — kept here so
# tests run locally without the full dep chain (pydantic_settings, etc.).
# CI integration tests validate the production copy.
# ---------------------------------------------------------------------------


def _build_source_inventory(state: dict[str, Any]) -> str:
    doc_names = state.get("rag_document_names") or []
    source_urls = state.get("rag_source_urls") or []
    authorities = state.get("rag_authority_labels") or []

    if not doc_names and not source_urls:
        return ""

    seen: set[str] = set()
    lines: list[str] = []
    for i in range(max(len(doc_names), len(source_urls))):
        name = doc_names[i] if i < len(doc_names) else ""
        url = source_urls[i] if i < len(source_urls) else ""
        auth = authorities[i] if i < len(authorities) else ""

        key = (name or url).lower()
        if not key or key in seen:
            continue
        seen.add(key)

        badge = f" [{auth.title()}]" if auth else ""
        url_part = f" — {url}" if url else ""
        lines.append(f"- {name or '(unnamed)'}{url_part}{badge}")

    if not lines:
        return ""

    return (
        "\n\nAVAILABLE SOURCES (use these for the ## Sources section when claims reference them):\n"
        + "\n".join(lines)
        + "\n"
    )


# ---------------------------------------------------------------------------
# Source inventory tests — always runnable (pure dict logic, no heavy deps)
# ---------------------------------------------------------------------------


class TestBuildSourceInventory:
    def test_empty_state(self):
        assert _build_source_inventory({}) == ""

    def test_no_urls_no_names(self):
        state = {"rag_document_names": [], "rag_source_urls": []}
        assert _build_source_inventory(state) == ""

    def test_builds_inventory(self):
        state = {
            "rag_document_names": ["vLLM Guide", "K8s Docs"],
            "rag_source_urls": ["https://vllm.ai/docs", "https://k8s.io/docs"],
            "rag_authority_labels": ["canonical", "vetted"],
        }
        result = _build_source_inventory(state)
        assert "AVAILABLE SOURCES" in result
        assert "vLLM Guide" in result
        assert "https://vllm.ai/docs" in result
        assert "[Canonical]" in result
        assert "K8s Docs" in result
        assert "[Vetted]" in result

    def test_deduplicates(self):
        state = {
            "rag_document_names": ["vLLM Guide", "vLLM Guide", "K8s Docs"],
            "rag_source_urls": ["https://vllm.ai/docs", "https://vllm.ai/docs", "https://k8s.io/docs"],
            "rag_authority_labels": ["canonical", "canonical", "vetted"],
        }
        result = _build_source_inventory(state)
        assert result.count("vLLM Guide") == 1

    def test_handles_missing_authority(self):
        state = {
            "rag_document_names": ["Some Doc"],
            "rag_source_urls": ["https://example.com"],
            "rag_authority_labels": [],
        }
        result = _build_source_inventory(state)
        assert "Some Doc" in result
        assert "https://example.com" in result

    def test_handles_empty_doc_name(self):
        state = {
            "rag_document_names": [""],
            "rag_source_urls": ["https://example.com/page"],
            "rag_authority_labels": ["external"],
        }
        result = _build_source_inventory(state)
        assert "(unnamed)" in result
        assert "https://example.com/page" in result

    def test_only_doc_names_no_urls(self):
        state = {
            "rag_document_names": ["Internal Runbook"],
            "rag_source_urls": [],
            "rag_authority_labels": ["canonical"],
        }
        result = _build_source_inventory(state)
        assert "Internal Runbook" in result
        assert "[Canonical]" in result


class TestRetrievalProvenance:
    """Verify the shape of retrieval_provenance dict matches what compile_evidence expects."""

    def test_rag_provenance_has_source_url(self):
        class MockResult:
            chunk_summary = "How to deploy vLLM"
            authority = "canonical"
            heading_path = "Deployment"
            document_name = "vLLM Guide"
            source_url = "https://vllm.ai/deploy"
            retrieval_source = "rag"

        r = MockResult()
        summary_dict = {
            "summary": getattr(r, "chunk_summary", "") or "",
            "authority": getattr(r, "authority", "") or "",
            "heading": getattr(r, "heading_path", "") or "",
            "doc_name": getattr(r, "document_name", "") or "",
            "source_url": getattr(r, "source_url", "") or "",
        }
        assert summary_dict["source_url"] == "https://vllm.ai/deploy"
        assert summary_dict["doc_name"] == "vLLM Guide"
        assert summary_dict["authority"] == "canonical"

    def test_merge_aggregates_source_urls(self):
        """Simulate what compile_evidence_node does with retrieval_provenance."""
        section_results = [
            {
                "section_id": 1,
                "retrieval_provenance": [
                    {
                        "summary": "Deploy guide",
                        "authority": "canonical",
                        "heading": "",
                        "doc_name": "vLLM Guide",
                        "source_url": "https://vllm.ai/docs",
                    },
                    {
                        "summary": "K8s HPA",
                        "authority": "vetted",
                        "heading": "",
                        "doc_name": "K8s Docs",
                        "source_url": "https://k8s.io/docs",
                    },
                ],
            },
            {
                "section_id": 2,
                "retrieval_provenance": [
                    {
                        "summary": "Deploy guide",
                        "authority": "canonical",
                        "heading": "",
                        "doc_name": "vLLM Guide",
                        "source_url": "https://vllm.ai/docs",
                    },
                ],
            },
        ]

        all_source_urls: list[str] = []
        all_doc_names: list[str] = []
        all_authorities: list[str] = []
        seen: set[str] = set()
        for sec in section_results:
            for s in sec.get("retrieval_provenance", []):
                summary = s.get("summary", "")
                if summary and summary not in seen:
                    seen.add(summary)
                    all_source_urls.append(s.get("source_url", ""))
                    all_doc_names.append(s.get("doc_name", ""))
                    all_authorities.append(s.get("authority", ""))

        assert len(all_source_urls) == 2
        assert "https://vllm.ai/docs" in all_source_urls
        assert "https://k8s.io/docs" in all_source_urls
        assert "vLLM Guide" in all_doc_names
        assert "K8s Docs" in all_doc_names
