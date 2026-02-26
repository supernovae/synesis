"""Java analyzer using javac with all warnings enabled.

Catches compilation errors, type mismatches, deprecation usage,
and unchecked operations in Java code snippets.
"""

from __future__ import annotations

import re
from pathlib import Path

from .base import BaseAnalyzer, Diagnostic

_JAVAC_DIAG_RE = re.compile(r"^(?P<file>[^:]+):(?P<line>\d+):\s*(?P<severity>error|warning):\s*(?P<msg>.+)$")


class JavaAnalyzer(BaseAnalyzer):
    @property
    def engine_name(self) -> str:
        return "javac"

    @property
    def language(self) -> str:
        return "java"

    @property
    def file_extension(self) -> str:
        return ".java"

    async def _run_analysis(self, code_path: Path, workdir: Path) -> list[Diagnostic]:
        _rc, stdout, stderr = await self._run_command(
            [
                "javac",
                "-Xlint:all",
                "-d",
                str(workdir / "out"),
                str(code_path),
            ],
            cwd=workdir,
        )

        (workdir / "out").mkdir(exist_ok=True)

        diagnostics: list[Diagnostic] = []
        output = stdout + stderr
        for line in output.strip().splitlines():
            m = _JAVAC_DIAG_RE.match(line.strip())
            if m:
                diagnostics.append(
                    Diagnostic(
                        severity=m.group("severity"),
                        line=int(m.group("line")),
                        column=1,
                        message=m.group("msg"),
                        rule="",
                        source="javac",
                    )
                )

        return diagnostics
