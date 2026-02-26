"""Python analyzer using basedpyright for deep type checking.

Catches errors that ruff misses: undefined variables, wrong argument
types, import resolution failures, type incompatibilities.
"""

from __future__ import annotations

import json
from pathlib import Path

from .base import BaseAnalyzer, Diagnostic


class PythonAnalyzer(BaseAnalyzer):
    @property
    def engine_name(self) -> str:
        return "basedpyright"

    @property
    def language(self) -> str:
        return "python"

    @property
    def file_extension(self) -> str:
        return ".py"

    async def _run_analysis(self, code_path: Path, workdir: Path) -> list[Diagnostic]:
        pyrightconfig = workdir / "pyrightconfig.json"
        pyrightconfig.write_text(json.dumps({
            "include": [code_path.name],
            "reportMissingImports": "warning",
            "reportMissingModuleSource": "none",
            "reportOptionalMemberAccess": "warning",
            "pythonVersion": "3.12",
        }))

        rc, stdout, stderr = await self._run_command(
            ["basedpyright", "--outputjson", str(code_path)],
            cwd=workdir,
        )

        diagnostics: list[Diagnostic] = []
        try:
            data = json.loads(stdout)
            for diag in data.get("generalDiagnostics", []):
                severity_map = {
                    "error": "error",
                    "warning": "warning",
                    "information": "info",
                }
                rng = diag.get("range", {}).get("start", {})
                diagnostics.append(Diagnostic(
                    severity=severity_map.get(diag.get("severity", "error"), "error"),
                    line=rng.get("line", 0) + 1,
                    column=rng.get("character", 0) + 1,
                    message=diag.get("message", ""),
                    rule=diag.get("rule", ""),
                    source="basedpyright",
                ))
        except (json.JSONDecodeError, KeyError):
            if stderr.strip():
                diagnostics.append(Diagnostic(
                    severity="error",
                    line=1,
                    column=1,
                    message=stderr.strip()[:500],
                    source="basedpyright",
                ))

        return diagnostics
