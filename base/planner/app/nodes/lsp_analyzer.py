"""LSP Analyzer node -- deep type checking via the LSP Gateway.

Calls the LSP Gateway service to run language-specific diagnostic
tools (basedpyright, tsc, cargo check, etc.) against generated code.
Enriches the state with structured diagnostics so the Worker can
make a more informed revision.

Never blocks the pipeline: on timeout or circuit-breaker trip,
sets lsp_analysis_skipped=True and moves on.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

import httpx

from ..config import settings
from ..schemas import make_tool_ref
from ..state import NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.lsp_analyzer")


async def lsp_analyzer_node(state: dict[str, Any]) -> dict[str, Any]:
    start = time.monotonic()
    node_name = "lsp_analyzer"

    lsp_calls_used = state.get("lsp_calls_used", 0)
    if lsp_calls_used >= settings.max_lsp_calls:
        logger.info("lsp_budget_exceeded", extra={"lsp_calls_used": lsp_calls_used})
        return {
            "current_node": node_name,
            "lsp_analysis_skipped": True,
            "lsp_calls_used": lsp_calls_used,
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
            "failure_ids_seen": state.get("failure_ids_seen", []) or [],
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning="LSP call limit reached",
                    confidence=1.0,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=0.0,
                )
            ],
        }

    code = state.get("generated_code", "")
    language = state.get("target_language", "")

    if not code or not language:
        logger.info("lsp_skipped_no_code", extra={"language": language})
        return {
            "current_node": node_name,
            "lsp_analysis_skipped": True,
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
            "failure_ids_seen": state.get("failure_ids_seen", []) or [],
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning="No code or language to analyze",
                    confidence=1.0,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=0.0,
                )
            ],
        }

    if not settings.lsp_enabled or settings.lsp_mode == "disabled":
        logger.info("lsp_disabled")
        return {
            "current_node": node_name,
            "lsp_analysis_skipped": True,
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
            "failure_ids_seen": state.get("failure_ids_seen", []) or [],
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning="LSP analysis disabled by configuration",
                    confidence=1.0,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=0.0,
                )
            ],
        }

    request_id = str(uuid.uuid4())
    params = {
        "code": code[:5000],
        "language": language,
        "query_symbol": "",  # LSP may accept; hash consistency
        "uri": "",
    }
    headers = {"X-Synesis-Request-ID": request_id}
    try:
        async with httpx.AsyncClient(timeout=settings.lsp_timeout_seconds) as client:
            resp = await client.post(
                f"{settings.lsp_gateway_url.rstrip('/')}/analyze",
                json={k: v for k, v in params.items() if k in ("code", "language")},  # API contract
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()
        tool_ref = make_tool_ref("lsp", params, data, request_id=request_id)

        diagnostics_raw = data.get("diagnostics", [])
        engine = data.get("engine", "unknown")
        analysis_time = data.get("analysis_time_ms", 0.0)
        skipped = data.get("skipped", False)
        error = data.get("error")

        if skipped or error:
            logger.warning(
                "lsp_gateway_issue",
                extra={"engine": engine, "error": error, "skipped": skipped},
            )
            latency = (time.monotonic() - start) * 1000
            ref = make_tool_ref("lsp", params, data, request_id=request_id)
            existing_refs = state.get("tool_refs") or []
            return {
                "current_node": node_name,
                "lsp_analysis_skipped": True,
                "lsp_diagnostics": [],
                "lsp_languages_analyzed": [],
                "lsp_calls_used": lsp_calls_used + 1,
                "tool_refs": [*existing_refs, ref.model_dump()],
                "generated_code": state.get("generated_code", ""),
                "code_explanation": state.get("code_explanation", ""),
                "patch_ops": state.get("patch_ops", []) or [],
                "task_description": state.get("task_description", ""),
                "failure_ids_seen": state.get("failure_ids_seen", []) or [],
                "node_traces": [
                    NodeTrace(
                        node_name=node_name,
                        reasoning=f"LSP gateway: {error or 'skipped'}",
                        confidence=0.5,
                        outcome=NodeOutcome.SUCCESS,
                        latency_ms=latency,
                    )
                ],
            }

        formatted: list[str] = []
        error_count = 0
        warning_count = 0
        for d in diagnostics_raw:
            severity = d.get("severity", "error")
            line = d.get("line", 0)
            col = d.get("column", 0)
            msg = d.get("message", "")
            rule = d.get("rule", "")
            source = d.get("source", engine)
            if severity == "error":
                error_count += 1
            elif severity == "warning":
                warning_count += 1
            rule_tag = f" [{rule}]" if rule else ""
            formatted.append(f"[{severity.upper()}] L{line}:{col} ({source}{rule_tag}): {msg}")

        latency = (time.monotonic() - start) * 1000
        logger.info(
            "lsp_analysis_completed",
            extra={
                "engine": engine,
                "language": language,
                "errors": error_count,
                "warnings": warning_count,
                "total_diagnostics": len(formatted),
                "gateway_time_ms": analysis_time,
                "total_time_ms": latency,
            },
        )

        existing_refs = state.get("tool_refs") or []
        lsp_has_compile_errors = error_count > 0
        return {
            "current_node": node_name,
            "lsp_diagnostics": formatted,
            "lsp_languages_analyzed": [language],
            "lsp_analysis_skipped": False,
            "lsp_calls_used": lsp_calls_used + 1,
            "lsp_has_compile_errors": lsp_has_compile_errors,
            "tool_refs": [*existing_refs, tool_ref.model_dump()],
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
            "failure_ids_seen": state.get("failure_ids_seen", []) or [],
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"{engine}: {error_count} errors, {warning_count} warnings",
                    confidence=0.8,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=latency,
                )
            ],
        }

    except httpx.TimeoutException:
        latency = (time.monotonic() - start) * 1000
        logger.warning("lsp_timeout", extra={"language": language, "latency_ms": latency})
        return {
            "current_node": node_name,
            "lsp_analysis_skipped": True,
            "lsp_diagnostics": [],
            "lsp_languages_analyzed": [],
            "lsp_calls_used": lsp_calls_used + 1,
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
            "failure_ids_seen": state.get("failure_ids_seen", []) or [],
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"LSP gateway timed out after {settings.lsp_timeout_seconds}s",
                    confidence=0.0,
                    outcome=NodeOutcome.TIMEOUT,
                    latency_ms=latency,
                )
            ],
        }

    except Exception as exc:
        latency = (time.monotonic() - start) * 1000
        logger.exception("lsp_error", extra={"language": language})
        return {
            "current_node": node_name,
            "lsp_analysis_skipped": True,
            "lsp_diagnostics": [],
            "lsp_languages_analyzed": [],
            "lsp_calls_used": lsp_calls_used + 1,
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
            "failure_ids_seen": state.get("failure_ids_seen", []) or [],
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"LSP gateway error: {exc}",
                    confidence=0.0,
                    outcome=NodeOutcome.ERROR,
                    latency_ms=latency,
                )
            ],
        }
