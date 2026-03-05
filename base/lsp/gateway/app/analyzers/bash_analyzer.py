"""Bash/Shell analyzer using shellcheck with JSON output.

Provides deeper analysis than the sandbox's basic shellcheck run,
with structured SC-level categories for richer error feedback.
"""

from __future__ import annotations

import json
from pathlib import Path

from .base import BaseAnalyzer, Diagnostic


class BashAnalyzer(BaseAnalyzer):
    @property
    def engine_name(self) -> str:
        return "shellcheck"

    @property
    def language(self) -> str:
        return "bash"

    @property
    def file_extension(self) -> str:
        return ".sh"

    async def _run_analysis(self, code_path: Path, workdir: Path) -> list[Diagnostic]:
        _rc, stdout, stderr = await self._run_command(
            [
                "shellcheck",
                "--format=json",
                "--severity=style",
                "--shell=bash",
                str(code_path),
            ],
            cwd=workdir,
        )

        diagnostics: list[Diagnostic] = []
        try:
            findings = json.loads(stdout) if stdout.strip() else []
            for f in findings:
                severity_map = {
                    "error": "error",
                    "warning": "warning",
                    "info": "info",
                    "style": "hint",
                }
                diagnostics.append(
                    Diagnostic(
                        severity=severity_map.get(f.get("level", "warning"), "warning"),
                        line=f.get("line", 1),
                        column=f.get("column", 1),
                        message=f.get("message", ""),
                        rule=f"SC{f.get('code', '')}",
                        source="shellcheck",
                    )
                )
        except json.JSONDecodeError:
            if stderr.strip():
                diagnostics.append(
                    Diagnostic(
                        severity="error",
                        line=1,
                        column=1,
                        message=stderr.strip()[:500],
                        source="shellcheck",
                    )
                )

        return diagnostics
