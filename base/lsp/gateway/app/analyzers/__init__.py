"""Language analyzer registry.

Maps language names to their analyzer implementations.
"""

from __future__ import annotations

from .base import AnalysisResult, BaseAnalyzer, Diagnostic
from .bash_analyzer import BashAnalyzer
from .go_analyzer import GoAnalyzer
from .java_analyzer import JavaAnalyzer
from .python_analyzer import PythonAnalyzer
from .rust_analyzer import RustAnalyzer
from .typescript_analyzer import TypeScriptAnalyzer

ANALYZERS: dict[str, BaseAnalyzer] = {
    "python": PythonAnalyzer(),
    "go": GoAnalyzer(),
    "golang": GoAnalyzer(),
    "typescript": TypeScriptAnalyzer(),
    "javascript": TypeScriptAnalyzer(),
    "js": TypeScriptAnalyzer(),
    "ts": TypeScriptAnalyzer(),
    "bash": BashAnalyzer(),
    "shell": BashAnalyzer(),
    "sh": BashAnalyzer(),
    "java": JavaAnalyzer(),
    "rust": RustAnalyzer(),
}


def get_analyzer(language: str) -> BaseAnalyzer | None:
    return ANALYZERS.get(language.lower().strip())


def supported_languages() -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for name, analyzer in ANALYZERS.items():
        engine = analyzer.engine_name
        if engine not in seen:
            seen.add(engine)
            result.append(name)
    return result


__all__ = [
    "ANALYZERS",
    "AnalysisResult",
    "BaseAnalyzer",
    "Diagnostic",
    "get_analyzer",
    "supported_languages",
]
