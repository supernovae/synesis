"""Patch Integrity Gate -- deterministic checks before Sandbox.

Circuit Breaker: "Is this code permitted?" not "Is this code good?"
- Session-scoped workspace (target_workspace prefix)
- AST-aware network check (Python: exclude strings/comments)
- Import Integrity (block packages not in trusted list)
- IntegrityFailure schema: category, evidence, remediation
"""

from __future__ import annotations

import ast
import logging
import re
from typing import Any

from ..config import settings
from ..diff_validator import validate_diff_shape
from ..schemas import IntegrityFailure
from ..state import NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.patch_integrity_gate")

# Patterns that suggest secrets (conservative; may have false positives in docs)
_SECRET_PATTERNS = [
    re.compile(
        r"""(?:api[_-]?key|secret|password|token)\s*=\s*['"]?[a-zA-Z0-9_\-]{8,}['"]?""",
        re.IGNORECASE,
    ),
    re.compile(r"-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----", re.MULTILINE),
    re.compile(r"-----BEGIN\s+[A-Z]+\s+PRIVATE\s+KEY-----", re.MULTILINE),
]

# Network-related patterns (executable code; comments excluded heuristically)
# Bash/shell
_NETWORK_BASH = [
    re.compile(r"\b(curl|wget|nc\s|\bnetcat\s)\s", re.IGNORECASE),
    re.compile(r"/dev/tcp/"),
    re.compile(r"\$\(.*\bcurl\b.*\)", re.IGNORECASE),
]
# Python
_NETWORK_PYTHON = [
    re.compile(r"\b(requests\.(get|post|put|delete)|urllib\.request|urllib3\.request)\s*\("),
    re.compile(r"socket\.(connect|create_connection)\s*\("),
    re.compile(r"\bhttpx\.(get|post|AsyncClient)\s*\("),
]
# JS/TS
_NETWORK_JS = [
    re.compile(r"fetch\s*\("),
    re.compile(r"axios\.(get|post|create)\s*\("),
    re.compile(r"require\s*\(\s*['\"]https?://"),
]

# Dangerous command patterns (bash/shell)
_DANGEROUS_BASH = [
    re.compile(r"\brm\s+-rf\s+", re.IGNORECASE),
    re.compile(r"\brm\s+--recursive\s+", re.IGNORECASE),
    re.compile(r"curl\s+[^|]*\|\s*bash", re.IGNORECASE),
    re.compile(r"wget\s+[^|]*\|\s*(?:bash|sh)\b", re.IGNORECASE),
    re.compile(r":\s*\{\s*:\s*\}\s*\|", re.MULTILINE),  # fork bomb
]


def _strip_single_line_comment(line: str, lang: str) -> str:
    """Remove single-line comments to avoid flagging documented examples."""
    if lang in ("bash", "shell", "sh"):
        return line.split("#")[0]
    if lang in ("python", "py"):
        return line.split("#")[0]
    if lang in ("javascript", "typescript", "js", "ts"):
        return line.split("//")[0]
    return line


def _is_likely_comment_or_string(line: str, lang: str) -> bool:
    """Heuristic: line is only comment or string literal (e.g. docstring)."""
    stripped = line.strip()
    if not stripped:
        return True
    if lang in ("python", "py"):
        if stripped.startswith('"""') or stripped.startswith("'''") or stripped.startswith("#"):
            return True
    if lang in ("bash", "shell", "sh") and stripped.startswith("#"):
        return True
    if lang in ("javascript", "typescript", "js", "ts"):
        if stripped.startswith("//") or stripped.startswith("*"):
            return True
    return False


def check_secrets(code: str) -> IntegrityFailure | None:
    """Return IntegrityFailure if secrets detected, else None."""
    for pat in _SECRET_PATTERNS:
        m = pat.search(code)
        if m:
            line = code[: m.start()].count("\n") + 1
            return IntegrityFailure(
                category="secret",
                evidence=f"Line ~{line}: {m.group(0)[:80]}...",
                remediation="Remove the hardcoded API key/secret and use environment variables.",
            )
    return None


# Network-forbidden modules and call patterns (AST-targeted)
_NETWORK_MODULES = frozenset({"requests", "urllib", "urllib3", "urllib.request", "socket", "httpx", "http.client"})
_NETWORK_CALLS = [
    ("requests", ["get", "post", "put", "delete", "request", "head", "patch"]),
    ("urllib.request", ["urlopen", "Request"]),
    ("urllib3", ["request"]),
    ("socket", ["connect", "create_connection", "connect_ex"]),
    ("httpx", ["get", "post", "AsyncClient", "Client"]),
    ("http.client", ["HTTPConnection", "HTTPSConnection"]),
]


def _integrity_check_python_ast(code: str) -> IntegrityFailure | None:
    """AST-specific: target requests, urllib, socket, httpx. Visit Import, ImportFrom, Call nodes only."""
    try:
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    mod = alias.name.split(".")[0]
                    if mod in _NETWORK_MODULES:
                        return IntegrityFailure(
                            category="network",
                            evidence=f"Line ~{node.lineno}: import {alias.name}",
                            remediation=f"You attempted to use '{alias.name}'. Use the internal 'MockClient' or define this as an external tool requirement.",
                        )
            elif isinstance(node, ast.ImportFrom) and node.module:
                mod = node.module.split(".")[0]
                if mod in _NETWORK_MODULES:
                    return IntegrityFailure(
                        category="network",
                        evidence=f"Line ~{node.lineno}: from {node.module} import ...",
                        remediation=f"You attempted to use '{node.module}'. Use the internal 'MockClient' or define this as an external tool requirement.",
                    )
            elif isinstance(node, ast.Call):
                func = node.func
                if isinstance(func, ast.Attribute):
                    if isinstance(func.value, ast.Name):
                        mod = func.value.id
                        attr = func.attr
                        for forbidden_mod, attrs in _NETWORK_CALLS:
                            if mod == forbidden_mod.split(".")[0] and attr in attrs:
                                return IntegrityFailure(
                                    category="network",
                                    evidence=f"Line ~{node.lineno}: {mod}.{attr}(...)",
                                    remediation=f"You attempted to use '{mod}.{attr}'. Use the internal 'MockClient' or define this as an external tool requirement.",
                                )
                    elif isinstance(func.value, ast.Attribute):
                        if getattr(func.value.value, "id", "") == "urllib" and func.value.attr == "request":
                            return IntegrityFailure(
                                category="network",
                                evidence=f"Line ~{node.lineno}: urllib.request....",
                                remediation="You attempted to use urllib.request. Use the internal 'MockClient' or define this as an external tool requirement.",
                            )
    except SyntaxError:
        pass
    return None


def _strip_strings_bash_js(line: str, lang: str) -> str:
    """Remove content inside single/double quotes. Context-specific sanitization for bash/JS."""
    result = []
    i = 0
    while i < len(line):
        c = line[i]
        if c in ("'", '"'):
            end = c
            i += 1
            while i < len(line):
                if line[i] == "\\":
                    i += 2
                    continue
                if line[i] == end:
                    i += 1
                    break
                i += 1
            result.append(" ")  # replace quoted content with space
            continue
        result.append(c)
        i += 1
    return "".join(result)


def check_network(code: str, language: str) -> IntegrityFailure | None:
    """Context-specific: Python uses AST; Bash/JS use string-strip heuristic."""
    lang = (language or "bash").lower()
    if lang in ("python", "py"):
        return _integrity_check_python_ast(code)
    patterns = _NETWORK_BASH if lang in ("bash", "shell", "sh") else _NETWORK_JS
    for i, line in enumerate(code.splitlines()):
        if _is_likely_comment_or_string(line, lang):
            continue
        code_part = _strip_single_line_comment(line, lang)
        code_part = _strip_strings_bash_js(code_part, lang)
        for pat in patterns:
            m = pat.search(code_part)
            if m:
                symbol = m.group(0).strip()
                return IntegrityFailure(
                    category="network",
                    evidence=f"Line ~{i + 1}: {symbol[:60]}",
                    remediation=f"You attempted to use '{symbol[:40]}'. Use the internal 'MockClient' or define this as an external tool requirement.",
                )
    return None


def check_dangerous_commands(code: str, language: str) -> IntegrityFailure | None:
    """Return IntegrityFailure if dangerous commands detected (bash/shell)."""
    lang = (language or "bash").lower()
    if lang not in ("bash", "shell", "sh"):
        return None
    for i, line in enumerate(code.splitlines()):
        if _is_likely_comment_or_string(line, lang):
            continue
        code_part = _strip_single_line_comment(line, lang)
        for pat in _DANGEROUS_BASH:
            m = pat.search(code_part)
            if m:
                return IntegrityFailure(
                    category="dangerous",
                    evidence=f"Line ~{i + 1}: {m.group(0)[:60]}",
                    remediation="Remove rm -rf, curl|bash, or fork bombs. Use safer alternatives.",
                )
    return None


def check_max_size(code: str) -> IntegrityFailure | None:
    """Return IntegrityFailure if code exceeds max chars."""
    limit = getattr(settings, "integrity_max_code_chars", 100_000) or 100_000
    if len(code) > limit:
        return IntegrityFailure(
            category="size",
            evidence=f"Code length {len(code)} exceeds limit {limit}",
            remediation="Produce a shorter script or split into smaller units.",
        )
    return None


_PATH_DENYLIST_REGEX = re.compile(r"\b\S+\.lock\b", re.IGNORECASE)


def _path_denylist_names() -> tuple[str, ...]:
    """Names to reject when in write context. From config or default."""
    cfg = getattr(settings, "integrity_path_denylist", None) or []
    if cfg:
        names = tuple((p.split("/")[-1] if "/" in p else p) for p in cfg if p)
        if names:
            return names
    return ("package-lock.json", "yarn.lock", "Cargo.lock", "poetry.lock", "pnpm-lock.yaml")


def check_workspace_boundary(
    files_touched: list[str],
    patch_ops: list,
    target_workspace: str,
) -> IntegrityFailure | None:
    """Strict WORKSPACE_ROOT prefix. Any divergence requires Re-Plan signal to Supervisor."""
    if not target_workspace or not target_workspace.strip():
        return None
    prefix = target_workspace.rstrip("/")
    if not prefix:
        return None
    paths: list[str] = []
    for ft in files_touched or []:
        p = (ft or "").strip()
        if p and not p.startswith("#"):
            paths.append(p)
    for op in patch_ops or []:
        path = op.get("path", "") if isinstance(op, dict) else getattr(op, "path", "")
        if path:
            paths.append(path.strip())
    for p in paths:
        if not p:
            continue
        norm = p if p.startswith("/") else "/" + p
        if not norm.startswith(prefix + "/") and norm != prefix:
            return IntegrityFailure(
                category="workspace",
                evidence=f"Path {p} is outside target_workspace {target_workspace}",
                remediation="All paths must be under the workspace root. Request a Re-Plan from Supervisor to adjust scope.",
            )
    return None


def check_scope_violation(
    files_touched: list[str],
    patch_ops: list,
    touched_files: list[str],
    target_workspace: str = "",
) -> IntegrityFailure | None:
    """Capability-based allowlist. Worker may only touch files in Planner's touched_files manifest."""
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
        # Resolve relative paths against workspace root
        if not wp.startswith("/") and ws_prefix:
            norm = f"{ws_prefix}/{wp}" if ws_prefix else "/" + wp
        else:
            norm = wp if wp.startswith("/") else "/" + wp
        matched = any(norm == a or norm.startswith(a + "/") or norm.startswith(a + "\\") for a in allowed)
        if not matched:
            return IntegrityFailure(
                category="scope",
                evidence=f"Path {wp} is not in Planner's touched_files manifest",
                remediation="Scope violation: You may only modify files listed in the execution plan. Request a Re-Plan from Supervisor to expand the allowlist.",
            )
    return None


_ALLOWED_PATCH_OPS = frozenset({"add", "modify", "delete", "create", "update"})  # create/update aliases


def check_patch_op_constraints(patch_ops: list) -> IntegrityFailure | None:
    """§7.4: Op must be add/modify/delete (or create/update aliases). Reject path traversal (../) and symlinks."""
    if not patch_ops:
        return None
    for op in patch_ops:
        path = op.get("path", "") if isinstance(op, dict) else getattr(op, "path", "")
        op_type = (
            (op.get("op", "modify") or "modify") if isinstance(op, dict) else (getattr(op, "op", "modify") or "modify")
        )
        if op_type not in _ALLOWED_PATCH_OPS:
            return IntegrityFailure(
                category="path",
                evidence=f"Invalid op '{op_type}' for path {path}",
                remediation="Use only add, modify, or delete. No line-range edits.",
            )
        if ".." in path or "//" in path:
            return IntegrityFailure(
                category="path",
                evidence=f"Path traversal: {path}",
                remediation="Use relative paths under workspace. No '../' or '//'. Absolute paths validated by workspace boundary.",
            )
        # Item 3A: Forbid symlink creation in patch content
        text = (
            op.get("text", "") or op.get("content", "")
            if isinstance(op, dict)
            else getattr(op, "text", "") or getattr(op, "content", "")
        )
        if text and ("ln -s" in text or "ln -s\t" in text):
            return IntegrityFailure(
                category="path",
                evidence=f"Symlink creation (ln -s) in patch content for {path}",
                remediation="Forbid symlink creation. Use regular files only.",
            )
    return None


def check_patch_file_size(patch_ops: list) -> IntegrityFailure | None:
    """§7.4: Enforce max_file_size per patch op."""
    limit = getattr(settings, "integrity_max_patch_file_chars", 50_000) or 50_000
    for op in patch_ops or []:
        text = (
            op.get("text", "") or op.get("content", "")
            if isinstance(op, dict)
            else getattr(op, "text", "") or getattr(op, "content", "")
        )
        if len(text) > limit:
            path = op.get("path", "") if isinstance(op, dict) else getattr(op, "path", "")
            return IntegrityFailure(
                category="size",
                evidence=f"File {path} exceeds {limit} chars ({len(text)})",
                remediation=f"Reduce patch content to under {limit} characters per file.",
            )
    return None


def check_import_integrity(code: str, language: str) -> IntegrityFailure | None:
    """Block Python imports not in integrity_trusted_packages. Prevents typosquatting."""
    if (language or "").lower() not in ("python", "py"):
        return None
    trusted = set(p.strip().lower() for p in (getattr(settings, "integrity_trusted_packages", None) or []) if p)
    if not trusted:
        return None
    try:
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    mod = alias.name.split(".")[0].lower()
                    if mod not in trusted:
                        return IntegrityFailure(
                            category="import",
                            evidence=f"import {alias.name}",
                            remediation=f"Package '{mod}' is not in integrity_trusted_packages. Use an allowed package or define as external tool requirement.",
                        )
            elif isinstance(node, ast.ImportFrom) and node.module:
                mod = node.module.split(".")[0].lower()
                if mod not in trusted:
                    return IntegrityFailure(
                        category="import",
                        evidence=f"from {node.module} import ...",
                        remediation=f"Package '{mod}' is not in integrity_trusted_packages. Use an allowed package or define as external tool requirement.",
                    )
    except SyntaxError:
        pass
    return None


def check_evidence_blast_radius(experiment_plan: dict | Any) -> IntegrityFailure | None:
    """§8.4: Limit experiment blast radius — timeout, max commands, artifact limits."""
    if not experiment_plan:
        return None
    cmds = (
        experiment_plan.get("commands", [])
        if isinstance(experiment_plan, dict)
        else getattr(experiment_plan, "commands", [])
    )
    max_cmds = getattr(settings, "experiment_max_commands", 10) or 10
    if len(cmds) > max_cmds:
        return IntegrityFailure(
            category="dangerous",
            evidence=f"Experiment has {len(cmds)} commands; max {max_cmds}",
            remediation=f"Reduce experiment_plan.commands to at most {max_cmds} commands.",
        )
    return None


_HIGH_RISK_EXPERIMENT_CMDS = ("pip install", "pip3 install", "npm install", "yarn add", "go get", "cargo add")


def check_evidence_high_risk_commands(commands: list[str]) -> IntegrityFailure | None:
    """Item 3B: Flag (or block) pip/npm/go get in experiment plans. Network egress blocked at K8s; this is belt-and-suspenders."""
    if not commands:
        return None
    for cmd in commands:
        c = (cmd or "").strip().lower()
        for risky in _HIGH_RISK_EXPERIMENT_CMDS:
            if risky.lower() in c:
                return IntegrityFailure(
                    category="dangerous",
                    evidence=f"High-risk command in experiment: {cmd[:80]}",
                    remediation="Experiments may not run pip install, npm install, go get, etc. Use pre-installed deps or add to trusted setup.",
                )
    return None


def check_evidence_commands_allowlist(commands: list[str]) -> IntegrityFailure | None:
    """Evidence experiments: only allowlisted commands. Reject network/etc even in test scripts."""
    allowlist = getattr(settings, "integrity_evidence_command_allowlist", None) or []
    allowed = {c.strip().lower() for c in allowlist if c}
    for cmd in commands:
        first = (cmd.strip().split() or [""])[0].lower()
        if not first or first.startswith("#"):
            continue
        if first not in allowed and not any(first.startswith(a) for a in allowed):
            return IntegrityFailure(
                category="path",
                evidence=f"Command: {cmd[:60]}",
                remediation="Evidence experiment commands must use allowlisted interpreters (python, pytest, bash, etc.).",
            )
    return None


def check_path_denylist(code: str) -> IntegrityFailure | None:
    """Return IntegrityFailure if code modifies denylisted paths (e.g. lockfiles)."""
    names = _path_denylist_names()
    write_indicators = re.compile(
        r"(?:^|\s)(?:>|>>|cp\s|mv\s|sed\s+[^;]*\-i)",
        re.IGNORECASE | re.MULTILINE,
    )
    lines = code.splitlines()
    for i, line in enumerate(lines):
        if not write_indicators.search(line):
            continue
        for name in names:
            if name in line:
                return IntegrityFailure(
                    category="path",
                    evidence=f"Line ~{i + 1}: {line.strip()[:60]}",
                    remediation="Remove edits to lockfiles (package-lock.json, yarn.lock, etc.).",
                )
        if _PATH_DENYLIST_REGEX.search(line):
            return IntegrityFailure(
                category="path",
                evidence=f"Line ~{i + 1}: {line.strip()[:60]}",
                remediation="Remove edits to denylisted paths.",
            )
    return None


def _loc_delta_from_diff(unified_diff: str) -> int:
    """Count +/- lines in unified diff."""
    if not unified_diff:
        return 0
    delta = 0
    for line in unified_diff.splitlines():
        if line.startswith("+"):
            delta += 1
        elif line.startswith("-"):
            delta -= 1
    return abs(delta)


def _loc_delta_from_patch_ops(patch_ops: list) -> int:
    """Estimate LOC delta from patch_ops."""
    if not patch_ops:
        return 0
    total = 0
    for op in patch_ops:
        text = (
            op.get("text", "") or op.get("content", "")
            if isinstance(op, dict)
            else getattr(op, "text", "") or getattr(op, "content", "")
        )
        op_type = op.get("op", "modify") if isinstance(op, dict) else getattr(op, "op", "modify")
        lines = len(text.splitlines()) if text else 0
        if op_type == "add" or op_type == "delete":
            total += lines
        else:
            total += lines
    return total


def check_loc_delta(
    unified_diff: str | None,
    patch_ops: list,
    revision_constraints: dict,
) -> IntegrityFailure | None:
    """Return IntegrityFailure if LOC delta exceeds max_loc_delta."""
    max_delta = (revision_constraints or {}).get("max_loc_delta")
    if max_delta is None:
        return None
    delta = _loc_delta_from_diff(unified_diff or "") + _loc_delta_from_patch_ops(patch_ops or [])
    if delta > max_delta:
        return IntegrityFailure(
            category="size",
            evidence=f"LOC delta {delta} exceeds max {max_delta}",
            remediation="Reduce scope. Stay within revision_constraints.max_loc_delta.",
        )
    return None


def check_utf8(code: str) -> IntegrityFailure | None:
    """Return IntegrityFailure if code is not valid UTF-8."""
    try:
        code.encode("utf-8").decode("utf-8")
        return None
    except (UnicodeDecodeError, UnicodeEncodeError):
        return IntegrityFailure(
            category="binary",
            evidence="Invalid UTF-8 or binary content",
            remediation="Produce valid UTF-8 text only. No binary edits.",
        )


def _gate_fail(node_name: str, failure: IntegrityFailure, state: dict[str, Any]) -> dict:
    """Build Gate failure return with actionable feedback. Forward keys Respond needs."""
    return {
        "current_node": node_name,
        "integrity_passed": False,
        "integrity_failure": failure.model_dump() if hasattr(failure, "model_dump") else failure,
        "integrity_failure_reason": failure.category,
        "critic_feedback": failure.remediation,
        "next_node": "worker",
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

    # Two-Phase Commit: allow patch_ops-only (multi-file) when code is empty
    has_patch_ops = bool(patch_ops) and any(
        (
            p.get("text") or p.get("content")
            if isinstance(p, dict)
            else getattr(p, "text", "") or getattr(p, "content", "")
        )
        for p in (patch_ops or [])
    )
    if not code.strip() and not has_patch_ops:
        next_after_pass = "lsp_analyzer" if (settings.lsp_enabled and settings.lsp_mode == "always") else "sandbox"
        return {
            "current_node": node_name,
            "integrity_passed": True,
            "next_node": next_after_pass,
            "generated_code": state.get("generated_code", ""),
            "code_explanation": state.get("code_explanation", ""),
            "patch_ops": state.get("patch_ops", []) or [],
            "task_description": state.get("task_description", ""),
            "failure_ids_seen": state.get("failure_ids_seen", []) or [],
        }

    # Workspace boundary (Session-Scoped Allowlist)
    failure = check_workspace_boundary(files_touched, patch_ops, target_workspace)
    if failure:
        logger.warning(
            "patch_integrity_failed", extra={"category": failure.category, "evidence": failure.evidence[:80]}
        )
        return _gate_fail(node_name, failure, state)

    # Scope validation (Capability-Based Allowlist): Worker paths must be in Planner's touched_files
    failure = check_scope_violation(files_touched, patch_ops, touched_files, target_workspace)
    if failure:
        logger.warning(
            "patch_integrity_failed", extra={"category": failure.category, "evidence": failure.evidence[:80]}
        )
        return _gate_fail(node_name, failure, state)

    # §7.4: patch_ops constraints — op validity, path traversal, per-file size
    failure = check_patch_op_constraints(patch_ops)
    if failure:
        logger.warning(
            "patch_integrity_failed", extra={"category": failure.category, "evidence": failure.evidence[:80]}
        )
        return _gate_fail(node_name, failure, state)
    failure = check_patch_file_size(patch_ops)
    if failure:
        logger.warning(
            "patch_integrity_failed", extra={"category": failure.category, "evidence": failure.evidence[:80]}
        )
        return _gate_fail(node_name, failure, state)

    # Diff shape (Two-Phase Commit Phase 1): file count and LOC vs revision_constraints
    revision_strategy = state.get("revision_strategy", "")
    failure = validate_diff_shape(files_touched, patch_ops, revision_constraints, revision_strategy)
    if failure:
        logger.warning(
            "patch_integrity_failed", extra={"category": failure.category, "evidence": failure.evidence[:80]}
        )
        return _gate_fail(node_name, failure, state)

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
        failure = check_evidence_blast_radius(experiment_plan)
        if failure:
            logger.warning("patch_integrity_failed", extra={"category": failure.category})
            return _gate_fail(node_name, failure, state)
        failure = check_evidence_high_risk_commands(commands_from_plan)
        if failure:
            logger.warning("patch_integrity_failed", extra={"category": failure.category})
            return _gate_fail(node_name, failure, state)
        failure = check_evidence_commands_allowlist(commands_from_plan)
        if failure:
            logger.warning("patch_integrity_failed", extra={"category": failure.category})
            return _gate_fail(node_name, failure, state)

    failure = check_loc_delta(unified_diff, patch_ops, revision_constraints)
    if failure:
        logger.warning("patch_integrity_failed", extra={"category": failure.category})
        return _gate_fail(node_name, failure, state)

    # For patch_ops-only (multi-file), concatenate patch text for safety checks
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

    failure = check_max_size(code_to_check)
    if failure:
        logger.warning("patch_integrity_failed", extra={"category": failure.category})
        return _gate_fail(node_name, failure, state)

    failure = check_path_denylist(code_to_check)
    if failure:
        logger.warning("patch_integrity_failed", extra={"category": failure.category})
        return _gate_fail(node_name, failure, state)

    # Import Integrity (Python)
    failure = check_import_integrity(code_to_check, language)
    if failure:
        logger.warning("patch_integrity_failed", extra={"category": failure.category})
        return _gate_fail(node_name, failure, state)

    failure = check_utf8(code_to_check)
    if failure:
        logger.warning("patch_integrity_failed", extra={"category": failure.category})
        return _gate_fail(node_name, failure, state)

    failure = check_secrets(code_to_check)
    if failure:
        logger.warning("patch_integrity_failed", extra={"category": failure.category})
        return _gate_fail(node_name, failure, state)

    failure = check_network(code_to_check, language)
    if failure:
        logger.warning("patch_integrity_failed", extra={"category": failure.category})
        return _gate_fail(node_name, failure, state)

    failure = check_dangerous_commands(code_to_check, language)
    if failure:
        logger.warning("patch_integrity_failed", extra={"category": failure.category})
        return _gate_fail(node_name, failure, state)

    next_after_pass = "lsp_analyzer" if (settings.lsp_enabled and settings.lsp_mode == "always") else "sandbox"
    return {
        "current_node": node_name,
        "integrity_passed": True,
        "integrity_failure_reason": None,
        "next_node": next_after_pass,
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
