"""JSON schema validation for node outputs.

Validates and canonicalizes LLM responses between nodes. Malformed JSON
is caught early (Erlang-style fail-fast) rather than propagating.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import uuid
from typing import Any, Literal, TypeVar

from pydantic import BaseModel, Field

from .state import TaskType

T = TypeVar("T", bound=BaseModel)


def _extract_json(raw: str) -> str:
    """Extract JSON object from raw LLM output (handles markdown fences, extra text, braces in strings)."""
    content = raw.strip()
    # Try direct parse first
    try:
        json.loads(content)
        return content
    except json.JSONDecodeError:
        pass

    start = content.find("{")
    if start < 0:
        raise ValueError("No JSON object found in response")

    # Depth-based: find matching } (fails when braces appear inside string values)
    depth = 0
    in_string = False
    escape = False
    quote = None
    end = -1
    i = start
    while i < len(content):
        c = content[i]
        if escape:
            escape = False
        elif in_string:
            if c == "\\":
                escape = True
            elif c == quote:
                in_string = False
        elif c in ('"', "'"):
            in_string = True
            quote = c
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
        i += 1

    if end >= 0:
        return content[start : end + 1]

    # Fallback: first { to last } (handles truncation; may include trailing garbage)
    last_brace = content.rfind("}")
    if last_brace > start:
        candidate = content[start : last_brace + 1]
        try:
            json.loads(candidate)
            return candidate
        except json.JSONDecodeError:
            pass
        # Try repairing truncated JSON by appending closing braces
        for _ in range(5):
            candidate += "}"
            try:
                json.loads(candidate)
                return candidate
            except json.JSONDecodeError:
                pass

    raise ValueError("Unbalanced braces in JSON object")


def parse_and_validate(raw: str, model: type[T], retry_prompt: str | None = None) -> T:
    """Extract JSON, validate against schema, return validated model or raise."""
    extracted = _extract_json(raw)
    data = json.loads(extracted)

    # Normalize task_type string to enum
    if "task_type" in data and isinstance(data["task_type"], str):
        try:
            data["task_type"] = TaskType(data["task_type"])
        except ValueError:
            data["task_type"] = TaskType.GENERAL

    return model.model_validate(data)


# ---------------------------------------------------------------------------
# Supervisor output schema
# ---------------------------------------------------------------------------


class SupervisorOut(BaseModel):
    """Validated output from the Supervisor node."""

    task_type: TaskType = TaskType.GENERAL
    task_description: str = ""
    target_language: str = "bash"
    needs_code_generation: bool = True
    reasoning: str = ""
    assumptions: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0, default=0.5)

    # JCS: clarification request
    needs_clarification: bool = False
    clarification_question: str | None = None
    clarification_options: list[str] = Field(default_factory=list)

    # JCS: planning checkpoint for complex tasks
    planning_suggested: bool = False


# ---------------------------------------------------------------------------
# Planner output schema
# ---------------------------------------------------------------------------


class PlanStep(BaseModel):
    """A single step in the execution plan."""

    id: int = 0
    action: str = ""
    dependencies: list[int] = Field(default_factory=list)


class PlannerOut(BaseModel):
    """Validated output from the Planner node."""

    plan: dict[str, Any] = Field(default_factory=lambda: {"steps": [], "open_questions": [], "assumptions": []})
    open_questions: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    reasoning: str = ""
    confidence: float = Field(ge=0.0, le=1.0, default=0.5)
    touched_files: list[str] = Field(
        default_factory=list
    )  # Capability-based allowlist; Gate validates Worker against this


# ---------------------------------------------------------------------------
# Executor/Worker output schema
# ---------------------------------------------------------------------------


class ExperimentPlan(BaseModel):
    """Evidence-gap mode: structured experiment for novelty-checkable results."""

    commands: list[str] = Field(default_factory=list)
    expected_artifacts: list[str] = Field(default_factory=list)
    success_criteria: str = ""


class PatchOp(BaseModel):
    """Structured edit for multi-file. Enables max_loc_delta, path policy enforcement."""

    path: str = ""
    op: Literal["add", "modify", "delete"] = "modify"
    range: dict[str, Any] | None = None  # {"start": {line, character}, "end": {...}}
    text: str = ""


class IntegrityFailure(BaseModel):
    """Actionable Gate feedback — Worker gets remediation, not generic error."""

    category: Literal["secret", "network", "path", "binary", "import", "workspace", "scope", "dangerous", "size"] = (
        "path"
    )
    evidence: str = ""  # The specific line or symbol that failed
    remediation: str = ""  # e.g. "Remove the hardcoded API key and use environment variables."


class ExecutorOut(BaseModel):
    """Validated output from the Executor LLM node."""

    code: str = ""
    explanation: str = ""
    reasoning: str = ""
    assumptions: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0, default=0.5)
    edge_cases_considered: list[str] = Field(default_factory=list)

    # JCS: proactive "I need more" instead of guessing
    needs_input: bool = False
    needs_input_question: str | None = None

    # Worker-side stop reasons (prevents loop when Worker knows it's blocked)
    stop_reason: str | None = None  # blocked_external | cannot_reproduce | unsafe_request | needs_scope_expansion

    # Diff set (minimal form for path policies, LOC delta)
    files_touched: list[str] = Field(default_factory=list)
    unified_diff: str | None = None
    patch_ops: list[PatchOp] = Field(default_factory=list)

    # Evidence-gap mode (replaces experiment_script)
    experiment_script: str | None = None
    experiment_plan: ExperimentPlan | None = None

    # Regress-Reason protocol: declare when structural fix requires breaking a preserved stage
    regressions_intended: list[str] = Field(default_factory=list)  # e.g. ["lint"]
    regression_justification: str | None = None


# ---------------------------------------------------------------------------
# Context Curator (ContextPack schema)
# ---------------------------------------------------------------------------


class OriginMetadata(BaseModel):
    """Trust boundary: only trusted chunks have content_hash. Untrusted = data, never directives."""

    origin: Literal["trusted", "untrusted"] = "untrusted"
    content_hash: str = ""  # SHA256 of text for trusted chunks; empty for untrusted
    source_label: str = ""  # e.g. "tool_contract", "rag", "admin_policy"


class ContextChunk(BaseModel):
    """A single chunk in curated context. origin_metadata enforces trust boundaries."""

    source: Literal["spec", "arch", "rag", "tool_contract", "output_format"] = "rag"
    text: str = ""
    score: float | None = None
    collection: str = ""
    doc_id: str = ""
    origin_metadata: OriginMetadata | None = None


class ExcludedChunk(BaseModel):
    """Chunk available but not sent (for audit/telemetry). Threshold monitoring for Budget Alert."""

    doc_id: str = ""
    reason: str = ""  # "below_threshold", "budget_exceeded", "duplicate"
    score: float = 0.0  # rerank/rrf score; if high but budget_exceeded → Budget Alert
    text_snippet: str = ""  # for Context Pivot: match stderr keywords


class SanitizationAction(BaseModel):
    """What was removed/redacted for injection hardening."""

    chunk_id: str = ""
    action: Literal["removed", "redacted", "down_ranked"] = "removed"
    reason: str = ""


class ConflictWarning(BaseModel):
    """Trusted policy conflicts with untrusted data — Worker must flag as blocking_issue."""

    trusted_claim: str = ""
    untrusted_evidence: str = ""
    suggestion: str = "Flag as blocking_issue in Critic; do not resolve arbitrarily."


class ContextConflict(BaseModel):
    """Tier 2 vs Tier 3 conflict. Worker PROHIBITED from resolving silently."""

    feature: str = ""  # e.g. "container_runtime", "python_version"
    trusted_value: str = ""  # Org standard (Tier 2)
    untrusted_value: str = ""  # Project manifest (Tier 3)
    severity: Literal["informational", "warning", "blocking"] = "warning"
    resolution: str = ""  # e.g. "Tier 3 override applied for this session"


class ContextPack(BaseModel):
    """Curated context sent to Worker. Trust labeling for prompt-injection hardening."""

    pinned: list[ContextChunk] = Field(default_factory=list)
    retrieved: list[ContextChunk] = Field(default_factory=list)
    excluded: list[ExcludedChunk] = Field(default_factory=list)
    context_hash: str = ""
    total_tokens_estimate: int = 0
    context_id: str = ""  # Stable ID for drift tracking across turns
    snapshot_version: str = ""  # e.g. turn_2_v1; Supervisor compares for context drift
    # Trust labeling (see IDE_CLIENT_COORDINATION)
    trusted_chunks: list[ContextChunk] = Field(default_factory=list)
    untrusted_chunks: list[ContextChunk] = Field(default_factory=list)
    sanitization_actions: list[SanitizationAction] = Field(default_factory=list)
    conflict_warnings: list[ConflictWarning] = Field(default_factory=list)
    context_conflicts: list[ContextConflict] = Field(default_factory=list)
    budget_alert: str = ""  # non-empty when high-score chunk excluded for budget
    context_resync_message: str = ""  # when Jaccard drift > threshold, notify user
    trust_policy_version: str = "1"


# ---------------------------------------------------------------------------
# Evidence refs (structured IDs for UI, telemetry, citation)
# ---------------------------------------------------------------------------


class SpecRef(BaseModel):
    doc_id: str = ""
    section: str = ""
    anchor: str = ""


class LSPRef(BaseModel):
    symbol: str = ""
    uri: str = ""
    range: dict[str, Any] = Field(default_factory=dict)


class SandboxRef(BaseModel):
    stage: int = 1  # 1=lint, 2=security, 3=execute
    cmd: str = ""
    exit_code: int = 0
    log_excerpt_hash: str = ""


def _blake2b_compact(data: str) -> str:
    """Compact, URL-safe hash. digest_size=16 → 32 hex chars."""
    return hashlib.blake2b(data.encode(), digest_size=16).hexdigest()


def _tool_params_hash(tool: str, params: dict, tool_version: str = "") -> str:
    """Canonical param ingredients per tool. Item 6: include tool_version to avoid cache poisoning on tool updates."""
    if tool == "sandbox":
        canon = {k: params.get(k) for k in ("code", "language", "context_files") if k in params}
    elif tool == "lsp":
        canon = {k: params.get(k) for k in ("code", "language", "query_symbol", "uri") if k in params}
    elif tool == "rag":
        canon = {k: params.get(k) for k in ("query", "top_k", "reranker", "collections", "strategy") if k in params}
    else:
        canon = dict(params)
    if tool_version:
        canon["_tool_version"] = tool_version
    return _blake2b_compact(json.dumps(canon, sort_keys=True))


def _sandbox_result_fingerprint(result: Any) -> str:
    """Item 4: Deterministic normalized classification for novelty. Prevents 'different command, same failure' burns."""
    if not isinstance(result, dict):
        return ""
    exit_code = result.get("exit_code", 0)
    lint = result.get("lint", {}) or {}
    sec = result.get("security", {}) or {}
    exec_data = result.get("execution", {}) or {}
    lint_passed = lint.get("passed", True) if isinstance(lint, dict) else True
    sec_passed = sec.get("passed", True) if isinstance(sec, dict) else True
    if not lint_passed:
        _stage, detail = "lint", ""
        if isinstance(lint, dict) and lint.get("diagnostics"):
            diag = lint["diagnostics"][0] if lint["diagnostics"] else {}
            detail = str(diag.get("rule_id", diag.get("code", "")))[:32] if isinstance(diag, dict) else ""
        return f"lint:{exit_code}:{detail}"
    if not sec_passed:
        detail = ""
        if isinstance(sec, dict) and sec.get("findings"):
            f0 = sec["findings"][0] if sec["findings"] else {}
            detail = str(f0.get("rule_id", f0.get("id", "")))[:32] if isinstance(f0, dict) else ""
        return f"security:{exit_code}:{detail}"
    # runtime
    err = (exec_data.get("output") or exec_data.get("stderr") or "")[:200]
    first_line = err.split("\n")[0] if err else ""
    exc_match = first_line.split(":")[0] if ":" in first_line else first_line[:40]
    return f"runtime:{exit_code}:{exc_match}"


def _sandbox_result_summary(result: Any) -> str:
    """1-line deterministic status: Exit · Lint · Sec."""
    if not isinstance(result, dict):
        return "No result"
    exit_code = result.get("exit_code", "?")
    lint = result.get("lint", {})
    sec = result.get("security", {})
    lint_status = "Pass" if (lint.get("passed") if isinstance(lint, dict) else True) else "Fail"
    lint_detail = ""
    if isinstance(lint, dict) and "diagnostics" in lint:
        count = len(lint.get("diagnostics", []))
        if count:
            lint_detail = f" ({count})"
    sec_status = "Pass" if (sec.get("passed") if isinstance(sec, dict) else True) else "Fail"
    return f"Exit: {exit_code} · Lint: {lint_status}{lint_detail} · Sec: {sec_status}"


def _lsp_result_summary(result: Any) -> str:
    """1-line LSP outcome."""
    if not isinstance(result, dict):
        return "No result"
    err = result.get("error")
    if err:
        return f"Error: {str(err)[:60]}"
    skipped = result.get("skipped", False)
    if skipped:
        return "Skipped"
    diag = result.get("diagnostics", [])
    count = len(diag)
    return "Lint: Pass" if count == 0 else f"Lint: Fail ({count})"


def _rag_result_summary(result: Any) -> str:
    """1-line RAG outcome."""
    if isinstance(result, dict):
        n = result.get("count", len(result.get("sources", [])))
        return f"{n} results"
    if isinstance(result, list):
        return f"{len(result)} results"
    return "0 results"


class ToolRef(BaseModel):
    """Evidence from tool invocation. Synesis Gold Standard: reproducible, citable, traceable."""

    tool: Literal["rag", "lsp", "sandbox"]
    request_id: str = ""  # UUID4, passed as X-Synesis-Request-ID for log correlation
    parameters_hash: str = ""  # blake2b(params) — Re-run if mismatched
    result_hash: str = ""
    result_summary: str = Field(  # 1-line outcome; helps Critic decide if full blob needed
        "",
        description="Deterministic status: success/fail + error count",
    )
    artifact_hashes: list[str] = Field(default_factory=list)  # stdout, junit etc. for novelty
    result_fingerprint: str = ""  # Item 4: exit_stage+exit_code+rule_id; novelty = new hash OR new fingerprint
    # Audit / regression: where did this come from?
    producer_node: str = ""  # sandbox | lsp | rag
    created_at: str = ""  # ISO8601 or unix ms
    tool_version: str = ""  # container digest (sandbox), server build id (LSP), etc.


def make_tool_ref(
    tool: Literal["rag", "lsp", "sandbox"],
    params: dict,
    result: Any,
    *,
    request_id: str | None = None,
    result_summary: str | None = None,
    artifact_hashes: list[str] | None = None,
    tool_version: str = "",
) -> ToolRef:
    """Create ToolRef. request_id passed as X-Synesis-Request-ID; callers should generate before invoke."""
    req_id = request_id or str(uuid.uuid4())
    result_str = json.dumps(result, sort_keys=True, default=str) if result is not None else ""
    res_hash = _blake2b_compact(result_str)
    params_hash = _tool_params_hash(tool, params, tool_version)

    if result_summary is not None:
        summary = result_summary
    elif tool == "sandbox":
        summary = _sandbox_result_summary(result)
    elif tool == "lsp":
        summary = _lsp_result_summary(result)
    elif tool == "rag":
        summary = _rag_result_summary(result)
    else:
        summary = ""

    hashes: list[str] = []
    if artifact_hashes:
        hashes = artifact_hashes
    elif tool == "sandbox" and isinstance(result, dict):
        for key in ("lint", "security", "execution"):
            val = result.get(key)
            if val:
                blob = json.dumps(val, sort_keys=True, default=str)
                hashes.append(_blake2b_compact(blob))

    result_fp = ""
    if tool == "sandbox" and isinstance(result, dict):
        result_fp = _sandbox_result_fingerprint(result)

    return ToolRef(
        tool=tool,
        request_id=req_id,
        parameters_hash=params_hash,
        result_hash=res_hash,
        result_summary=summary,
        artifact_hashes=hashes,
        result_fingerprint=result_fp,
        producer_node=tool,
        created_at=datetime.datetime.now(datetime.UTC).isoformat(),
        tool_version=tool_version,
    )


class CodeRef(BaseModel):
    """§7.6: Patch provenance. Tie Sandbox logs to exact patch version."""

    content_hash: str = ""  # blake2b(generated_code)
    files: list[dict[str, str]] = Field(default_factory=list)  # [{path, hash}]
    patch_hash: str = ""  # blake2b(patch_ops or unified_diff)


def make_code_ref(
    generated_code: str = "",
    files_touched: list[str] | None = None,
    patch_ops: list | None = None,
    unified_diff: str | None = None,
) -> CodeRef:
    """Build CodeRef from Worker output for patch provenance."""
    content_hash = _blake2b_compact(generated_code) if generated_code else ""
    files: list[dict[str, str]] = []
    for path in (files_touched or [])[:20]:  # cap for sanity
        # Use path as-is; hash would need file content — for now path+placeholder
        text = ""
        for op in patch_ops or []:
            p = op.get("path", "") if isinstance(op, dict) else getattr(op, "path", "")
            t = (
                op.get("text", "") or op.get("content", "")
                if isinstance(op, dict)
                else getattr(op, "text", "") or getattr(op, "content", "")
            )
            if p == path:
                text = t
                break
        files.append({"path": path, "hash": _blake2b_compact(text or path)})

    def _op_tuple(o: Any) -> tuple:
        if isinstance(o, dict):
            return (o.get("path", ""), o.get("op", ""), o.get("text", "") or o.get("content", ""))
        return (getattr(o, "path", ""), getattr(o, "op", ""), getattr(o, "text", "") or getattr(o, "content", ""))

    patch_blob = (
        json.dumps([_op_tuple(o) for o in (patch_ops or [])], sort_keys=True) if patch_ops else (unified_diff or "")
    )
    patch_hash = _blake2b_compact(patch_blob) if patch_blob else ""
    return CodeRef(content_hash=content_hash, files=files, patch_hash=patch_hash)


class EvidenceRef(BaseModel):
    """Structured evidence reference. Use one of spec_ref, lsp_ref, sandbox_ref, tool_ref, code_ref."""

    source: Literal["spec", "lsp", "sandbox", "tool", "code"] = "sandbox"
    spec_ref: SpecRef | None = None
    lsp_ref: LSPRef | None = None
    sandbox_ref: SandboxRef | None = None
    tool_ref: ToolRef | None = None
    code_ref: CodeRef | None = None


# ---------------------------------------------------------------------------
# Critic output schema
# ---------------------------------------------------------------------------


class CriticWhatIf(BaseModel):
    """A single what-if analysis with optional line reference for evidence."""

    scenario: str = ""
    risk_level: str = "medium"  # low|medium|high|critical
    explanation: str = ""
    suggested_mitigation: str | None = None
    line_reference: str | None = None  # e.g. "lines 12-15" for evidence


class CriticOut(BaseModel):
    """Validated output from the Critic node."""

    what_if_analyses: list[dict[str, Any]] = Field(default_factory=list)
    overall_assessment: str = ""
    approved: bool = True
    revision_feedback: str = ""
    confidence: float = Field(ge=0.0, le=1.0, default=0.5)
    reasoning: str = ""

    # Stop condition (separate from approved)
    should_continue: bool = False
    continue_reason: str | None = None  # "needs_evidence" | "needs_revision" | "blocked_external"

    # Evidence gate
    need_more_evidence: bool = False
    evidence_gap: str | None = None
    route_to: str | None = None  # "lsp" | "worker" | "respond"
    evidence_needed: dict[str, Any] | None = None

    # Structured evidence refs (optional; can coexist with legacy line_reference)
    blocking_issues: list[dict[str, Any]] = Field(default_factory=list)
    nonblocking: list[dict[str, Any]] = Field(default_factory=list)
    residual_risks: list[dict[str, Any]] = Field(default_factory=list)

    # Postmortem (max_iterations): weak signal for system brittleness aggregation
    dark_debt_signal: dict[str, Any] | None = None  # {module_path?, failure_pattern, consistent_failures}
