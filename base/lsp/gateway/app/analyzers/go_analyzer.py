"""Go analyzer using go vet and staticcheck.

Provides module-aware analysis, catches vet issues and common
Go pitfalls that go beyond basic compilation.
"""

from __future__ import annotations

import re
from pathlib import Path

from .base import BaseAnalyzer, Diagnostic

_GO_DIAG_RE = re.compile(r"^(?P<file>[^:]+):(?P<line>\d+):(?P<col>\d+):\s*(?P<msg>.+)$")


class GoAnalyzer(BaseAnalyzer):
    @property
    def engine_name(self) -> str:
        return "go-vet+staticcheck"

    @property
    def language(self) -> str:
        return "go"

    @property
    def file_extension(self) -> str:
        return ".go"

    async def _run_analysis(self, code_path: Path, workdir: Path) -> list[Diagnostic]:
        go_mod = workdir / "go.mod"
        if not go_mod.exists():
            go_mod.write_text("module snippet\n\ngo 1.22\n")

        diagnostics: list[Diagnostic] = []

        _rc, _stdout, stderr = await self._run_command(
            ["go", "vet", f"./{code_path.name}"],
            cwd=workdir,
            env={"GOPATH": str(workdir / ".gopath"), "GOCACHE": str(workdir / ".gocache")},
        )
        diagnostics.extend(self._parse_go_output(stderr, "go vet"))

        _rc2, stdout2, stderr2 = await self._run_command(
            ["staticcheck", f"./{code_path.name}"],
            cwd=workdir,
            env={"GOPATH": str(workdir / ".gopath"), "GOCACHE": str(workdir / ".gocache")},
        )
        diagnostics.extend(self._parse_go_output(stdout2 + stderr2, "staticcheck"))

        return diagnostics

    def _parse_go_output(self, output: str, source: str) -> list[Diagnostic]:
        diagnostics: list[Diagnostic] = []
        for line in output.strip().splitlines():
            m = _GO_DIAG_RE.match(line.strip())
            if m:
                rule = ""
                msg = m.group("msg")
                if source == "staticcheck" and " " in msg:
                    parts = msg.split(" ", 1)
                    if parts[0].startswith("SA") or parts[0].startswith("S1") or parts[0].startswith("ST"):
                        rule = parts[0]
                        msg = parts[1] if len(parts) > 1 else msg
                diagnostics.append(
                    Diagnostic(
                        severity="error" if source == "go vet" else "warning",
                        line=int(m.group("line")),
                        column=int(m.group("col")),
                        message=msg,
                        rule=rule,
                        source=source,
                    )
                )
        return diagnostics
