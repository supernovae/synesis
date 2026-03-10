"""Abstract base class for language analyzers.

Each analyzer wraps a CLI diagnostic tool, writes code to a temp directory,
runs the tool with a timeout, and parses structured output into a common
Diagnostic format.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger("synesis.lsp.analyzer")

DEFAULT_TIMEOUT = 30


@dataclass
class Diagnostic:
    severity: str  # "error", "warning", "info", "hint"
    line: int
    column: int
    message: str
    rule: str = ""
    source: str = ""


@dataclass
class AnalysisResult:
    language: str
    engine: str
    diagnostics: list[Diagnostic] = field(default_factory=list)
    analysis_time_ms: float = 0.0
    error: str | None = None
    skipped: bool = False


class BaseAnalyzer(ABC):
    """Base class all language analyzers inherit from."""

    @property
    @abstractmethod
    def engine_name(self) -> str:
        """Identifier for this analysis engine (e.g. 'basedpyright')."""

    @property
    @abstractmethod
    def language(self) -> str:
        """Primary language this analyzer targets."""

    @property
    @abstractmethod
    def file_extension(self) -> str:
        """Default file extension for code snippets (e.g. '.py')."""

    @abstractmethod
    async def _run_analysis(self, code_path: Path, workdir: Path) -> list[Diagnostic]:
        """Run the actual analysis tool. Subclasses implement this."""

    async def analyze(
        self,
        code: str,
        filename: str | None = None,
        timeout: int = DEFAULT_TIMEOUT,
    ) -> AnalysisResult:
        """Write code to a temp dir, run analysis, return structured results."""
        start = time.monotonic()
        result = AnalysisResult(language=self.language, engine=self.engine_name)

        with tempfile.TemporaryDirectory(prefix="lsp-") as tmpdir:
            workdir = Path(tmpdir)
            fname = filename or f"snippet{self.file_extension}"
            code_path = workdir / fname
            code_path.write_text(code)

            try:
                diagnostics = await asyncio.wait_for(
                    self._run_analysis(code_path, workdir),
                    timeout=timeout,
                )
                result.diagnostics = diagnostics
            except TimeoutError:
                result.error = f"Analysis timed out after {timeout}s"
                logger.warning(
                    "analysis_timeout",
                    extra={"engine": self.engine_name, "timeout": timeout},
                )
            except FileNotFoundError as exc:
                result.error = f"Tool not found: {exc.filename}"
                result.skipped = True
                logger.warning(
                    "tool_not_found",
                    extra={"engine": self.engine_name, "error": str(exc)},
                )
            except Exception as exc:
                result.error = f"Analysis error: {exc}"
                logger.exception(
                    "analysis_error",
                    extra={"engine": self.engine_name},
                )

        result.analysis_time_ms = (time.monotonic() - start) * 1000
        return result

    async def _run_command(
        self,
        cmd: list[str],
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
    ) -> tuple[int, str, str]:
        """Run a subprocess and return (returncode, stdout, stderr)."""
        run_env = {**os.environ, **(env or {})}
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=run_env,
        )
        stdout, stderr = await proc.communicate()
        return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")
