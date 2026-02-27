"""TrivialSynth -- deterministic code generation for trivial tasks.

Bypasses the Executor LLM for hello world, simple print, basic unit test.
Eliminates LLM variance and produces instant, correct output.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from ..state import NodeOutcome, NodeTrace

logger = logging.getLogger("synesis.trivial_synth")


def _hello_world(user_msg: str) -> dict[str, Any]:
    """Generate hello world for detected language."""
    lower = (user_msg or "").lower()
    if "test" in lower or "pytest" in lower or "unit test" in lower:
        hello_py = '"""Hello world module."""\n\n\ndef main() -> None:\n    print("Hello, world!")\n\n\nif __name__ == "__main__":\n    main()\n'
        test_py = '"""Test hello module."""\nimport pytest\nfrom hello import main\n\n\ndef test_main(capsys):\n    main()\n    captured = capsys.readouterr()\n    assert "Hello, world!" in captured.out\n'
        combined = f"# hello.py\n{hello_py}\n\n# test_hello.py\n{test_py}"
        return {
            "target_language": "python",
            "generated_code": combined,
            "patch_ops": [
                {"path": "hello.py", "op": "create", "text": hello_py},
                {"path": "test_hello.py", "op": "create", "text": test_py},
            ],
            "code_explanation": "Hello world in hello.py plus pytest test in test_hello.py. Run: python hello.py and pytest -q",
            "defaults_used": ["pytest", "Python 3.11+"],
        }
    return {
        "target_language": "python",
        "generated_code": 'print("Hello, world!")\n',
        "code_explanation": "Minimal hello world. Run: python hello.py",
        "defaults_used": ["Python"],
    }


# (pattern, resolver_fn)
_TRIVIAL_TEMPLATES: list[tuple[re.Pattern[str], Any]] = [
    (
        re.compile(r"hello\s+world|print\s+hello|basic\s+print|simple\s+hello", re.IGNORECASE),
        _hello_world,
    ),
]


def _detect_trivial_pattern(user_msg: str) -> dict[str, Any] | None:
    """Match user message to trivial template. Returns template output or None."""
    if not user_msg or not user_msg.strip():
        return None
    text = user_msg.strip()[:500]
    for pattern, resolver in _TRIVIAL_TEMPLATES:
        if pattern.search(text):
            result = resolver(text) if callable(resolver) else resolver
            if isinstance(result, dict):
                return result
    return None


def trivial_synth_node(state: dict[str, Any]) -> dict[str, Any]:
    """Deterministic trivial task handler. Produces code without LLM."""
    node_name = "trivial_synth"

    messages = state.get("messages", [])
    user_context = ""
    if messages:
        last_user = next(
            (m for m in reversed(messages) if hasattr(m, "type") and m.type == "human"),
            None,
        )
        if last_user:
            user_context = last_user.content or ""

    task_desc = state.get("task_description", "") or user_context
    target_lang = state.get("target_language", "python")

    # Prefer python hello world template; extend for other langs later
    if "python" in (task_desc + user_context).lower() or target_lang == "python":
        result = _detect_trivial_pattern(task_desc or user_context)
        if result:
            logger.info("trivial_synth_matched", extra={"task": task_desc[:80]})
            trace = NodeTrace(
                node_name=node_name,
                reasoning="Deterministic trivial template",
                assumptions=["pytest" if "test" in (task_desc + user_context).lower() else "Python"],
                confidence=1.0,
                outcome=NodeOutcome.SUCCESS,
                latency_ms=0,
            )
            out: dict[str, Any] = {
                "generated_code": result.get("generated_code", ""),
                "code_explanation": result.get("code_explanation", ""),
                "target_language": result.get("target_language", target_lang),
                "defaults_used": result.get("defaults_used", ["Python"]),
                "current_node": node_name,
                "next_node": "respond",
                "node_traces": [trace],
            }
            if result.get("patch_ops"):
                out["patch_ops"] = result["patch_ops"]
            return out

    # No match: fall through to Worker (shouldn't happen if Supervisor routed correctly)
    logger.info("trivial_synth_no_match", extra={"task": task_desc[:80]})
    return {
        "current_node": node_name,
        "next_node": "context_curator",
    }
