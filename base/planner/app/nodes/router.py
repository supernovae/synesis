"""Router node — the single retrieval orchestrator for the entire graph.

The Router is a LangGraph node, NOT an LLM persona. It owns all system-level
retrieval logic (parallel dispatch, caching, deduplication, bounds enforcement,
confidence-gated refinement) and invokes LLMs only for focused sub-tasks:
    generate_query()  — narrow query from evidence request
    summarize()       — raw results → EvidencePacket
    refine_query()    — tighten a low-confidence query

No other node may import retrieval backends (rag_client, web_search,
unified_retrieval, query_distiller). This is enforced by test_router_governance.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..config import settings
from ..llm_telemetry import get_llm_http_client
from ..retrieval_cache import HybridRetrievalCache, get_retrieval_cache
from ..schemas import safe_parse_json
from ..state import EvidencePacket, EvidenceSnippet, EvidenceSource, NodeOutcome, NodeTrace
from ..unified_retrieval import RetrievalBundle, UnifiedResult, retrieve_unified

logger = logging.getLogger("synesis.router")

# ---------------------------------------------------------------------------
# Retrieval bounds (deterministic, enforced in system code)
# ---------------------------------------------------------------------------
_MAX_DOCS_BASE = 5
_MAX_DOCS_HARD = 8
MAX_SNIPPETS_PER_PACKET = 20
MAX_REFINEMENT_ROUNDS = 2
LOW_CONFIDENCE_THRESHOLD = 0.4


def max_docs_for_difficulty(difficulty: float = 0.5) -> int:
    """Scale per-query doc cap: 5 for easy tasks, up to 8 for difficulty >= 0.7."""
    if difficulty >= 0.7:
        return _MAX_DOCS_HARD
    return _MAX_DOCS_BASE


# Backwards-compat alias used by tests
MAX_DOCS_PER_QUERY = _MAX_DOCS_BASE

# ---------------------------------------------------------------------------
# LLM prompts — focused single-output-type contracts
# ---------------------------------------------------------------------------

QUERY_GENERATOR_PROMPT = """\
ROLE: Retrieval Query Generator

Generate a retrieval query that balances recall and precision for the evidence request below.

EVIDENCE REQUEST:
{request}

TASK CONTEXT:
{task_context}

RULES:
- Include the task, domain, and specific entities.
- Include related concepts and synonyms that relevant documents might use.
- Include file types, repo paths, or keywords when known.
- Include both the specific topic AND broader related terms.
  Good: "internal coding assistant architecture RAG retrieval design"
  Bad: "Kubernetes" (too vague), "Kubernetes pod networking DNS resolution CoreDNS troubleshooting" (too narrow)
- Output ONLY the query string, nothing else. No explanations, no reasoning.
"""

HYDE_PROMPT = """\
Write a 2-3 sentence summary that would appear in a document answering this question. \
Write as if it already exists. Output ONLY the summary, no explanation.

QUESTION: {question}
"""

CONCEPTUAL_EXPANSION_PROMPT = """\
Given this retrieval need, list 5-8 related terms, synonyms, or concepts \
that relevant documents might use instead. Output terms separated by spaces, nothing else.

NEED: {need}
DOMAIN: {domain}
{expansion_hints}
"""

SUMMARIZER_PROMPT = """\
ROLE: Retrieval Summarizer

Convert the raw retrieved documents below into a structured evidence packet.

QUERY: {query}
{cohesion_constraint}
RAW RESULTS:
{raw_results}

RULES:
1. Select only the most relevant snippets (max {max_snippets}).
2. Rank snippets by semantic relevance to the query.
3. Remove noise, boilerplate, and unrelated content.
4. Summarize retrieved content into a concise, factual summary (max {max_summary_tokens} tokens).
5. Estimate confidence:
   - High (0.7-1.0): strong, consistent evidence
   - Medium (0.4-0.7): partial or incomplete evidence
   - Low (<0.4): insufficient evidence
6. If evidence is insufficient, set confidence < 0.4 and explain in retrieval_notes.
7. Do NOT invent facts or fill gaps with assumptions.
8. Highlight contradictions or uncertainty.
9. CRITICAL — Source attribution:
   - Copy each raw result's "url" VERBATIM into the corresponding sources[].uri
   - Copy each raw result's "url" VERBATIM into snippets[].source_uri for every snippet from that result
   - Do NOT omit, shorten, or fabricate URLs
   - Include "authority" and "document" in sources[].metadata when available

Output ONLY valid JSON matching this schema (no markdown fences, no prose):
{{
  "query": "...",
  "sources": [{{"uri": "https://...", "type": "doc|code|wiki|web|repo|api", "metadata": {{"authority": "...", "document_name": "..."}}}}],
  "snippets": [{{"text": "...", "relevance": 0.0, "source_uri": "https://..."}}],
  "summary": "...",
  "confidence": 0.0,
  "retrieval_notes": "..."
}}
"""


def _build_cohesion_constraint(cohesion_lock: dict[str, Any] | None) -> str:
    """Build a COHESION CONSTRAINT block for the summarizer prompt."""
    if not cohesion_lock:
        return ""
    entity = cohesion_lock.get("entity", "")
    if not entity:
        return ""
    exclude = cohesion_lock.get("exclude_signals") or []
    exclude_line = f"Exclude content about: {', '.join(exclude[:8])}.\n" if exclude else ""
    return (
        f"\nCOHESION CONSTRAINT:\n"
        f"All content MUST stay within the conceptual frame: {entity}.\n"
        f"{exclude_line}"
        f"Do NOT introduce information from outside this frame.\n"
        f"If a snippet touches an excluded topic, omit it entirely.\n"
    )


REFINER_PROMPT = """\
ROLE: Retrieval Query Refiner

The initial query returned low-confidence evidence. Refine it to be more specific.

ORIGINAL QUERY: {query}

EVIDENCE PACKET SUMMARY: {summary}
CONFIDENCE: {confidence}
RETRIEVAL NOTES: {retrieval_notes}

REFINEMENT RULES:
1. Identify the exact information missing.
2. Extract domain anchors: service names, repo paths, file types, technologies.
3. Rewrite the query to target ONLY the missing evidence.
4. Do NOT broaden the search.
5. Prefer queries shaped like:
   "<entity> + <action> + <technology>"
   "<repo path> + <file type> + <concept>"
   "<component> + <error> + <context>"

Output ONLY the refined query string, nothing else.
"""


# ---------------------------------------------------------------------------
# Router LLMs (lazily initialised to avoid import-time side effects)
# ---------------------------------------------------------------------------

_router_llm: ChatOpenAI | None = None
_summarizer_llm: ChatOpenAI | None = None


def _get_router_llm() -> ChatOpenAI:
    """Plain router LLM for generate_query / refine_query (free-form text)."""
    global _router_llm
    if _router_llm is None:
        _router_llm = ChatOpenAI(
            base_url=settings.router_model_url,
            api_key="not-needed",
            model=settings.router_model_name,
            temperature=0.0,
            max_completion_tokens=settings.router_max_summary_tokens,
            use_responses_api=False,
            http_client=get_llm_http_client(uds_path=settings.router_model_uds or None),
        )
    return _router_llm


def _get_summarizer_llm() -> ChatOpenAI:
    """Router LLM with guided_json for evidence packet summarization."""
    global _summarizer_llm
    if _summarizer_llm is None:
        extra_body: dict[str, Any] = {}
        model_kw: dict[str, Any] = {}
        if settings.guided_json_enabled:
            _ep_schema = EvidencePacket.model_json_schema()
            _ep_schema.pop("title", None)
            extra_body["guided_json"] = _ep_schema
        else:
            model_kw["response_format"] = {"type": "json_object"}
        if extra_body:
            model_kw["extra_body"] = extra_body

        _summarizer_llm = ChatOpenAI(
            base_url=settings.router_model_url,
            api_key="not-needed",
            model=settings.router_model_name,
            temperature=0.0,
            max_completion_tokens=settings.router_max_summary_tokens,
            streaming=False,
            use_responses_api=False,
            model_kwargs=model_kw,
            http_client=get_llm_http_client(uds_path=settings.router_model_uds or None),
        )
    return _summarizer_llm


# ---------------------------------------------------------------------------
# RouterNode — the orchestrator
# ---------------------------------------------------------------------------


class RouterNode:
    """Deterministic retrieval orchestrator. Invokes LLMs for sub-tasks only."""

    def __init__(
        self,
        cache: HybridRetrievalCache | None = None,
    ) -> None:
        self.cache = cache or get_retrieval_cache()
        timeout = float(getattr(settings, "node_timeout_seconds", 180.0))
        self.request_timeout_seconds = max(30.0, timeout * 0.7)
        self.retrieve_timeout_seconds = max(10.0, min(60.0, timeout * 0.33))
        self.summarize_timeout_seconds = max(10.0, min(45.0, timeout * 0.25))
        self.refine_timeout_seconds = max(8.0, min(30.0, timeout * 0.2))

    # ----- LLM sub-tasks -----

    async def generate_query(self, evidence_request: dict[str, Any], task_context: str = "") -> str:
        """Use LLM to produce a retrieval query from an evidence request."""
        llm = _get_router_llm()
        prompt = QUERY_GENERATOR_PROMPT.format(
            request=json.dumps(evidence_request, default=str),
            task_context=task_context[:500],
        )
        resp = await llm.ainvoke(
            [
                SystemMessage(content="You generate retrieval queries. Output only the query string."),
                HumanMessage(content=prompt),
            ]
        )
        return resp.content.strip().strip('"').strip("'")

    async def generate_hyde_variant(self, question: str) -> str:
        """Generate a hypothetical document snippet for HyDE vector search."""
        if not settings.router_hyde_enabled:
            return ""
        llm = _get_router_llm()
        prompt = HYDE_PROMPT.format(question=question[:300])
        resp = await llm.ainvoke(
            [
                SystemMessage(content="You write hypothetical document snippets. Output only the text."),
                HumanMessage(content=prompt),
            ]
        )
        return resp.content.strip()[:500]

    async def generate_conceptual_expansion(
        self,
        need: str,
        domain_hints: list[str] | None = None,
        expansion_hints: list[str] | None = None,
        technologies: list[str] | None = None,
    ) -> str:
        """Generate an expanded query with related terms and synonyms."""
        if not settings.taxonomy_query_expansion_enabled:
            return ""
        domain = ", ".join(domain_hints[:3]) if domain_hints else "general"
        hints_block = ""
        if expansion_hints:
            hints_block = f"RELATED CONCEPTS: {', '.join(expansion_hints[:6])}"
        tech_terms = " ".join(technologies[:4]) if technologies else ""

        llm = _get_router_llm()
        prompt = CONCEPTUAL_EXPANSION_PROMPT.format(
            need=need[:300],
            domain=domain,
            expansion_hints=hints_block,
        )
        resp = await llm.ainvoke(
            [
                SystemMessage(content="You expand queries with related terms. Output space-separated terms only."),
                HumanMessage(content=prompt),
            ]
        )
        expanded_terms = resp.content.strip()[:200]
        parts = [need]
        if tech_terms:
            parts.append(tech_terms)
        parts.append(expanded_terms)
        return " ".join(parts)

    async def generate_query_variants(
        self,
        evidence_request: dict[str, Any],
        task_context: str = "",
        taxonomy_metadata: dict[str, Any] | None = None,
    ) -> list[str]:
        """Generate 1-3 query variants: direct, HyDE, conceptual expansion.

        Returns at least the direct query. HyDE and expansion are parallel
        and controlled by config toggles. When query normalization corrected
        the input, the original (uncorrected) query is included as an
        additional variant so RRF can compare retrieval quality.
        """
        direct_query = await self.generate_query(evidence_request, task_context)

        difficulty = evidence_request.get("_difficulty", 0.5)

        if not settings.router_multi_query_enabled or difficulty < 0.3:
            variants = [direct_query]
            original_q = evidence_request.get("original_query")
            if original_q and original_q != direct_query:
                variants.append(original_q)
            return variants

        domain_hints = evidence_request.get("domain_hints") or []
        technologies = evidence_request.get("technologies") or []

        expansion_hints: list[str] = []
        if taxonomy_metadata and settings.taxonomy_query_expansion_enabled:
            from ..taxonomy_prompt_factory import get_query_expansion_hints

            expansion_hints = get_query_expansion_hints(taxonomy_metadata)

        tasks: list[asyncio.Task[str]] = []
        if settings.router_hyde_enabled and difficulty >= 0.5:
            tasks.append(asyncio.create_task(self.generate_hyde_variant(direct_query)))
        if settings.taxonomy_query_expansion_enabled:
            tasks.append(
                asyncio.create_task(
                    self.generate_conceptual_expansion(
                        evidence_request.get("description", direct_query),
                        domain_hints=domain_hints,
                        expansion_hints=expansion_hints,
                        technologies=technologies,
                    )
                )
            )

        variants = [direct_query]
        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for r in results:
                if isinstance(r, str) and r.strip():
                    variants.append(r.strip())
                elif isinstance(r, Exception):
                    logger.debug("query_variant_failed", extra={"error": str(r)[:100]})

        original_q = evidence_request.get("original_query")
        if original_q and original_q not in variants:
            variants.append(original_q)

        logger.debug(
            "query_variants_generated",
            extra={"count": len(variants), "direct": direct_query[:80]},
        )
        return variants

    async def batch_generate_queries(
        self,
        requests: list[dict[str, Any]],
        task_context: str = "",
    ) -> list[str]:
        """Generate retrieval queries for multiple evidence requests in a single LLM call.

        Reduces N sequential LLM round-trips to 1, cutting router latency significantly
        for multi-deliverable prompts.
        """
        if len(requests) <= 1:
            return [await self.generate_query(requests[0], task_context)] if requests else []

        numbered = "\n".join(f"[{i + 1}] {json.dumps(req, default=str)}" for i, req in enumerate(requests))
        prompt = (
            f"Generate one balanced retrieval query for EACH evidence request below.\n\n"
            f"TASK CONTEXT:\n{task_context[:500]}\n\n"
            f"EVIDENCE REQUESTS:\n{numbered}\n\n"
            f"RULES:\n"
            f"- Include the task, domain, specific entities, AND related concepts.\n"
            f"- Balance recall and precision — include synonyms and broader terms.\n"
            f"- Output EXACTLY {len(requests)} lines, one query per line.\n"
            f"- Line N corresponds to request [N].\n"
            f"- No numbering, no explanations — just the query strings."
        )
        llm = _get_router_llm()
        resp = await llm.ainvoke(
            [
                SystemMessage(content="You generate retrieval queries. Output one query per line."),
                HumanMessage(content=prompt),
            ]
        )
        lines = [ln.strip().strip('"').strip("'") for ln in resp.content.strip().splitlines() if ln.strip()]
        cleaned: list[str] = []
        for ln in lines:
            ln = re.sub(r"^\[?\d+\]?\s*\.?\s*", "", ln).strip()
            if ln:
                cleaned.append(ln)

        if len(cleaned) == len(requests):
            return cleaned

        logger.warning(
            "batch_query_gen_fallback",
            extra={"expected": len(requests), "got": len(cleaned)},
        )
        return [await self.generate_query(req, task_context) for req in requests]

    async def summarize(
        self,
        query: str,
        results: list[UnifiedResult],
        cohesion_lock: dict[str, Any] | None = None,
    ) -> EvidencePacket:
        """Use LLM to convert raw retrieval results into a structured EvidencePacket."""
        results_text = self._format_raw_results(results)
        llm = _get_summarizer_llm()
        prompt = SUMMARIZER_PROMPT.format(
            query=query,
            raw_results=results_text,
            max_snippets=MAX_SNIPPETS_PER_PACKET,
            max_summary_tokens=settings.router_max_summary_tokens,
            cohesion_constraint=_build_cohesion_constraint(cohesion_lock),
        )
        resp = await llm.ainvoke(
            [
                SystemMessage(content="You summarize retrieval results into structured JSON evidence packets."),
                HumanMessage(content=prompt),
            ]
        )
        return self._parse_evidence_packet(query, resp.content, results)

    async def refine_query(self, query: str, packet: EvidencePacket) -> str:
        """Use LLM to produce a more specific query when evidence is insufficient."""
        llm = _get_router_llm()
        prompt = REFINER_PROMPT.format(
            query=query,
            summary=packet.summary[:300],
            confidence=packet.confidence,
            retrieval_notes=packet.retrieval_notes[:200],
        )
        resp = await llm.ainvoke(
            [
                SystemMessage(content="You refine retrieval queries. Output only the refined query string."),
                HumanMessage(content=prompt),
            ]
        )
        return resp.content.strip().strip('"').strip("'")

    # ----- System-level methods (no LLM) -----

    async def retrieve(
        self,
        query: str,
        difficulty: float = 0.5,
        domain_hints: list[str] | None = None,
        force_web: bool = False,
        skip_web: bool = False,
        preferred_web_scopes: list[str] | None = None,
        search_source_ids: list[str] | None = None,
    ) -> RetrievalBundle:
        """Call unified retrieval with bounds enforcement and taxonomy-driven filtering."""
        web_query = query[:80]
        if preferred_web_scopes and not skip_web:
            scope_suffix = " ".join(preferred_web_scopes[:2])
            web_query = f"{web_query} {scope_suffix}"

        doc_cap = max_docs_for_difficulty(difficulty)
        bundle = await retrieve_unified(
            query=query,
            difficulty=difficulty,
            top_k=doc_cap,
            web_query=web_query,
            domain_hints=domain_hints,
            force_web=force_web,
            skip_web=skip_web,
            search_source_ids=search_source_ids,
        )
        bundle.results = bundle.results[:doc_cap]
        return bundle

    def dedupe(self, packets: list[EvidencePacket]) -> list[EvidencePacket]:
        """Content-hash deduplication across packets. Merge overlapping sources."""
        seen_hashes: set[str] = set()
        deduped: list[EvidencePacket] = []
        for packet in packets:
            content_hash = hashlib.blake2b(
                f"{packet.query}:{packet.summary[:100]}".encode(), digest_size=16
            ).hexdigest()
            if content_hash not in seen_hashes:
                seen_hashes.add(content_hash)
                deduped.append(packet)
        return deduped

    async def parallel_dispatch(
        self,
        requests: list[dict[str, Any]],
        task_context: str = "",
        difficulty: float = 0.5,
        taxonomy_metadata: dict[str, Any] | None = None,
    ) -> tuple[list[EvidencePacket], dict[str, Any] | None]:
        """Dispatch independent evidence requests concurrently.

        Returns (packets, cohesion_lock_dict). The lock is taken from the
        first request that produces one (typically the main_question request).
        """
        # Batch query generation: generate all base queries in a single LLM
        # call, then let handle_single_request use them (with optional HyDE
        # and expansion on top when multi_query is enabled).
        queries = await self.batch_generate_queries(requests, task_context)

        async def _run_request(req: dict[str, Any], q: str) -> tuple[EvidencePacket, dict[str, Any] | None]:
            query_hint = q or str(req.get("description") or "")[:120]
            try:
                return await asyncio.wait_for(
                    self.handle_single_request(
                        req,
                        task_context,
                        difficulty,
                        precomputed_query=q,
                        taxonomy_metadata=taxonomy_metadata,
                    ),
                    timeout=self.request_timeout_seconds,
                )
            except TimeoutError:
                logger.warning(
                    "router_request_timeout",
                    extra={"query": query_hint[:80], "timeout_seconds": round(self.request_timeout_seconds, 1)},
                )
                return _timeout_packet(
                    query_hint or "evidence request",
                    f"Evidence request timed out after {self.request_timeout_seconds:.1f}s",
                ), None

        tasks = [_run_request(req, q) for req, q in zip(requests, queries)]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        packets: list[EvidencePacket] = []
        cohesion_lock: dict[str, Any] | None = None
        for idx, r in enumerate(results):
            req = requests[idx] if idx < len(requests) else {}
            query_hint = ""
            if idx < len(queries):
                query_hint = queries[idx]
            if not query_hint:
                query_hint = str(req.get("description") or req.get("query") or "evidence request")[:120]
            if isinstance(r, tuple) and len(r) == 2:
                packet, lock = r
                if isinstance(packet, EvidencePacket):
                    packets.append(packet)
                if cohesion_lock is None and lock:
                    cohesion_lock = lock
            elif isinstance(r, Exception):
                logger.warning("parallel_dispatch_error", extra={"error": str(r)[:200]})
                packets.append(_timeout_packet(query_hint, f"Evidence request failed ({type(r).__name__})"))
        return packets, cohesion_lock

    async def _multi_query_retrieve(
        self,
        variants: list[str],
        difficulty: float,
        domain_hints: list[str] | None = None,
        skip_web: bool = False,
        preferred_web_scopes: list[str] | None = None,
        search_source_ids: list[str] | None = None,
    ) -> RetrievalBundle:
        """Retrieve using multiple query variants and merge via RRF."""
        if len(variants) <= 1:
            return await self.retrieve(
                variants[0],
                difficulty,
                domain_hints=domain_hints,
                skip_web=skip_web,
                preferred_web_scopes=preferred_web_scopes,
                search_source_ids=search_source_ids,
            )

        tasks = [
            self.retrieve(
                q,
                difficulty,
                domain_hints=domain_hints,
                skip_web=skip_web,
                preferred_web_scopes=preferred_web_scopes,
                search_source_ids=search_source_ids,
            )
            for q in variants
        ]
        all_results = await asyncio.gather(*tasks, return_exceptions=True)

        per_query_results: list[list[UnifiedResult]] = []
        first_lock: dict[str, Any] | None = None
        _any_rag_degraded = False
        _any_web_degraded = False
        _deg_notes: list[str] = []
        for r in all_results:
            if isinstance(r, RetrievalBundle):
                per_query_results.append(r.results)
                if first_lock is None and r.cohesion_lock:
                    first_lock = r.cohesion_lock
                if r.rag_degraded:
                    _any_rag_degraded = True
                if r.web_degraded:
                    _any_web_degraded = True
                if r.degradation_notes:
                    _deg_notes.append(r.degradation_notes)
            elif isinstance(r, Exception):
                logger.debug("multi_query_retrieve_error", extra={"error": str(r)[:100]})

        _deg = "; ".join(dict.fromkeys(_deg_notes)) if _deg_notes else ""

        if not per_query_results:
            return RetrievalBundle(
                results=[], rag_degraded=_any_rag_degraded, web_degraded=_any_web_degraded, degradation_notes=_deg
            )
        if len(per_query_results) == 1:
            return RetrievalBundle(
                results=per_query_results[0],
                cohesion_lock=first_lock,
                rag_degraded=_any_rag_degraded,
                web_degraded=_any_web_degraded,
                degradation_notes=_deg,
            )

        merged = _rrf_merge(per_query_results, k=60)
        return RetrievalBundle(
            results=merged,
            cohesion_lock=first_lock,
            rag_degraded=_any_rag_degraded,
            web_degraded=_any_web_degraded,
            degradation_notes=_deg,
        )

    async def handle_single_request(
        self,
        evidence_request: dict[str, Any],
        task_context: str = "",
        difficulty: float = 0.5,
        precomputed_query: str | None = None,
        taxonomy_metadata: dict[str, Any] | None = None,
    ) -> tuple[EvidencePacket, dict[str, Any] | None]:
        """Full pipeline for one evidence request: query -> cache -> retrieve -> summarize -> refine.

        Returns (packet, cohesion_lock_dict) — lock may be None.
        """
        domain_hints = evidence_request.get("domain_hints") or []
        skip_web = evidence_request.get("skip_web", False)
        search_source_ids: list[str] = evidence_request.get("search_source_ids") or []

        preferred_web_scopes: list[str] = []
        if taxonomy_metadata:
            from ..taxonomy_prompt_factory import get_preferred_web_scopes

            preferred_web_scopes = get_preferred_web_scopes(taxonomy_metadata)

        light_mode = evidence_request.get("_light_mode", False)

        evidence_request.setdefault("_difficulty", difficulty)

        if light_mode or not settings.router_multi_query_enabled or precomputed_query:
            query = precomputed_query or await self.generate_query(evidence_request, task_context)
            variants = [query]
        else:
            variants = await self.generate_query_variants(evidence_request, task_context, taxonomy_metadata)
            query = variants[0]

        cached = await self.cache.aget(query)
        if cached is not None:
            if evidence_request.get("section_id") is not None:
                cached = cached.model_copy(update={"section_id": evidence_request["section_id"]})
            return cached, None

        doc_cap_override = 3 if light_mode else None
        try:
            bundle = await asyncio.wait_for(
                self._multi_query_retrieve(
                    variants,
                    difficulty,
                    domain_hints=domain_hints,
                    skip_web=skip_web,
                    preferred_web_scopes=preferred_web_scopes,
                    search_source_ids=search_source_ids or None,
                ),
                timeout=self.retrieve_timeout_seconds,
            )
        except TimeoutError:
            logger.warning(
                "router_retrieve_timeout",
                extra={"query": query[:80], "timeout_seconds": round(self.retrieve_timeout_seconds, 1)},
            )
            return _timeout_packet(query, f"Retrieval timed out after {self.retrieve_timeout_seconds:.1f}s"), None
        cohesion_lock = bundle.cohesion_lock
        try:
            packet = await asyncio.wait_for(
                self.summarize(
                    query,
                    bundle.results[:doc_cap_override] if doc_cap_override else bundle.results,
                    cohesion_lock=cohesion_lock,
                ),
                timeout=self.summarize_timeout_seconds,
            )
        except TimeoutError:
            logger.warning(
                "router_summarize_timeout",
                extra={"query": query[:80], "timeout_seconds": round(self.summarize_timeout_seconds, 1)},
            )
            packet = _fallback_packet(query, bundle.results)
            existing_notes = packet.retrieval_notes or ""
            sep = "; " if existing_notes else ""
            packet = packet.model_copy(update={"retrieval_notes": f"{existing_notes}{sep}summarization timed out"})
        update_fields: dict[str, Any] = {"section_id": evidence_request.get("section_id")}
        if bundle.degradation_notes:
            existing_notes = packet.retrieval_notes or ""
            sep = "; " if existing_notes else ""
            update_fields["retrieval_notes"] = f"{existing_notes}{sep}{bundle.degradation_notes}"
        packet = packet.model_copy(update=update_fields)

        # Skip refinement rounds for light mode
        max_refine = 0 if light_mode else MAX_REFINEMENT_ROUNDS
        rounds = 0
        while packet.confidence < LOW_CONFIDENCE_THRESHOLD and rounds < max_refine:
            try:
                refined_query = await asyncio.wait_for(
                    self.refine_query(query, packet),
                    timeout=self.refine_timeout_seconds,
                )
            except TimeoutError:
                logger.warning(
                    "router_refine_timeout",
                    extra={"query": query[:80], "timeout_seconds": round(self.refine_timeout_seconds, 1)},
                )
                existing_notes = packet.retrieval_notes or ""
                sep = "; " if existing_notes else ""
                packet = packet.model_copy(
                    update={"retrieval_notes": f"{existing_notes}{sep}query refinement timed out"}
                )
                break
            cached = await self.cache.aget(refined_query)
            if cached is not None:
                packet = cached
                if evidence_request.get("section_id") is not None:
                    packet = packet.model_copy(update={"section_id": evidence_request["section_id"]})
                break
            try:
                refine_bundle = await asyncio.wait_for(
                    self.retrieve(
                        refined_query,
                        difficulty,
                        domain_hints=domain_hints,
                        skip_web=skip_web,
                        preferred_web_scopes=preferred_web_scopes,
                        search_source_ids=search_source_ids or None,
                    ),
                    timeout=self.retrieve_timeout_seconds,
                )
            except TimeoutError:
                logger.warning(
                    "router_refine_retrieve_timeout",
                    extra={"query": refined_query[:80], "timeout_seconds": round(self.retrieve_timeout_seconds, 1)},
                )
                existing_notes = packet.retrieval_notes or ""
                sep = "; " if existing_notes else ""
                packet = packet.model_copy(
                    update={"retrieval_notes": f"{existing_notes}{sep}refined retrieval timed out"}
                )
                break
            if cohesion_lock is None and refine_bundle.cohesion_lock:
                cohesion_lock = refine_bundle.cohesion_lock
            try:
                packet = await asyncio.wait_for(
                    self.summarize(refined_query, refine_bundle.results, cohesion_lock=cohesion_lock),
                    timeout=self.summarize_timeout_seconds,
                )
            except TimeoutError:
                logger.warning(
                    "router_refine_summarize_timeout",
                    extra={"query": refined_query[:80], "timeout_seconds": round(self.summarize_timeout_seconds, 1)},
                )
                packet = _fallback_packet(refined_query, refine_bundle.results)
                existing_notes = packet.retrieval_notes or ""
                sep = "; " if existing_notes else ""
                packet = packet.model_copy(
                    update={"retrieval_notes": f"{existing_notes}{sep}refined summarization timed out"}
                )
            packet = packet.model_copy(update={"section_id": evidence_request.get("section_id")})
            query = refined_query
            rounds += 1

        await self.cache.aput(query, packet)
        return packet, cohesion_lock

    # ----- Mode detection + main entry point -----

    def _detect_mode(self, state: dict[str, Any]) -> str:
        """Determine what the Router should do based on current state."""
        evidence_requests = state.get("evidence_requests") or []
        execution_plan = state.get("execution_plan") or {}
        need_more = state.get("need_more_evidence", False)

        if need_more and evidence_requests:
            return "refinement"
        if execution_plan and evidence_requests:
            return "section_evidence"
        return "initial"

    def _decide_next_node(self, state: dict[str, Any]) -> str:
        """Determine where to route after evidence gathering.

        Skips the planner for easy/medium tasks (rag_mode != normal) since
        the planner adds latency but little value when retrieval is light
        or disabled. Hard tasks (rag_mode=normal) always go through planner.
        """
        execution_plan = state.get("execution_plan") or {}
        is_code_task = state.get("is_code_task", False)
        task_is_trivial = state.get("task_is_trivial", False)
        rag_mode = state.get("rag_mode", "normal")

        if task_is_trivial:
            return "executor" if is_code_task else "writer"
        if rag_mode != "normal" and not execution_plan:
            return "executor" if is_code_task else "writer"
        if not execution_plan:
            return "planner"
        return "executor" if is_code_task else "writer"

    async def run(self, state: dict[str, Any]) -> dict[str, Any]:
        """LangGraph entry point."""
        start = time.monotonic()
        mode = self._detect_mode(state)

        task_desc = state.get("task_description", "")
        user_task = state.get("user_task") or {}
        difficulty = state.get("difficulty", 0.5)
        rag_mode = state.get("rag_mode", "normal")
        taxonomy_metadata = state.get("taxonomy_metadata") or {}
        task_context = f"{task_desc}\n{json.dumps(user_task, default=str)[:500]}"

        # Fast path: skip all retrieval when rag_mode is disabled.
        # Entry classifier sets this for difficulty < 0.3 (trivial + easy).
        if rag_mode == "disabled" and mode == "initial":
            next_node = self._decide_next_node(state)
            latency_ms = (time.monotonic() - start) * 1000
            logger.info(
                "router_skip_rag_disabled",
                extra={
                    "next_node": next_node,
                    "difficulty": round(difficulty, 2),
                    "latency_ms": round(latency_ms, 1),
                },
            )
            return {
                "evidence_packets": [],
                "evidence_requests": [],
                "need_more_evidence": False,
                "error": None,
                "next_node": next_node,
                "current_node": "router",
                "node_traces": [
                    NodeTrace(
                        node_name="router",
                        reasoning=f"rag_mode=disabled (difficulty={difficulty:.2f}), skipping retrieval",
                        confidence=0.0,
                        outcome=NodeOutcome.SUCCESS,
                        latency_ms=latency_ms,
                    )
                ],
            }

        evidence_requests = state.get("evidence_requests") or []

        if mode == "initial":
            if rag_mode == "light":
                requests = [self._build_light_request(state)]
            else:
                requests = self._build_initial_requests(state)
        elif mode in ("section_evidence", "refinement"):
            requests = evidence_requests
        else:
            requests = []

        if not requests:
            requests = [{"description": task_desc, "domain_hints": user_task.get("domain_tags", [])}]

        # Retrieval-aware validation: when query normalization corrected the
        # input, inject the original query so RRF can compare retrieval quality.
        norm = state.get("query_normalization") or {}
        if norm.get("changed_tokens") and settings.query_normalizer_search_both:
            original_q = norm.get("original_query", "")
            if original_q:
                for req in requests:
                    req.setdefault("original_query", original_q)

        # Light mode: force single-query retrieval (no HyDE, no expansion)
        if rag_mode == "light":
            for req in requests:
                req["_light_mode"] = True

        packets, cohesion_lock = await self.parallel_dispatch(requests, task_context, difficulty, taxonomy_metadata)
        packets = self.dedupe(packets)

        next_node = self._decide_next_node(state)
        latency_ms = (time.monotonic() - start) * 1000

        cs = self.cache.stats
        total_cache_lookups = cs.exact_hits + cs.semantic_hits + cs.misses
        cache_hit_rate = (cs.exact_hits + cs.semantic_hits) / max(1, total_cache_lookups)

        logger.info(
            "router_complete",
            extra={
                "mode": mode,
                "requests": len(requests),
                "packets": len(packets),
                "next_node": next_node,
                "latency_ms": round(latency_ms, 1),
                "cache_stats": cs.model_dump(),
                "evidence_packet_ids": [p.query for p in packets],
                "cache_hit_rate": round(cache_hit_rate, 4),
                "total_snippets": sum(len(p.snippets) for p in packets),
                "avg_confidence": round(sum(p.confidence for p in packets) / max(1, len(packets)), 4),
                "cohesion_lock": (cohesion_lock or {}).get("entity", "(none)"),
            },
        )

        # Aggregate degradation signals across all packets
        _any_degraded = any(p.retrieval_notes for p in packets)
        _deg_notes_all = [p.retrieval_notes for p in packets if p.retrieval_notes]
        _deg_summary = "; ".join(dict.fromkeys(_deg_notes_all)) if _deg_notes_all else ""

        # Publish knowledge gaps for low-confidence packets so admins can
        # discover what the RAG corpus is missing.
        _gap_threshold = getattr(settings, "curator_knowledge_gap_threshold", 0.4)
        for pkt in packets:
            if pkt.confidence < _gap_threshold:
                try:
                    from ..knowledge_backlog import publish_knowledge_gap

                    await publish_knowledge_gap(
                        query=pkt.query,
                        task_description=task_desc[:512],
                        collections_queried=["synesis_catalog"],
                        max_score=pkt.confidence,
                        platform_context="router",
                        target_language=state.get("target_language", "python"),
                    )
                except Exception:
                    logger.debug("knowledge_gap_publish_skipped", exc_info=True)

        result: dict[str, Any] = {
            "evidence_packets": [p.model_dump() for p in packets],
            "evidence_requests": [],
            "need_more_evidence": False,
            "error": None,
            "next_node": next_node,
            "current_node": "router",
            "retrieval_degraded": _any_degraded,
            "retrieval_degradation_notes": _deg_summary,
            "node_traces": [
                NodeTrace(
                    node_name="router",
                    reasoning=f"mode={mode}, dispatched {len(requests)} requests, produced {len(packets)} packets",
                    confidence=min((p.confidence for p in packets), default=0.0),
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=latency_ms,
                )
            ],
        }
        if cohesion_lock:
            result["cohesion_lock"] = cohesion_lock
        return result

    def _build_initial_requests(self, state: dict[str, Any]) -> list[dict[str, Any]]:
        """Build evidence requests from the frame/task for initial retrieval."""
        user_task = state.get("user_task") or {}
        task_desc = state.get("task_description", "")
        domain_tags = user_task.get("domain_tags") or []
        technologies = user_task.get("technologies") or []
        skip_web = not user_task.get("needs_web", True)

        # Resolve search source IDs from taxonomy + prompt cues
        search_source_ids = self._resolve_search_sources(state, domain_tags)

        base: dict[str, Any] = {
            "domain_hints": domain_tags,
            "technologies": technologies,
            "skip_web": skip_web,
        }
        if search_source_ids:
            base["search_source_ids"] = search_source_ids

        requests = []
        main_q = user_task.get("main_question", task_desc)
        if main_q:
            requests.append({**base, "description": main_q})

        deliverables = user_task.get("deliverables") or []
        if len(deliverables) > 10:
            for batch_idx in range(0, len(deliverables), 3):
                batch = deliverables[batch_idx : batch_idx + 3]
                combined = "; ".join(d if isinstance(d, str) else str(d) for d in batch)
                requests.append({**base, "section_id": batch_idx, "description": combined})
        else:
            for i, d in enumerate(deliverables):
                requests.append({**base, "section_id": i, "description": d if isinstance(d, str) else str(d)})

        return requests if requests else [{**base, "description": task_desc}]

    def _resolve_search_sources(self, state: dict[str, Any], domain_tags: list[str]) -> list[str]:
        """Determine which search sources to use based on taxonomy metadata and prompt cues.

        Extracts prompt-level source hints (e.g. "include github+jira") from the
        user's query and combines them with taxonomy-driven source selection from
        the search_sources catalog.
        """
        from ..search_sources import get_search_sources, select_sources

        all_sources = get_search_sources()
        if not all_sources:
            return []

        taxonomy_metadata = state.get("taxonomy_metadata") or {}
        task_type = ""
        if taxonomy_metadata:
            task_type = (
                str(taxonomy_metadata.get("taxonomy_key", "")).split(".")[-1]
                if taxonomy_metadata.get("taxonomy_key")
                else ""
            )

        prompt_hints = _extract_prompt_source_hints(state.get("task_description", ""), all_sources)

        selected = select_sources(
            all_sources,
            domain_tags=domain_tags,
            task_type=task_type,
            prompt_source_hints=prompt_hints,
        )
        ids = [s.id for s in selected]
        if ids:
            logger.debug(
                "search_sources_selected",
                extra={"source_ids": ids, "prompt_hints": prompt_hints[:5], "domain_tags": domain_tags[:5]},
            )
        return ids

    def _build_light_request(self, state: dict[str, Any]) -> dict[str, Any]:
        """Build a single evidence request for rag_mode=light.

        Uses only the main question (no per-deliverable fan-out) and marks
        the request for single-query retrieval (no HyDE, no expansion).
        """
        user_task = state.get("user_task") or {}
        task_desc = state.get("task_description", "")
        main_q = user_task.get("main_question", task_desc)
        return {
            "description": main_q or task_desc,
            "domain_hints": user_task.get("domain_tags") or [],
            "technologies": user_task.get("technologies") or [],
            "skip_web": not user_task.get("needs_web", True),
            "_light_mode": True,
        }

    # ----- Helpers -----

    @staticmethod
    def _format_raw_results(results: list[UnifiedResult]) -> str:
        """Format raw results for the summarizer prompt."""
        parts: list[str] = []
        for i, r in enumerate(results[:MAX_DOCS_PER_QUERY]):
            source_type = "web" if r.retrieval_source == "web" else "rag"
            source_label = f"{source_type}"
            if r.source_id:
                source_label = f"{source_type}/{r.source_id}"
            parts.append(
                f"[{i + 1}] ({source_label}) score={r.score:.3f} "
                f"authority={r.authority} url={r.source_url}\n"
                f"title: {r.title}\n"
                f"heading: {r.heading_path}\n"
                f"document: {r.document_name}\n"
                f"text: {r.text[:2000]}\n"
            )
        return "\n---\n".join(parts) if parts else "(no results retrieved)"

    @staticmethod
    def _parse_evidence_packet(
        query: str,
        llm_output: str,
        raw_results: list[UnifiedResult],
    ) -> EvidencePacket:
        """Parse LLM JSON output into an EvidencePacket with fallback."""
        # Build source_id lookup from raw results for provenance injection
        _url_to_source_id: dict[str, str] = {}
        for r in raw_results:
            if r.source_url and r.source_id:
                _url_to_source_id[r.source_url] = r.source_id

        try:
            data = safe_parse_json(llm_output)
            sources = []
            for s in data.get("sources", [])[:MAX_DOCS_PER_QUERY]:
                meta = dict(s.get("metadata", {}))
                uri = s.get("uri", "")
                sid = _url_to_source_id.get(uri, "")
                if sid:
                    meta.setdefault("source_id", sid)
                sources.append(
                    EvidenceSource(
                        uri=uri,
                        type=s.get("type", "doc"),
                        metadata=meta,
                    )
                )
            snippets = []
            for sn in data.get("snippets", [])[:MAX_SNIPPETS_PER_PACKET]:
                snippets.append(
                    EvidenceSnippet(
                        text=sn.get("text", ""),
                        relevance=min(1.0, max(0.0, float(sn.get("relevance", 0.5)))),
                        source_uri=sn.get("source_uri", ""),
                    )
                )
            return EvidencePacket(
                query=data.get("query", query),
                sources=sources,
                snippets=snippets,
                summary=str(data.get("summary", ""))[: settings.router_max_summary_tokens * 4],
                confidence=min(1.0, max(0.0, float(data.get("confidence", 0.5)))),
                retrieval_notes=str(data.get("retrieval_notes", "")),
            )
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
            logger.warning("evidence_packet_parse_fallback", extra={"error": str(exc)[:200]})
            return _fallback_packet(query, raw_results)


def _rrf_merge(
    per_query_results: list[list[UnifiedResult]],
    k: int = 60,
) -> list[UnifiedResult]:
    """Reciprocal Rank Fusion across multiple query result lists."""
    scores: dict[str, float] = {}
    result_map: dict[str, UnifiedResult] = {}

    for results in per_query_results:
        for rank, r in enumerate(results):
            key = r.source_url or f"text:{r.text[:80]}"
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank + 1)
            if key not in result_map or r.score > result_map[key].score:
                result_map[key] = r

    sorted_keys = sorted(scores, key=lambda x: scores[x], reverse=True)
    merged: list[UnifiedResult] = []
    for key in sorted_keys[:MAX_DOCS_PER_QUERY]:
        r = result_map[key]
        r.score = scores[key]
        merged.append(r)
    return merged


def _fallback_packet(query: str, raw_results: list[UnifiedResult]) -> EvidencePacket:
    """Build an EvidencePacket directly from raw results when LLM parsing fails."""
    sources = []
    snippets = []
    for r in raw_results[:MAX_DOCS_PER_QUERY]:
        src_type = "web" if r.retrieval_source == "web" else "doc"
        meta: dict[str, Any] = {
            "authority": r.authority,
            "origin_type": r.origin_type,
            "heading_path": r.heading_path,
            "document_name": r.document_name,
        }
        if r.source_id:
            meta["source_id"] = r.source_id
        sources.append(
            EvidenceSource(
                uri=r.source_url or r.title or "unknown",
                type=src_type,
                metadata=meta,
            )
        )
    for r in raw_results[:MAX_SNIPPETS_PER_PACKET]:
        snippets.append(
            EvidenceSnippet(
                text=r.text[:500],
                relevance=min(1.0, max(0.0, r.score)),
                source_uri=r.source_url or r.title or "unknown",
            )
        )

    summary = "\n".join(r.text[:200] for r in raw_results[:3])
    confidence = min(1.0, max(0.0, sum(r.score for r in raw_results[:3]) / max(len(raw_results[:3]), 1)))

    return EvidencePacket(
        query=query,
        sources=sources,
        snippets=snippets,
        summary=summary[: settings.router_max_summary_tokens * 4],
        confidence=confidence,
        retrieval_notes="Fallback: LLM summarization failed, evidence assembled from raw results.",
    )


def _extract_prompt_source_hints(
    prompt: str,
    all_sources: list | None = None,
) -> list[str]:
    """Delegate to search_sources.extract_prompt_source_hints()."""
    from ..search_sources import extract_prompt_source_hints

    return extract_prompt_source_hints(prompt, all_sources)


def _timeout_packet(query: str, reason: str) -> EvidencePacket:
    """Build a minimal packet when an evidence request times out/fails."""
    return EvidencePacket(
        query=(query or "evidence request")[:200],
        sources=[],
        snippets=[],
        summary="",
        confidence=0.0,
        retrieval_notes=reason[:300],
    )


# ---------------------------------------------------------------------------
# Module-level node function for LangGraph registration
# ---------------------------------------------------------------------------

_router_instance: RouterNode | None = None


def _get_router() -> RouterNode:
    global _router_instance
    if _router_instance is None:
        _router_instance = RouterNode()
    return _router_instance


async def router_node(state: dict[str, Any]) -> dict[str, Any]:
    """LangGraph node entry point."""
    return await _get_router().run(state)
