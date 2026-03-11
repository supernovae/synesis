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
from ..state import EvidencePacket, EvidenceSnippet, EvidenceSource, NodeOutcome, NodeTrace
from ..unified_retrieval import UnifiedResult, retrieve_unified

logger = logging.getLogger("synesis.router")

# ---------------------------------------------------------------------------
# Retrieval bounds (deterministic, enforced in system code)
# ---------------------------------------------------------------------------
MAX_DOCS_PER_QUERY = 5
MAX_SNIPPETS_PER_PACKET = 20
MAX_SUMMARY_TOKENS = 3000
MAX_REFINEMENT_ROUNDS = 2
LOW_CONFIDENCE_THRESHOLD = 0.4

# ---------------------------------------------------------------------------
# LLM prompts — focused single-output-type contracts
# ---------------------------------------------------------------------------

QUERY_GENERATOR_PROMPT = """\
ROLE: Retrieval Query Generator

Generate a single, narrow, high-precision retrieval query for the evidence request below.

EVIDENCE REQUEST:
{request}

TASK CONTEXT:
{task_context}

RULES:
- Include the task, domain, and specific entities.
- Include file types, repo paths, or keywords when known.
- Avoid vague queries like "Kubernetes", "Python", "Terraform".
- Prefer queries shaped like:
  "<entity> + <action> + <technology>"
  "<repo path> + <file type> + <concept>"
  "<component> + <error> + <context>"
- Output ONLY the query string, nothing else. No explanations, no reasoning.
"""

SUMMARIZER_PROMPT = """\
ROLE: Retrieval Summarizer

Convert the raw retrieved documents below into a structured evidence packet.

QUERY: {query}

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
            max_completion_tokens=MAX_SUMMARY_TOKENS,
            use_responses_api=False,
            http_client=get_llm_http_client(uds_path=settings.router_model_uds or None),
        )
    return _router_llm


def _get_summarizer_llm() -> ChatOpenAI:
    """Router LLM with guided_json for evidence packet summarization."""
    global _summarizer_llm
    if _summarizer_llm is None:
        extra_body: dict[str, Any] = {}
        if settings.guided_json_enabled:
            _ep_schema = EvidencePacket.model_json_schema()
            _ep_schema.pop("title", None)
            extra_body["guided_json"] = _ep_schema

        _summarizer_llm = ChatOpenAI(
            base_url=settings.router_model_url,
            api_key="not-needed",
            model=settings.router_model_name,
            temperature=0.0,
            max_completion_tokens=MAX_SUMMARY_TOKENS,
            streaming=False,
            use_responses_api=False,
            model_kwargs={"extra_body": extra_body} if extra_body else {},
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

    # ----- LLM sub-tasks -----

    async def generate_query(self, evidence_request: dict[str, Any], task_context: str = "") -> str:
        """Use LLM to produce a narrow retrieval query from an evidence request."""
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
            f"Generate one narrow, high-precision retrieval query for EACH evidence request below.\n\n"
            f"TASK CONTEXT:\n{task_context[:500]}\n\n"
            f"EVIDENCE REQUESTS:\n{numbered}\n\n"
            f"RULES:\n"
            f"- Include the task, domain, and specific entities.\n"
            f"- Avoid vague or generic queries.\n"
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
        # Strip leading "[N]" or "N." numbering if the model adds it despite instructions
        cleaned: list[str] = []
        for ln in lines:
            ln = re.sub(r"^\[?\d+\]?\s*\.?\s*", "", ln).strip()
            if ln:
                cleaned.append(ln)

        if len(cleaned) == len(requests):
            return cleaned

        # Fallback: if batch output is malformed, generate individually
        logger.warning(
            "batch_query_gen_fallback",
            extra={"expected": len(requests), "got": len(cleaned)},
        )
        return [await self.generate_query(req, task_context) for req in requests]

    async def summarize(self, query: str, results: list[UnifiedResult]) -> EvidencePacket:
        """Use LLM to convert raw retrieval results into a structured EvidencePacket."""
        results_text = self._format_raw_results(results)
        llm = _get_summarizer_llm()
        prompt = SUMMARIZER_PROMPT.format(
            query=query,
            raw_results=results_text,
            max_snippets=MAX_SNIPPETS_PER_PACKET,
            max_summary_tokens=MAX_SUMMARY_TOKENS,
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
    ) -> list[UnifiedResult]:
        """Call unified retrieval with bounds enforcement and taxonomy-driven filtering."""
        results = await retrieve_unified(
            query=query,
            difficulty=difficulty,
            top_k=MAX_DOCS_PER_QUERY,
            web_query=query[:80],
            domain_hints=domain_hints,
            force_web=force_web,
            skip_web=skip_web,
        )
        return results[:MAX_DOCS_PER_QUERY]

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
    ) -> list[EvidencePacket]:
        """Dispatch independent evidence requests concurrently.

        Phase 1: batch all query generation into a single LLM call.
        Phase 2: parallel retrieve + summarize + refine for each query.
        """
        queries = await self.batch_generate_queries(requests, task_context)
        tasks = [
            self.handle_single_request(req, task_context, difficulty, precomputed_query=q)
            for req, q in zip(requests, queries)
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        packets: list[EvidencePacket] = []
        for r in results:
            if isinstance(r, EvidencePacket):
                packets.append(r)
            elif isinstance(r, Exception):
                logger.warning("parallel_dispatch_error", extra={"error": str(r)[:200]})
        return packets

    async def handle_single_request(
        self,
        evidence_request: dict[str, Any],
        task_context: str = "",
        difficulty: float = 0.5,
        precomputed_query: str | None = None,
    ) -> EvidencePacket:
        """Full pipeline for one evidence request: query → cache → retrieve → summarize → refine."""
        query = precomputed_query or await self.generate_query(evidence_request, task_context)
        domain_hints = evidence_request.get("domain_hints") or []
        skip_web = evidence_request.get("skip_web", False)

        cached = self.cache.get(query)
        if cached is not None:
            if evidence_request.get("section_id") is not None:
                cached = cached.model_copy(update={"section_id": evidence_request["section_id"]})
            return cached

        raw_results = await self.retrieve(query, difficulty, domain_hints=domain_hints, skip_web=skip_web)
        packet = await self.summarize(query, raw_results)
        packet = packet.model_copy(update={"section_id": evidence_request.get("section_id")})

        rounds = 0
        while packet.confidence < LOW_CONFIDENCE_THRESHOLD and rounds < MAX_REFINEMENT_ROUNDS:
            refined_query = await self.refine_query(query, packet)
            cached = self.cache.get(refined_query)
            if cached is not None:
                packet = cached
                if evidence_request.get("section_id") is not None:
                    packet = packet.model_copy(update={"section_id": evidence_request["section_id"]})
                break
            raw_results = await self.retrieve(refined_query, difficulty, domain_hints=domain_hints, skip_web=skip_web)
            packet = await self.summarize(refined_query, raw_results)
            packet = packet.model_copy(update={"section_id": evidence_request.get("section_id")})
            query = refined_query
            rounds += 1

        self.cache.put(query, packet)
        return packet

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
        """Determine where to route after evidence gathering."""
        execution_plan = state.get("execution_plan") or {}
        is_code_task = state.get("is_code_task", False)
        task_is_trivial = state.get("task_is_trivial", False)

        if not execution_plan and not task_is_trivial:
            return "planner"
        if is_code_task:
            return "executor"
        return "writer"

    async def run(self, state: dict[str, Any]) -> dict[str, Any]:
        """LangGraph entry point."""
        start = time.monotonic()
        mode = self._detect_mode(state)

        task_desc = state.get("task_description", "")
        user_task = state.get("user_task") or {}
        difficulty = state.get("difficulty", 0.5)
        task_context = f"{task_desc}\n{json.dumps(user_task, default=str)[:500]}"

        evidence_requests = state.get("evidence_requests") or []

        if mode == "initial":
            requests = self._build_initial_requests(state)
        elif mode in ("section_evidence", "refinement"):
            requests = evidence_requests
        else:
            requests = []

        if not requests:
            requests = [{"description": task_desc, "domain_hints": user_task.get("domain_tags", [])}]

        packets = await self.parallel_dispatch(requests, task_context, difficulty)
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
            },
        )

        return {
            "evidence_packets": [p.model_dump() for p in packets],
            "evidence_requests": [],
            "need_more_evidence": False,
            "error": None,
            "next_node": next_node,
            "current_node": "router",
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

    def _build_initial_requests(self, state: dict[str, Any]) -> list[dict[str, Any]]:
        """Build evidence requests from the frame/task for initial retrieval."""
        user_task = state.get("user_task") or {}
        task_desc = state.get("task_description", "")
        domain_tags = user_task.get("domain_tags") or []
        skip_web = not user_task.get("needs_web", True)

        requests = []
        main_q = user_task.get("main_question", task_desc)
        if main_q:
            requests.append(
                {
                    "description": main_q,
                    "domain_hints": domain_tags,
                    "skip_web": skip_web,
                }
            )

        deliverables = user_task.get("deliverables") or []
        if len(deliverables) > 10:
            for batch_idx in range(0, len(deliverables), 3):
                batch = deliverables[batch_idx : batch_idx + 3]
                combined = "; ".join(d if isinstance(d, str) else str(d) for d in batch)
                requests.append(
                    {
                        "section_id": batch_idx,
                        "description": combined,
                        "domain_hints": domain_tags,
                        "skip_web": skip_web,
                    }
                )
        else:
            for i, d in enumerate(deliverables):
                requests.append(
                    {
                        "section_id": i,
                        "description": d if isinstance(d, str) else str(d),
                        "domain_hints": domain_tags,
                        "skip_web": skip_web,
                    }
                )

        return requests if requests else [{"description": task_desc, "domain_hints": domain_tags, "skip_web": skip_web}]

    # ----- Helpers -----

    @staticmethod
    def _format_raw_results(results: list[UnifiedResult]) -> str:
        """Format raw results for the summarizer prompt."""
        parts: list[str] = []
        for i, r in enumerate(results[:MAX_DOCS_PER_QUERY]):
            source_type = "web" if r.retrieval_source == "web" else "rag"
            parts.append(
                f"[{i + 1}] ({source_type}) score={r.score:.3f} "
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
        text = llm_output.strip()
        if text.startswith("```"):
            text = re.sub(r"^```\w*\n?", "", text)
            text = re.sub(r"\n?```$", "", text)

        try:
            data = json.loads(text)
            sources = []
            for s in data.get("sources", [])[:MAX_DOCS_PER_QUERY]:
                sources.append(
                    EvidenceSource(
                        uri=s.get("uri", ""),
                        type=s.get("type", "doc"),
                        metadata=s.get("metadata", {}),
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
                summary=str(data.get("summary", ""))[: MAX_SUMMARY_TOKENS * 4],
                confidence=min(1.0, max(0.0, float(data.get("confidence", 0.5)))),
                retrieval_notes=str(data.get("retrieval_notes", "")),
            )
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
            logger.warning("evidence_packet_parse_fallback", extra={"error": str(exc)[:200]})
            return _fallback_packet(query, raw_results)


def _fallback_packet(query: str, raw_results: list[UnifiedResult]) -> EvidencePacket:
    """Build an EvidencePacket directly from raw results when LLM parsing fails."""
    sources = []
    snippets = []
    for r in raw_results[:MAX_DOCS_PER_QUERY]:
        src_type = "web" if r.retrieval_source == "web" else "doc"
        sources.append(
            EvidenceSource(
                uri=r.source_url or r.title or "unknown",
                type=src_type,
                metadata={
                    "authority": r.authority,
                    "origin_type": r.origin_type,
                    "heading_path": r.heading_path,
                    "document_name": r.document_name,
                },
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
        summary=summary[: MAX_SUMMARY_TOKENS * 4],
        confidence=confidence,
        retrieval_notes="Fallback: LLM summarization failed, evidence assembled from raw results.",
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
