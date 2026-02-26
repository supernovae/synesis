"""Rust analyzer using cargo check with JSON message output.

Provides full compiler diagnostics without building binaries --
catches type errors, borrow checker violations, lifetime issues,
and unused imports.
"""

from __future__ import annotations

import json
from pathlib import Path

from .base import BaseAnalyzer, Diagnostic


class RustAnalyzer(BaseAnalyzer):
    @property
    def engine_name(self) -> str:
        return "cargo-check"

    @property
    def language(self) -> str:
        return "rust"

    @property
    def file_extension(self) -> str:
        return ".rs"

    async def _run_analysis(self, code_path: Path, workdir: Path) -> list[Diagnostic]:
        cargo_toml = workdir / "Cargo.toml"
        if not cargo_toml.exists():
            cargo_toml.write_text(
                '[package]\nname = "snippet"\nversion = "0.1.0"\nedition = "2021"\n'
            )
            src_dir = workdir / "src"
            src_dir.mkdir(exist_ok=True)
            (src_dir / "main.rs").write_text(code_path.read_text())

        rc, stdout, stderr = await self._run_command(
            [
                "cargo", "check",
                "--message-format=json",
            ],
            cwd=workdir,
            env={"CARGO_HOME": str(workdir / ".cargo")},
        )

        diagnostics: list[Diagnostic] = []
        for line in stdout.strip().splitlines():
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue

            if msg.get("reason") != "compiler-message":
                continue

            compiler_msg = msg.get("message", {})
            level = compiler_msg.get("level", "error")
            severity_map = {
                "error": "error",
                "warning": "warning",
                "note": "info",
                "help": "hint",
            }

            spans = compiler_msg.get("spans", [])
            primary_span = next(
                (s for s in spans if s.get("is_primary")),
                spans[0] if spans else None,
            )

            diag_line = 1
            diag_col = 1
            if primary_span:
                diag_line = primary_span.get("line_start", 1)
                diag_col = primary_span.get("column_start", 1)

            code_info = compiler_msg.get("code")
            rule = ""
            if isinstance(code_info, dict):
                rule = code_info.get("code", "")

            diagnostics.append(Diagnostic(
                severity=severity_map.get(level, "error"),
                line=diag_line,
                column=diag_col,
                message=compiler_msg.get("message", ""),
                rule=rule,
                source="cargo-check",
            ))

        return diagnostics
