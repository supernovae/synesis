"""Context Curator node -- deterministic ContextPack before Worker.

Produces a deterministic, bounded context pack the Worker consumes.
Prevents prompt drift and enables reproducible debugging.

Runs before every Worker invocation (including retries). On retries with
execution_result, re-curates by doing a supplemental RAG query with the
error message to surface more relevant fix guidance (Q1.1).
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from ..config import settings
from ..injection_scanner import reduce_context_on_injection, scan_text
from ..rag_client import retrieve_context
from ..schemas import (
    ConflictWarning,
    ContextChunk,
    ContextConflict,
    ContextPack,
    ExcludedChunk,
    OriginMetadata,
    SanitizationAction,
)

logger = logging.getLogger("synesis.context_curator")


def _get_attr(obj: Any, key: str, default: Any = "") -> Any:
    """Safe get for dict or object (RetrievalResult etc)."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _hash_chunk(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:24]


def _extract_entities_from_stderr(execution_result: str) -> list[str]:
    """Extract error codes (ORA-00904, E0507), library names, function names for targeted RAG."""
    import re

    entities: list[str] = []
    text = execution_result or ""

    # Error codes: ORA-00904, E0507, ENOENT, etc.
    for m in re.finditer(r"\b(ORA-\d+|E\d{4}|ENOENT|ECONNREFUSED|ETIMEDOUT|ESRCH|EACCES)\b", text, re.I):
        entities.append(m.group(1))

    # Common library/module patterns: ImportError for X, ModuleNotFoundError: X, No module named 'X'
    for m in re.finditer(
        r"(?:ImportError|ModuleNotFoundError|No module named)\s+['\"]?(\w+(?:\.\w+)*)['\"]?", text, re.I
    ):
        entities.append(m.group(1).split(".")[0])

    # Undefined name / function: "name 'foo' is not defined", "undefined reference to `bar`"
    for m in re.finditer(r"(?:name|undefined reference to)\s+['\`]?(\w+)['\`]?", text, re.I):
        entities.append(m.group(1))

    return list(dict.fromkeys(entities))[:10]


def _extract_error_for_rag(execution_result: str) -> str:
    """Extract key error from execution result for supplemental RAG query."""
    if not execution_result or not execution_result.strip():
        return ""
    try:
        result = json.loads(execution_result)
    except (json.JSONDecodeError, TypeError):
        lines = execution_result.strip().splitlines()
        for line in reversed(lines):
            stripped = line.strip()
            if stripped and len(stripped) > 10:
                return stripped[:300]
        return execution_result[:300]
    for section in ("execution", "lint", "security"):
        data = result.get(section, {})
        if isinstance(data, dict):
            if section == "execution" and data.get("exit_code", 0) != 0:
                return (data.get("output", "") or "")[:300].strip()
            if section in ("lint", "security") and not data.get("passed", True):
                return (str(data.get("output", "")) or "")[:300].strip()
    return ""


def _build_pinned_context(
    task_type: str,
    target_language: str,
    task_description: str,
    execution_plan: dict[str, Any],
    org_standards: list[ContextChunk],
    project_manifest: list[ContextChunk],
) -> list[ContextChunk]:
    """Hierarchical override: Tier 1 (global) → Tier 2 (org) → Tier 3 (project) → Tier 4 (session)."""
    chunks: list[ContextChunk] = []

    # Tier 1: Global policy (hardcoded)
    t1 = "Respond with valid JSON. Include code, explanation, reasoning, assumptions, confidence, edge_cases_considered, needs_input, needs_input_question, stop_reason."
    chunks.append(
        ContextChunk(
            source="output_format",
            text=t1,
            score=1.0,
            collection="",
            doc_id="invariant_output_format",
            origin_metadata=OriginMetadata(
                origin="trusted",
                content_hash=_hash_chunk(t1),
                source_label="output_format",
            ),
        )
    )
    t2 = f"Target language: {target_language}. Sandbox has no network. Use set -euo pipefail for bash."
    chunks.append(
        ContextChunk(
            source="tool_contract",
            text=t2,
            score=1.0,
            collection="",
            doc_id="invariant_sandbox",
            origin_metadata=OriginMetadata(
                origin="trusted",
                content_hash=_hash_chunk(t2),
                source_label="tool_contract",
            ),
        )
    )

    # Tier 2: Organization standards (arch_standards collection)
    chunks.extend(org_standards)

    # Tier 3: Project manifest (.synesis.yaml) — from project_manifest if provided
    chunks.extend(project_manifest)

    # Tier 4: Session invariants (task + plan)
    if task_description:
        session_text = f"Current task: {task_description[:500]}"
        if execution_plan and isinstance(execution_plan, dict):
            steps = execution_plan.get("steps", [])
            if steps:
                session_text += "\nPlanner steps: " + "; ".join(s.get("action", str(s))[:80] for s in steps[:5])
        chunks.append(
            ContextChunk(
                source="tool_contract",
                text=session_text,
                score=0.9,
                collection="",
                doc_id="invariant_session",
                origin_metadata=OriginMetadata(
                    origin="trusted",
                    content_hash=_hash_chunk(session_text),
                    source_label="session",
                ),
            )
        )
    return chunks


def _detect_tier2_tier3_conflicts(
    org_standards: list[ContextChunk],
    project_manifest: list[ContextChunk],
) -> list[ContextConflict]:
    """Detect conflicts between Org SOPs (Tier 2) and Project Manifest (Tier 3)."""
    import re

    conflicts: list[ContextConflict] = []
    org_text = " ".join(c.text.lower() for c in org_standards)
    proj_text = " ".join(c.text.lower() for c in project_manifest)
    if not org_text or not proj_text:
        return conflicts

    # Container runtime: Docker vs Podman
    if ("docker" in org_text and "podman" in proj_text) or ("podman" in org_text and "docker" in proj_text):
        org_runtime = "Docker" if "docker" in org_text else "Podman"
        proj_runtime = "Podman" if "podman" in proj_text else "Docker"
        conflicts.append(
            ContextConflict(
                feature="container_runtime",
                trusted_value=org_runtime,
                untrusted_value=proj_runtime,
                severity="warning",
                resolution="Tier 3 override applied for this session. Worker must note in residual_risks or blocking_issues.",
            )
        )

    # Python version
    org_py = re.search(r"python\s+3\.(\d+)|3\.(\d+)", org_text)
    proj_py = re.search(r"python\s*=\s*[\"\']?3\.(\d+)|3\.(\d+)", proj_text)
    if org_py and proj_py:
        o = org_py.group(1) or org_py.group(2)
        p = proj_py.group(1) or proj_py.group(2)
        if o != p:
            conflicts.append(
                ContextConflict(
                    feature="python_version",
                    trusted_value=f"Python 3.{o}",
                    untrusted_value=f"Python 3.{p}",
                    severity="warning",
                    resolution="Tier 3 override applied for this session. Worker must note in residual_risks or blocking_issues.",
                )
            )
    return conflicts


def _build_synthetic_conflict_chunk(conflict: ContextConflict) -> ContextChunk:
    """Inject into pinned: Worker must note conflict, not resolve silently."""
    text = (
        f"[SYSTEM WARNING]: Conflict detected between Org Standard (Tier 2) and Project Manifest (Tier 3) "
        f"regarding {conflict.feature}. Tier 3 overrides Tier 2 for this session, but Worker must note "
        f"this in 'residual_risks' or 'blocking_issues'. "
        f"Trusted: {conflict.trusted_value}. Untrusted: {conflict.untrusted_value}. {conflict.resolution}"
    )
    return ContextChunk(
        source="tool_contract",
        text=text,
        score=1.0,
        collection="",
        doc_id=f"conflict_{conflict.feature}",
        origin_metadata=OriginMetadata(
            origin="trusted",
            content_hash=_hash_chunk(text),
            source_label="synthetic_conflict",
        ),
    )


def _detect_conflicts(
    trusted_chunks: list[ContextChunk],
    untrusted_text: str,
) -> list[ConflictWarning]:
    """Heuristic: detect trusted policy vs untrusted data conflicts (e.g. Python version)."""
    import re

    warnings: list[ConflictWarning] = []
    untrusted_lower = untrusted_text.lower()

    for c in trusted_chunks:
        text = c.text
        # Python version: "Python 3.12" in trusted vs "3.10" or 'requires-python = ">=3.10"' in repo
        py_match = re.search(r"python\s+3\.(\d+)", text, re.I)
        if py_match:
            claimed = py_match.group(0)
            claimed_ver = f"3.{py_match.group(1)}"
            repo_match = re.search(r"3\.(\d+)|python\s*=\s*[\"\']?3\.(\d+)", untrusted_lower)
            if repo_match:
                g = repo_match.groups()
                repo_ver = f"3.{g[0] or g[1]}"
                if claimed_ver != repo_ver:
                    warnings.append(
                        ConflictWarning(
                            trusted_claim=claimed,
                            untrusted_evidence=f"Repository specifies Python {repo_ver}",
                            suggestion="Flag as blocking_issue; do not override repo version arbitrarily.",
                        )
                    )
        # Container: "Use Docker" in trusted vs "podman" in repo
        if "docker" in text.lower() and "podman" in untrusted_lower:
            warnings.append(
                ConflictWarning(
                    trusted_claim="Policy mentions Docker",
                    untrusted_evidence="Repository references Podman",
                    suggestion="Flag as blocking_issue; clarify container runtime with user.",
                )
            )
        if "podman" in text.lower() and "docker" in untrusted_lower and "podman" not in untrusted_lower:
            warnings.append(
                ConflictWarning(
                    trusted_claim="Policy mentions Podman",
                    untrusted_evidence="Repository references Docker",
                    suggestion="Flag as blocking_issue; clarify container runtime with user.",
                )
            )
    return warnings


def _jaccard_similarity(ids_a: set[str], ids_b: set[str]) -> float:
    """Jaccard similarity of two ID sets. 0 = no overlap, 1 = identical."""
    if not ids_a and not ids_b:
        return 1.0
    inter = len(ids_a & ids_b)
    union = len(ids_a | ids_b)
    return inter / union if union else 1.0


def _compute_context_hash(pinned: list, retrieved: list) -> str:
    """Stable hash for reproducibility."""
    content = f"pinned:{len(pinned)}|retrieved:{len(retrieved)}"
    for c in pinned:
        content += f"|{c.doc_id}:{c.text[:100]}"
    for c in retrieved:
        content += f"|{c.doc_id}:{c.text[:100]}"
    return hashlib.sha256(content.encode()).hexdigest()[:16]


async def context_curator_node(state: dict[str, Any]) -> dict[str, Any]:
    """Produce deterministic ContextPack from state. Worker consumes curated context only."""
    node_name = "context_curator"

    task_desc = state.get("task_description", "")
    task_type = state.get("task_type", "general")
    target_lang = state.get("target_language", "bash")
    rag_results = list(state.get("rag_results", []))
    execution_plan = state.get("execution_plan", {})
    iteration = state.get("iteration_count", 0)
    execution_result = state.get("execution_result", "")
    rag_collections = state.get("rag_collections_queried", []) or [f"{target_lang}_v1"]
    max_retrieval = settings.max_retrieval_tokens or 0  # 0 = no cap from retrieval budget
    retrieval_budget_chars = max_retrieval * 4 if max_retrieval else 0  # ~4 chars/token

    # Tier 2: Fetch organization standards from arch_standards collection
    org_standards: list[ContextChunk] = []
    arch_colls = getattr(settings, "curator_arch_standards_collections", []) or []
    if arch_colls:
        try:
            org_results = await retrieve_context(
                query=task_desc[:300],
                collections=[c for c in arch_colls if c],
                top_k=3,
            )
            for r in org_results:
                t = _get_attr(r, "text", "")
                org_standards.append(
                    ContextChunk(
                        source="arch",
                        text=t,
                        score=getattr(r, "rerank_score", 0.9),
                        collection=getattr(r, "collection", ""),
                        doc_id=getattr(r, "source", "arch_standards"),
                        origin_metadata=OriginMetadata(
                            origin="trusted", content_hash=_hash_chunk(t), source_label="org_standards"
                        ),
                    )
                )
        except Exception as e:
            logger.debug(f"Arch standards fetch skipped: {e}")

    # Tier 3: Project manifest — from state if provided (e.g. .synesis.yaml ingested)
    project_manifest: list[ContextChunk] = []
    for c in state.get("project_manifest_chunks", [])[:3]:
        if isinstance(c, dict):
            text = c.get("text", "")
            if text:
                project_manifest.append(
                    ContextChunk(
                        source="tool_contract",
                        text=text,
                        score=0.95,
                        collection="",
                        doc_id=c.get("doc_id", "project_manifest"),
                        origin_metadata=OriginMetadata(
                            origin="trusted", content_hash=_hash_chunk(text), source_label="project_manifest"
                        ),
                    )
                )
        elif hasattr(c, "text"):
            project_manifest.append(
                ContextChunk(
                    source="tool_contract",
                    text=c.text,
                    score=0.95,
                    collection="",
                    doc_id=getattr(c, "doc_id", "project_manifest"),
                    origin_metadata=OriginMetadata(
                        origin="trusted", content_hash=_hash_chunk(c.text), source_label="project_manifest"
                    ),
                )
            )

    # Tier 2 vs Tier 3 conflict detection — inject Synthetic Conflict Chunks
    tier2_tier3_conflicts = _detect_tier2_tier3_conflicts(org_standards, project_manifest)
    context_conflicts = tier2_tier3_conflicts

    pinned = _build_pinned_context(
        str(task_type), target_lang, task_desc, execution_plan, org_standards, project_manifest
    )
    for c in tier2_tier3_conflicts:
        pinned.append(_build_synthetic_conflict_chunk(c))

    # Context Pivot on retries: promote excluded chunks whose keywords appear in stderr
    prev_pack = state.get("context_pack")
    priority_doc_ids: set[str] = set()
    if iteration > 0 and execution_result and prev_pack:
        prev_excluded = (
            prev_pack.get("excluded", []) if isinstance(prev_pack, dict) else getattr(prev_pack, "excluded", [])
        )
        stderr_lower = execution_result.lower()
        for ex in prev_excluded:
            snippet = ex.get("text_snippet", "") if isinstance(ex, dict) else getattr(ex, "text_snippet", "")
            doc_id = ex.get("doc_id", "") if isinstance(ex, dict) else getattr(ex, "doc_id", "")
            if snippet and doc_id and any(kw in stderr_lower for kw in snippet.lower().split()[:15]):
                priority_doc_ids.add(doc_id)

    # Strategic Pivot: entity extraction + targeted RAG + context swapping
    # §8.7: curation_mode stable = reuse prior pack; adaptive = pivot when stderr suggests pivot could help
    entity_chunks: list[Any] = []
    curation_mode = getattr(settings, "curator_curation_mode", "adaptive") or "adaptive"
    failure_type = state.get("failure_type", "runtime")
    pivot_plausible = failure_type in ("lsp", "runtime")  # symbol/type/dep errors; not lint whitespace
    if (
        curation_mode == "adaptive"
        and iteration > 0
        and execution_result
        and pivot_plausible
        and getattr(settings, "curator_recurate_on_retry", True)
    ):
        entities = _extract_entities_from_stderr(execution_result)
        query = " ".join(entities[:5]) if entities else _extract_error_for_rag(execution_result)
        if query:
            try:
                entity_results = await retrieve_context(
                    query=query,
                    collections=rag_collections,
                    top_k=min(4, settings.rag_top_k),
                )
                entity_chunks = list(entity_results)
                logger.info(
                    "context_curator_pivot",
                    extra={"entities": entities[:5] if entities else [], "count": len(entity_chunks)},
                )
            except Exception as e:
                logger.debug(f"Curator targeted RAG failed: {e}")

    # Merge: prioritize entity chunks and priority_doc_ids, then existing rag_results
    def _chunk_key(r):
        t = _get_attr(r, "text", "")
        sid = _get_attr(r, "source", "")
        return (sid, t[:80])

    seen = set()
    merged: list[Any] = []
    for r in entity_chunks:
        k = _chunk_key(r)
        if k not in seen:
            seen.add(k)
            merged.append(r)
    for r in rag_results:
        doc_id = _get_attr(r, "source", f"rag_{len(merged)}")
        if doc_id in priority_doc_ids:
            merged.insert(0, r)
        else:
            k = _chunk_key(r)
            if k not in seen:
                seen.add(k)
                merged.append(r)
    rag_results = merged

    # Retrieved: top-k from RAG (trim from overfetch; excluded = rest for telemetry)
    retrieved: list[ContextChunk] = []
    excluded: list[ExcludedChunk] = []
    top_k = settings.rag_top_k
    chars_used = 0
    sanitization_actions: list[SanitizationAction] = []
    for i, r in enumerate(rag_results):
        text = getattr(r, "text", str(r)) if hasattr(r, "text") else str(r)
        score = getattr(r, "rerank_score", None) or getattr(r, "rrf_score", 0.0) or 0.0
        collection = getattr(r, "collection", "")
        doc_id = getattr(r, "source", f"rag_{i}")
        if settings.injection_scan_enabled and text:
            scan = scan_text(text, source=f"rag_{doc_id}")
            if scan.detected:
                text = reduce_context_on_injection(text, "")
                sanitization_actions.append(
                    SanitizationAction(chunk_id=doc_id, action="redacted", reason="policy_like_text")
                )
        exceeds_budget = retrieval_budget_chars and (chars_used + len(text)) > retrieval_budget_chars
        if i < top_k and not exceeds_budget:
            chars_used += len(text)
            retrieved.append(
                ContextChunk(
                    source="rag",
                    text=text,
                    score=float(score),
                    collection=collection,
                    doc_id=doc_id,
                    origin_metadata=OriginMetadata(
                        origin="untrusted",
                        content_hash="",
                        source_label="rag",
                    ),
                )
            )
        else:
            reason = "budget_exceeded" if exceeds_budget else "below_threshold"
            excluded.append(
                ExcludedChunk(
                    doc_id=doc_id,
                    reason=reason,
                    score=float(score),
                    text_snippet=text[:200] if text else "",
                )
            )

    trusted_sources = getattr(settings, "curator_trusted_sources", None) or [
        "tool_contract",
        "output_format",
        "embedded_policy",
        "admin_policy",
        "arch",
    ]
    trusted_chunks = [c for c in pinned if c.source in trusted_sources]

    # Conflict detection: trusted vs untrusted (e.g. Python version, Docker vs Podman)
    untrusted_combined = "\n".join(c.text for c in retrieved)
    conflict_warnings = _detect_conflicts(trusted_chunks, untrusted_combined)

    context_hash = _compute_context_hash(pinned, retrieved)
    total_tokens_estimate = sum(len(c.text.split()) * 2 for c in pinned + retrieved)  # rough 2 tokens/word

    user_id = state.get("user_id", "anonymous")
    iteration = state.get("iteration_count", 0)
    context_id = f"{user_id[:8]}_{iteration}"
    snapshot_version = f"turn_{iteration}_v{context_hash[:8]}"

    # Budget Alert: high-score chunk excluded for budget_exceeded
    budget_threshold = getattr(settings, "curator_budget_alert_threshold", 0.85)
    budget_alert = ""
    for ex in excluded:
        if ex.reason == "budget_exceeded" and ex.score >= budget_threshold:
            budget_alert = (
                f"I have more relevant documentation on {ex.doc_id} (score {ex.score:.2f}), "
                "but I've reached my token limit. Would you like me to swap current context for the extra documentation?"
            )
            break

    untrusted_chunks = [c for c in retrieved]
    # Jaccard drift: if prev pack exists and similarity < threshold, set context_resync_message
    context_resync_message = ""
    prev_pack = state.get("context_pack")
    if prev_pack and iteration > 0:
        prev_ids = set()
        for chunk in (prev_pack.get("pinned", []) or []) + (prev_pack.get("retrieved", []) or []):
            c = chunk
            doc_id = c.get("doc_id", "") if isinstance(c, dict) else getattr(c, "doc_id", "")
            if doc_id:
                prev_ids.add(doc_id)
        curr_ids = {c.doc_id for c in pinned + retrieved if c.doc_id}
        jaccard = _jaccard_similarity(prev_ids, curr_ids)
        threshold = getattr(settings, "curator_context_drift_jaccard_threshold", 0.2)
        if jaccard < threshold:
            context_resync_message = "Note: Based on the build errors, I have pivoted my focus. The context has shifted significantly. Review updated plan?"
    pack = ContextPack(
        pinned=pinned,
        retrieved=retrieved,
        excluded=excluded,
        context_hash=context_hash,
        total_tokens_estimate=total_tokens_estimate,
        context_id=context_id,
        snapshot_version=snapshot_version,
        trusted_chunks=trusted_chunks,
        untrusted_chunks=untrusted_chunks,
        sanitization_actions=sanitization_actions,
        conflict_warnings=conflict_warnings,
        context_conflicts=context_conflicts,
        budget_alert=budget_alert,
        context_resync_message=context_resync_message,
        trust_policy_version="1",
    )

    logger.info(
        "context_curator_produced",
        extra={
            "pinned_count": len(pinned),
            "retrieved_count": len(retrieved),
            "excluded_count": len(excluded),
            "context_hash": context_hash,
        },
    )

    # Worker consumes curated context; build rag_context from pack for backward compat
    rag_context = [c.text for c in retrieved]

    return {
        "current_node": node_name,
        "context_pack": pack.model_dump() if hasattr(pack, "model_dump") else pack,
        "rag_context": rag_context,
    }
