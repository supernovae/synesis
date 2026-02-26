"""TypeScript/JavaScript analyzer using tsc --noEmit.

Full type checking for TS/JS snippets -- catches type mismatches,
missing properties, wrong generics, and import errors.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .base import BaseAnalyzer, Diagnostic

_TSC_DIAG_RE = re.compile(
    r"^(?P<file>[^(]+)\((?P<line>\d+),(?P<col>\d+)\):\s*(?P<severity>error|warning)\s+(?P<code>TS\d+):\s*(?P<msg>.+)$"
)


class TypeScriptAnalyzer(BaseAnalyzer):
    @property
    def engine_name(self) -> str:
        return "tsc"

    @property
    def language(self) -> str:
        return "typescript"

    @property
    def file_extension(self) -> str:
        return ".ts"

    async def _run_analysis(self, code_path: Path, workdir: Path) -> list[Diagnostic]:
        tsconfig = workdir / "tsconfig.json"
        tsconfig.write_text(json.dumps({
            "compilerOptions": {
                "strict": True,
                "noEmit": True,
                "target": "ES2022",
                "module": "ES2022",
                "moduleResolution": "bundler",
                "skipLibCheck": True,
                "allowJs": True,
                "checkJs": True,
            },
            "include": [code_path.name],
        }))

        rc, stdout, stderr = await self._run_command(
            ["tsc", "--noEmit", "--pretty", "false"],
            cwd=workdir,
        )

        diagnostics: list[Diagnostic] = []
        output = stdout + stderr
        for line in output.strip().splitlines():
            m = _TSC_DIAG_RE.match(line.strip())
            if m:
                diagnostics.append(Diagnostic(
                    severity=m.group("severity"),
                    line=int(m.group("line")),
                    column=int(m.group("col")),
                    message=m.group("msg"),
                    rule=m.group("code"),
                    source="tsc",
                ))

        return diagnostics
