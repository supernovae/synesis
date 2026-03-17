"""Patch Integrity Gate -- deterministic checks before Sandbox.

Circuit Breaker: "Is this code permitted?" not "Is this code good?"

Check logic lives in integrity_core.py (shared with MCP tool).
This module adapts the core checks to LangGraph state and config.

Only active in legacy_hybrid front door mode. In text_only mode the graph
skips this node entirely (route_after_executor returns "respond").
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import settings
from ..diff_validator import validate_diff_shape
from ..integrity_core import (
    IntegrityResult,
    check_dangerous_commands,
    check_experiment_commands,
    check_import_integrity,
    check_max_size,
    check_network,
    check_patch_op_constraints,
    check_path_denylist,
    check_python_syntax,
    check_secrets,
    check_utf8,
    check_workspace_boundary,
)
from ..schemas import IntegrityFailure
from ..state import NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.patch_integrity_gate")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _to_schema(result: IntegrityResult) -> IntegrityFailure:
    """Convert core IntegrityResult to Pydantic IntegrityFailure."""
    return IntegrityFailure(
        category=result.category,  # type: ignore[arg-type]
        evidence=result.evidence,
        remediation=result.remediation,
    )


def _gate_fail(node_name: str, failure: IntegrityFailure, state: dict[str, Any]) -> dict:
    """Build Gate failure return with actionable feedback."""
    return {
        "current_node": node_name,
        "integrity_passed": False,
        "integrity_failure": failure.model_dump() if hasattr(failure, "model_dump") else failure,
        "integrity_failure_reason": failure.category,
        "critic_feedback": failure.remediation,
        "next_node": "writer",
        "generated_code": state.get("generated_code", ""),
        "code_explanation": state.get("code_explanation", ""),
        "patch_ops": state.get("patch_ops", []) or [],
        "task_description": state.get("task_description", ""),
        "failure_ids_seen": state.get("failure_ids_seen", []) or [],
        "node_traces": [
            NodeTrace(
                node_name=node_name,
                reasoning=f"Integrity check failed: {failure.category} — {failure.evidence[:80]}",
                confidence=1.0,
                outcome=NodeOutcome.NEEDS_REVISION,
                latency_ms=0,
            )
        ],
    }


def _check_and_fail(
    result: IntegrityResult | None,
    node_name: str,
    state: dict[str, Any],
) -> dict | None:
    """If result is a failure, return a gate-fail dict; otherwise None."""
    if result is None:
        return None
    failure = _to_schema(result)
    logger.warning(
        "patch_integrity_failed",
        extra={"category": failure.category, "evidence": failure.evidence[:80]},
    )
    return _gate_fail(node_name, failure, state)


# Scope validation helpers (kept local since they use planner-specific manifest logic)


def _check_scope_violation(
    files_touched: list[str],
    patch_ops: list,
    touched_files: list[str],
    target_workspace: str = "",
) -> IntegrityResult | None:
    """Capability-based allowlist: Worker may only touch files in Planner's touched_files manifest."""
    if not touched_files:
        return None
    allowed = {p.rstrip("/") for p in touched_files if p}
    worker_paths: list[str] = []
    for ft in files_touched or []:
        p = (ft or "").strip()
        if p and not p.startswith("#"):
            worker_paths.append(p)
    for op in patch_ops or []:
        path = op.get("path", "") if isinstance(op, dict) else getattr(op, "path", "")
        if path:
            worker_paths.append(path.strip())
    ws_prefix = (target_workspace or "").rstrip("/")
    for wp in worker_paths:
        if not wp:
            continue
        if not wp.startswith("/") and ws_prefix:
            norm = f"{ws_prefix}/{wp}" if ws_prefix else "/" + wp
        else:
            norm = wp if wp.startswith("/") else "/" + wp
        matched = any(norm == a or norm.startswith(a + "/") or norm.startswith(a + "\\") for a in allowed)
        if not matched:
            return IntegrityResult(
                category="scope",
                evidence=f"Path {wp} is not in Planner's touched_files manifest",
                remediation="Scope violation: modify only files listed in the execution plan.",
            )
    return None


def _path_denylist_names() -> tuple[str, ...]:
    cfg = getattr(settings, "integrity_path_denylist", None) or []
    if cfg:
        names = tuple((p.split("/")[-1] if "/" in p else p) for p in cfg if p)
        if names:
            return names
    return ("package-lock.json", "yarn.lock", "Cargo.lock", "poetry.lock", "pnpm-lock.yaml")


def _check_evidence_blast_radius(experiment_plan: dict | Any) -> IntegrityResult | None:
    if not experiment_plan:
        return None
    cmds = (
        experiment_plan.get("commands", [])
        if isinstance(experiment_plan, dict)
        else getattr(experiment_plan, "commands", [])
    )
    max_cmds = getattr(settings, "experiment_max_commands", 10) or 10
    if len(cmds) > max_cmds:
        return IntegrityResult(
            category="dangerous",
            evidence=f"Experiment has {len(cmds)} commands; max {max_cmds}",
            remediation=f"Reduce experiment_plan.commands to at most {max_cmds} commands.",
        )
    return None


def _check_evidence_commands_allowlist(commands: list[str]) -> IntegrityResult | None:
    allowlist = getattr(settings, "integrity_evidence_command_allowlist", None) or []
    allowed = {c.strip().lower() for c in allowlist if c}
    for cmd in commands:
        first = (cmd.strip().split() or [""])[0].lower()
        if not first or first.startswith("#"):
            continue
        if first not in allowed and not any(first.startswith(a) for a in allowed):
            return IntegrityResult(
                category="path",
                evidence=f"Command: {cmd[:60]}",
                remediation="Evidence experiment commands must use allowlisted interpreters.",
            )
    return None


def _check_loc_delta(
    unified_diff: str | None,
    patch_ops: list,
    revision_constraints: dict,
) -> IntegrityResult | None:
    max_delta = (revision_constraints or {}).get("max_loc_delta")
    if max_delta is None:
        return None
    delta = 0
    for line in (unified_diff or "").splitlines():
        if line.startswith("+"):
            delta += 1
        elif line.startswith("-"):
            delta -= 1
    delta = abs(delta)
    for op in patch_ops or []:
        text = (
            op.get("text", "") or op.get("content", "")
            if isinstance(op, dict)
            else getattr(op, "text", "") or getattr(op, "content", "")
        )
        delta += len(text.splitlines()) if text else 0
    if delta > max_delta:
        return IntegrityResult(
            category="size",
            evidence=f"LOC delta {delta} exceeds max {max_delta}",
            remediation="Reduce scope. Stay within revision_constraints.max_loc_delta.",
        )
    return None


def _check_patch_file_size(patch_ops: list) -> IntegrityResult | None:
    limit = getattr(settings, "integrity_max_patch_file_chars", 50_000) or 50_000
    for op in patch_ops or []:
        text = (
            op.get("text", "") or op.get("content", "")
            if isinstance(op, dict)
            else getattr(op, "text", "") or getattr(op, "content", "")
        )
        if len(text) > limit:
            path = op.get("path", "") if isinstance(op, dict) else getattr(op, "path", "")
            return IntegrityResult(
                category="size",
                evidence=f"File {path} exceeds {limit} chars ({len(text)})",
                remediation=f"Reduce patch content to under {limit} characters per file.",
            )
    return None


# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------


async def patch_integrity_gate_node(state: dict[str, Any]) -> dict[str, Any]:
    """Run deterministic integrity checks on code and commands before Sandbox.

    Circuit Breaker: "Is this code permitted?" Planner process, <10ms.
    """
    node_name = "patch_integrity_gate"
    code = state.get("generated_code", "")
    logger.debug("gate_received generated_code_len=%d", len(code or ""))
    language = state.get("target_language", "python")
    experiment_script = state.get("experiment_script", "")
    experiment_plan = state.get("experiment_plan") or {}
    commands_from_plan = (
        experiment_plan.get("commands", [])
        if isinstance(experiment_plan, dict)
        else getattr(experiment_plan, "commands", [])
    )
    files_touched = state.get("files_touched", []) or []
    unified_diff = state.get("unified_diff", "") or ""
    patch_ops = state.get("patch_ops", []) or []
    revision_constraints = state.get("revision_constraints", {}) or {}
    target_workspace = state.get("target_workspace", "") or getattr(settings, "integrity_target_workspace", "")
    touched_files = state.get("touched_files", []) or []

    has_patch_ops = bool(patch_ops) and any(
        (
            p.get("text") or p.get("content")
            if isinstance(p, dict)
            else getattr(p, "text", "") or getattr(p, "content", "")
        )
        for p in (patch_ops or [])
    )
    if not code.strip() and not has_patch_ops:
        return {
            "current_node": node_name,
            "integrity_passed": True,
            "next_node": "critic",
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
            "failure_ids_seen": state.get("failure_ids_seen", []) or [],
        }

    is_code_task = state.get("is_code_task", False)
    if not is_code_task:
        difficulty = state.get("difficulty", 0.5)
        taxonomy_metadata = state.get("taxonomy_metadata") or {}
        route_to_critic = difficulty > 0.6 and bool(taxonomy_metadata.get("required_elements"))
        next_node = "critic" if route_to_critic else "respond"
        logger.info(
            "gate_text_mode_bypass",
            extra={"is_code_task": is_code_task, "next_node": next_node, "taxonomy_depth_check": route_to_critic},
        )
        return {
            "current_node": node_name,
            "integrity_passed": True,
            "next_node": next_node,
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
            "failure_ids_seen": state.get("failure_ids_seen", []) or [],
            "node_traces": [
                NodeTrace(
                    node_name=node_name,
                    reasoning=f"Explain-only output; bypassing sandbox → {next_node}",
                    confidence=1.0,
                    outcome=NodeOutcome.SUCCESS,
                    latency_ms=0,
                )
            ],
        }

    # --- Core checks (delegated to integrity_core) ---

    fail = _check_and_fail(check_workspace_boundary(files_touched, patch_ops, target_workspace), node_name, state)
    if fail:
        return fail

    fail = _check_and_fail(
        _check_scope_violation(files_touched, patch_ops, touched_files, target_workspace), node_name, state
    )
    if fail:
        return fail

    fail = _check_and_fail(check_patch_op_constraints(patch_ops), node_name, state)
    if fail:
        return fail
    fail = _check_and_fail(_check_patch_file_size(patch_ops), node_name, state)
    if fail:
        return fail

    revision_strategy = state.get("revision_strategy", "")
    diff_failure = validate_diff_shape(files_touched, patch_ops, revision_constraints, revision_strategy)
    if diff_failure:
        logger.warning(
            "patch_integrity_failed", extra={"category": diff_failure.category, "evidence": diff_failure.evidence[:80]}
        )
        return _gate_fail(node_name, diff_failure, state)

    all_paths = set(files_touched or [])
    for op in patch_ops or []:
        p = op.get("path", "") if isinstance(op, dict) else getattr(op, "path", "")
        if p:
            all_paths.add(p)
    for ft in all_paths:
        for name in _path_denylist_names():
            if name in ft:
                failure = IntegrityFailure(
                    category="path",
                    evidence=f"File {ft}",
                    remediation="Remove from files_touched/patch_ops. Lockfiles are denylisted.",
                )
                logger.warning("patch_integrity_failed", extra={"reason": "path_denylist", "path": ft})
                return _gate_fail(node_name, failure, state)

    if commands_from_plan:
        fail = _check_and_fail(_check_evidence_blast_radius(experiment_plan), node_name, state)
        if fail:
            return fail
        fail = _check_and_fail(check_experiment_commands(commands_from_plan), node_name, state)
        if fail:
            return fail
        fail = _check_and_fail(_check_evidence_commands_allowlist(commands_from_plan), node_name, state)
        if fail:
            return fail

    fail = _check_and_fail(_check_loc_delta(unified_diff, patch_ops, revision_constraints), node_name, state)
    if fail:
        return fail

    code_to_check = code
    if not code.strip() and patch_ops:
        code_to_check = "\n".join(
            op.get("text", "") or op.get("content", "")
            if isinstance(op, dict)
            else getattr(op, "text", "") or getattr(op, "content", "")
            for op in patch_ops
        )
    if experiment_script:
        code_to_check = f"{code}\n{experiment_script}"
    if commands_from_plan:
        code_to_check = f"{code_to_check}\n" + "\n".join(commands_from_plan)

    limit = getattr(settings, "integrity_max_code_chars", 100_000) or 100_000
    for check_fn in (
        lambda c: check_max_size(c, limit=limit),
        lambda c: check_path_denylist(c),
        lambda c: check_import_integrity(
            c,
            language,
            trusted_packages=set(
                p.strip().lower() for p in (getattr(settings, "integrity_trusted_packages", None) or []) if p
            )
            or None,
        ),
        lambda c: check_utf8(c),
        lambda c: check_secrets(c),
        lambda c: check_network(c, language),
        lambda c: check_dangerous_commands(c, language),
        lambda c: check_python_syntax(c, language),
    ):
        fail = _check_and_fail(check_fn(code_to_check), node_name, state)
        if fail:
            return fail

    return {
        "current_node": node_name,
        "integrity_passed": True,
        "integrity_failure_reason": None,
        "next_node": "critic",
        "generated_code": state.get("generated_code", ""),
        "code_explanation": state.get("code_explanation", ""),
        "patch_ops": state.get("patch_ops", []) or [],
        "task_description": state.get("task_description", ""),
        "failure_ids_seen": state.get("failure_ids_seen", []) or [],
        "node_traces": [
            NodeTrace(
                node_name=node_name,
                reasoning="All integrity checks passed",
                confidence=1.0,
                outcome=NodeOutcome.SUCCESS,
                latency_ms=0,
            )
        ],
    }
