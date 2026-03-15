"""Reusable code integrity checks — shared between planner gate and MCP tool.

Pure functions that validate code, patches, and commands for safety violations.
No LangGraph or graph state dependency — designed for standalone use.

Categories:
  secret     — hardcoded credentials/keys
  network    — network egress attempts
  dangerous  — destructive commands (rm -rf, curl|bash, fork bombs)
  path       — path traversal, symlinks, denylist (lockfiles)
  workspace  — file outside target workspace boundary
  scope      — file outside planner-approved manifest
  import     — untrusted Python package import
  size       — code/file exceeds size limits
  binary     — non-UTF-8 content
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from typing import Any

# ---------------------------------------------------------------------------
# Result type (framework-agnostic; mirrors schemas.IntegrityFailure)
# ---------------------------------------------------------------------------

@dataclass
class IntegrityResult:
    """Single integrity check failure. None means passed."""

    category: str = "path"
    evidence: str = ""
    remediation: str = ""


@dataclass
class IntegrityReport:
    """Aggregated result from running all checks."""

    passed: bool = True
    failures: list[IntegrityResult] = field(default_factory=list)

    def add(self, failure: IntegrityResult | None) -> None:
        if failure is not None:
            self.passed = False
            self.failures.append(failure)


# ---------------------------------------------------------------------------
# Secret detection
# ---------------------------------------------------------------------------

_SECRET_PATTERNS = [
    re.compile(
        r"""(?:api[_-]?key|secret|password|token)\s*=\s*['"]?[a-zA-Z0-9_\-]{8,}['"]?""",
        re.IGNORECASE,
    ),
    re.compile(r"-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----", re.MULTILINE),
    re.compile(r"-----BEGIN\s+[A-Z]+\s+PRIVATE\s+KEY-----", re.MULTILINE),
]


def check_secrets(code: str) -> IntegrityResult | None:
    for pat in _SECRET_PATTERNS:
        m = pat.search(code)
        if m:
            line = code[: m.start()].count("\n") + 1
            return IntegrityResult(
                category="secret",
                evidence=f"Line ~{line}: {m.group(0)[:80]}...",
                remediation="Remove the hardcoded API key/secret and use environment variables.",
            )
    return None


# ---------------------------------------------------------------------------
# Network egress
# ---------------------------------------------------------------------------

_NETWORK_MODULES = frozenset({
    "requests", "urllib", "urllib3", "urllib.request", "socket", "httpx", "http.client",
})
_NETWORK_CALLS = [
    ("requests", ["get", "post", "put", "delete", "request", "head", "patch"]),
    ("urllib.request", ["urlopen", "Request"]),
    ("urllib3", ["request"]),
    ("socket", ["connect", "create_connection", "connect_ex"]),
    ("httpx", ["get", "post", "AsyncClient", "Client"]),
    ("http.client", ["HTTPConnection", "HTTPSConnection"]),
]

_NETWORK_BASH = [
    re.compile(r"\b(curl|wget|nc\s|\bnetcat\s)\s", re.IGNORECASE),
    re.compile(r"/dev/tcp/"),
    re.compile(r"\$\(.*\bcurl\b.*\)", re.IGNORECASE),
]
_NETWORK_JS = [
    re.compile(r"fetch\s*\("),
    re.compile(r"axios\.(get|post|create)\s*\("),
    re.compile(r"require\s*\(\s*['\"]https?://"),
]


def _strip_single_line_comment(line: str, lang: str) -> str:
    if lang in ("bash", "shell", "sh", "python", "py"):
        return line.split("#")[0]
    if lang in ("javascript", "typescript", "js", "ts"):
        return line.split("//")[0]
    return line


def _is_likely_comment_or_string(line: str, lang: str) -> bool:
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


def _strip_strings_bash_js(line: str, lang: str) -> str:
    result: list[str] = []
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
            result.append(" ")
            continue
        result.append(c)
        i += 1
    return "".join(result)


def _check_network_python_ast(code: str) -> IntegrityResult | None:
    try:
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    mod = alias.name.split(".")[0]
                    if mod in _NETWORK_MODULES:
                        return IntegrityResult(
                            category="network",
                            evidence=f"Line ~{node.lineno}: import {alias.name}",
                            remediation=f"Package '{alias.name}' makes network calls. Use internal MockClient or declare as external tool requirement.",
                        )
            elif isinstance(node, ast.ImportFrom) and node.module:
                mod = node.module.split(".")[0]
                if mod in _NETWORK_MODULES:
                    return IntegrityResult(
                        category="network",
                        evidence=f"Line ~{node.lineno}: from {node.module} import ...",
                        remediation=f"Package '{node.module}' makes network calls. Use internal MockClient or declare as external tool requirement.",
                    )
            elif isinstance(node, ast.Call):
                func = node.func
                if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                    mod = func.value.id
                    attr = func.attr
                    for forbidden_mod, attrs in _NETWORK_CALLS:
                        if mod == forbidden_mod.split(".")[0] and attr in attrs:
                            return IntegrityResult(
                                category="network",
                                evidence=f"Line ~{node.lineno}: {mod}.{attr}(...)",
                                remediation=f"Call '{mod}.{attr}' makes network calls. Use internal MockClient or declare as external tool requirement.",
                            )
    except SyntaxError:
        pass
    return None


def check_network(code: str, language: str) -> IntegrityResult | None:
    lang = (language or "bash").lower()
    if lang in ("python", "py"):
        return _check_network_python_ast(code)
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
                return IntegrityResult(
                    category="network",
                    evidence=f"Line ~{i + 1}: {symbol[:60]}",
                    remediation=f"Call '{symbol[:40]}' makes network calls. Use internal MockClient or declare as external tool requirement.",
                )
    return None


# ---------------------------------------------------------------------------
# Dangerous commands
# ---------------------------------------------------------------------------

_DANGEROUS_BASH = [
    re.compile(r"\brm\s+-rf\s+", re.IGNORECASE),
    re.compile(r"\brm\s+--recursive\s+", re.IGNORECASE),
    re.compile(r"curl\s+[^|]*\|\s*bash", re.IGNORECASE),
    re.compile(r"wget\s+[^|]*\|\s*(?:bash|sh)\b", re.IGNORECASE),
    re.compile(r":\s*\{\s*:\s*\}\s*\|", re.MULTILINE),  # fork bomb
]


def check_dangerous_commands(code: str, language: str) -> IntegrityResult | None:
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
                return IntegrityResult(
                    category="dangerous",
                    evidence=f"Line ~{i + 1}: {m.group(0)[:60]}",
                    remediation="Remove rm -rf, curl|bash, or fork bombs. Use safer alternatives.",
                )
    return None


# ---------------------------------------------------------------------------
# Size limits
# ---------------------------------------------------------------------------

def check_max_size(code: str, limit: int = 100_000) -> IntegrityResult | None:
    if len(code) > limit:
        return IntegrityResult(
            category="size",
            evidence=f"Code length {len(code)} exceeds limit {limit}",
            remediation="Produce a shorter script or split into smaller units.",
        )
    return None


# ---------------------------------------------------------------------------
# Path safety
# ---------------------------------------------------------------------------

_PATH_DENYLIST_REGEX = re.compile(r"\b\S+\.lock\b", re.IGNORECASE)
_DEFAULT_DENYLIST = ("package-lock.json", "yarn.lock", "Cargo.lock", "poetry.lock", "pnpm-lock.yaml")


def check_path_denylist(code: str, denylist: tuple[str, ...] = _DEFAULT_DENYLIST) -> IntegrityResult | None:
    write_indicators = re.compile(
        r"(?:^|\s)(?:>|>>|cp\s|mv\s|sed\s+[^;]*\-i)",
        re.IGNORECASE | re.MULTILINE,
    )
    lines = code.splitlines()
    for i, line in enumerate(lines):
        if not write_indicators.search(line):
            continue
        for name in denylist:
            if name in line:
                return IntegrityResult(
                    category="path",
                    evidence=f"Line ~{i + 1}: {line.strip()[:60]}",
                    remediation="Remove edits to lockfiles (package-lock.json, yarn.lock, etc.).",
                )
        if _PATH_DENYLIST_REGEX.search(line):
            return IntegrityResult(
                category="path",
                evidence=f"Line ~{i + 1}: {line.strip()[:60]}",
                remediation="Remove edits to denylisted paths.",
            )
    return None


_ALLOWED_PATCH_OPS = frozenset({"add", "modify", "delete", "create", "update"})


def check_patch_op_constraints(patch_ops: list[dict[str, Any]]) -> IntegrityResult | None:
    if not patch_ops:
        return None
    for op in patch_ops:
        path = op.get("path", "") if isinstance(op, dict) else getattr(op, "path", "")
        op_type = (
            (op.get("op", "modify") or "modify") if isinstance(op, dict) else (getattr(op, "op", "modify") or "modify")
        )
        if op_type not in _ALLOWED_PATCH_OPS:
            return IntegrityResult(
                category="path",
                evidence=f"Invalid op '{op_type}' for path {path}",
                remediation="Use only add, modify, or delete. No line-range edits.",
            )
        if ".." in path or "//" in path:
            return IntegrityResult(
                category="path",
                evidence=f"Path traversal: {path}",
                remediation="Use relative paths under workspace. No '../' or '//'. Absolute paths validated by workspace boundary.",
            )
        text = (
            op.get("text", "") or op.get("content", "")
            if isinstance(op, dict)
            else getattr(op, "text", "") or getattr(op, "content", "")
        )
        if text and ("ln -s" in text or "ln -s\t" in text):
            return IntegrityResult(
                category="path",
                evidence=f"Symlink creation (ln -s) in patch content for {path}",
                remediation="Forbid symlink creation. Use regular files only.",
            )
    return None


def check_workspace_boundary(
    files_touched: list[str],
    patch_ops: list[dict[str, Any]],
    target_workspace: str,
) -> IntegrityResult | None:
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
            return IntegrityResult(
                category="workspace",
                evidence=f"Path {p} is outside target_workspace {target_workspace}",
                remediation="All paths must be under the workspace root.",
            )
    return None


# ---------------------------------------------------------------------------
# Import integrity (Python)
# ---------------------------------------------------------------------------

def check_import_integrity(code: str, language: str, trusted_packages: set[str] | None = None) -> IntegrityResult | None:
    if (language or "").lower() not in ("python", "py"):
        return None
    if not trusted_packages:
        return None
    try:
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    mod = alias.name.split(".")[0].lower()
                    if mod not in trusted_packages:
                        return IntegrityResult(
                            category="import",
                            evidence=f"import {alias.name}",
                            remediation=f"Package '{mod}' is not in trusted packages. Use an allowed package or declare as external tool requirement.",
                        )
            elif isinstance(node, ast.ImportFrom) and node.module:
                mod = node.module.split(".")[0].lower()
                if mod not in trusted_packages:
                    return IntegrityResult(
                        category="import",
                        evidence=f"from {node.module} import ...",
                        remediation=f"Package '{mod}' is not in trusted packages. Use an allowed package or declare as external tool requirement.",
                    )
    except SyntaxError:
        pass
    return None


# ---------------------------------------------------------------------------
# UTF-8 validation
# ---------------------------------------------------------------------------

def check_utf8(code: str) -> IntegrityResult | None:
    try:
        code.encode("utf-8").decode("utf-8")
        return None
    except (UnicodeDecodeError, UnicodeEncodeError):
        return IntegrityResult(
            category="binary",
            evidence="Invalid UTF-8 or binary content",
            remediation="Produce valid UTF-8 text only. No binary edits.",
        )


# ---------------------------------------------------------------------------
# Syntax check (Python only)
# ---------------------------------------------------------------------------

def check_python_syntax(code: str, language: str) -> IntegrityResult | None:
    if (language or "").lower() not in ("python", "py") or not code.strip():
        return None
    try:
        ast.parse(code)
        return None
    except SyntaxError as e:
        return IntegrityResult(
            category="path",
            evidence=f"Syntax error at line {e.lineno}: {e.msg}",
            remediation="Fix the Python syntax error and regenerate.",
        )


# ---------------------------------------------------------------------------
# High-level: run all checks
# ---------------------------------------------------------------------------

_HIGH_RISK_EXPERIMENT_CMDS = ("pip install", "pip3 install", "npm install", "yarn add", "go get", "cargo add")


def check_experiment_commands(commands: list[str]) -> IntegrityResult | None:
    for cmd in commands or []:
        c = (cmd or "").strip().lower()
        for risky in _HIGH_RISK_EXPERIMENT_CMDS:
            if risky.lower() in c:
                return IntegrityResult(
                    category="dangerous",
                    evidence=f"High-risk command: {cmd[:80]}",
                    remediation="Experiments may not run pip install, npm install, go get, etc. Use pre-installed deps.",
                )
    return None


def run_all_checks(
    code: str,
    language: str = "python",
    patch_ops: list[dict[str, Any]] | None = None,
    files_touched: list[str] | None = None,
    target_workspace: str = "",
    commands: list[str] | None = None,
    trusted_packages: set[str] | None = None,
    max_code_chars: int = 100_000,
) -> IntegrityReport:
    """Run the full battery of integrity checks and return an aggregated report.

    This is the primary entry point for MCP and standalone use.
    """
    report = IntegrityReport()
    ops = patch_ops or []

    report.add(check_workspace_boundary(files_touched or [], ops, target_workspace))
    report.add(check_patch_op_constraints(ops))
    report.add(check_max_size(code, limit=max_code_chars))
    report.add(check_path_denylist(code))
    report.add(check_import_integrity(code, language, trusted_packages))
    report.add(check_utf8(code))
    report.add(check_secrets(code))
    report.add(check_network(code, language))
    report.add(check_dangerous_commands(code, language))
    report.add(check_python_syntax(code, language))

    if commands:
        report.add(check_experiment_commands(commands))

    return report
