"""Factory functions producing RetrievalResult objects at each authority tier.

Used by test_authority_ranking.py and any test that needs realistic
provenance metadata without a live Milvus connection.
"""

from __future__ import annotations

from app.state import RetrievalResult


def make_canonical_chunk(text: str = "Internal ADR: Use event sourcing for audit trail.") -> RetrievalResult:
    return RetrievalResult(
        text=text,
        source="kb:adr-event-sourcing section:Decision",
        collection="synesis_catalog",
        retrieval_source="both",
        vector_score=0.88,
        bm25_score=12.5,
        rrf_score=0.042,
        origin_type="internal",
        authority="canonical",
        indexer_source="knowledge_base",
        domain="knowledge",
    )


def make_vetted_chunk(text: str = "AWS Well-Architected: design for failure with retry and circuit breaker.") -> RetrievalResult:
    return RetrievalResult(
        text=text,
        source="doc:AWS Well-Architected Framework section:Reliability",
        collection="synesis_catalog",
        retrieval_source="vector",
        vector_score=0.82,
        rrf_score=0.035,
        origin_type="curated",
        authority="vetted",
        indexer_source="architecture",
        domain="cloud",
        source_url="https://docs.aws.amazon.com/pdfs/wellarchitected/latest/framework/wellarchitected-framework.pdf",
    )


def make_community_chunk(text: str = "OpenShift runbook: restart failing etcd pod with oc debug.") -> RetrievalResult:
    return RetrievalResult(
        text=text,
        source="doc:openshift/runbooks:alerts/etcd section:Remediation",
        collection="synesis_catalog",
        retrieval_source="bm25",
        bm25_score=9.2,
        rrf_score=0.028,
        origin_type="curated",
        authority="community",
        indexer_source="domain",
        domain="openshift",
        source_url="https://github.com/openshift/runbooks/blob/master/alerts/etcd.md",
    )


def make_external_chunk(text: str = "FastAPI uses Starlette for ASGI and Pydantic for validation.") -> RetrievalResult:
    return RetrievalResult(
        text=text,
        source="repo:tiangolo/fastapi path:fastapi/main.py",
        collection="synesis_catalog",
        retrieval_source="vector",
        vector_score=0.71,
        rrf_score=0.018,
        origin_type="external",
        authority="external",
        indexer_source="code",
        domain="python",
        source_url="https://github.com/tiangolo/fastapi",
    )


def all_tiers() -> list[RetrievalResult]:
    """Return one chunk per authority tier in descending authority order."""
    return [
        make_canonical_chunk(),
        make_vetted_chunk(),
        make_community_chunk(),
        make_external_chunk(),
    ]
