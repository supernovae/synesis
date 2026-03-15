"""MCP tool: synesis_patch_integrity — deterministic code safety checks.

Validates proposed code/patches for secrets, network egress, dangerous
commands, path traversal, and other safety violations. Returns pass/fail
with category and remediation for each failure.

Uses integrity_core from the planner package (shared logic).
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any

logger = logging.getLogger("synesis.mcp.patch_integrity")

# integrity_core lives in the planner package; add it to sys.path if
# running from the MCP service image (which may not have planner installed).
_PLANNER_APP = str(Path(__file__).resolve().parents[3] / "planner")
if _PLANNER_APP not in sys.path:
    sys.path.insert(0, _PLANNER_APP)

from app.integrity_core import IntegrityReport, run_all_checks  # noqa: E402

TOOL_DEFINITION: dict[str, Any] = {
    "name": "synesis_patch_integrity",
    "description": (
        "Deterministic safety check for proposed code or patches. "
        "Validates for secrets, network egress, dangerous commands, "
        "path traversal, untrusted imports, and size limits. "
        "Returns pass/fail with categories and remediations."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": "The code or script to validate",
            },
            "language": {
                "type": "string",
                "description": "Programming language (python, bash, javascript, typescript)",
                "default": "python",
            },
            "patch_ops": {
                "type": "array",
                "description": "Optional list of patch operations [{path, op, text}]",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "op": {"type": "string", "enum": ["add", "modify", "delete"]},
                        "text": {"type": "string"},
                    },
                },
                "default": [],
            },
            "files_touched": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of file paths being modified",
                "default": [],
            },
            "target_workspace": {
                "type": "string",
                "description": "Workspace root path for boundary checks",
                "default": "",
            },
            "commands": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional experiment/build commands to validate",
                "default": [],
            },
        },
        "required": ["code"],
    },
}


def _report_to_dict(report: IntegrityReport) -> dict[str, Any]:
    return {
        "passed": report.passed,
        "failures": [
            {
                "category": f.category,
                "evidence": f.evidence,
                "remediation": f.remediation,
            }
            for f in report.failures
        ],
    }


async def handle(args: dict[str, Any]) -> dict[str, Any]:
    """MCP tool handler for synesis_patch_integrity."""
    code = args.get("code", "")
    language = args.get("language", "python")
    patch_ops = args.get("patch_ops", [])
    files_touched = args.get("files_touched", [])
    target_workspace = args.get("target_workspace", "")
    commands = args.get("commands", [])

    report = run_all_checks(
        code=code,
        language=language,
        patch_ops=patch_ops,
        files_touched=files_touched,
        target_workspace=target_workspace,
        commands=commands,
    )

    result = _report_to_dict(report)
    logger.info(
        "patch_integrity_check",
        extra={"passed": report.passed, "failure_count": len(report.failures)},
    )
    return result
