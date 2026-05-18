"""Phase 19 — Pattern Library, eval harness extensions, and bootstrap validation."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
import yaml

# ── Model tests ──────────────────────────────────────────────────────────────


def test_pattern_entry_instantiation():
    from app.db.models import PatternEntry

    p = PatternEntry(
        pattern_id="test-pattern",
        language="python",
        skill_family="api_endpoint",
        code_block="def hello(): pass",
        trust_score=0.5,
    )
    assert p.pattern_id == "test-pattern"
    assert p.language == "python"
    assert p.trust_score == 0.5


def test_pattern_entry_explicit_defaults():
    from app.db.models import PatternEntry

    p = PatternEntry(
        pattern_id="x",
        language="go",
        skill_family="error_handling",
        code_block="func main() {}",
        enabled=True,
        scope="global",
        usage_count=0,
    )
    assert p.enabled is True
    assert p.scope == "global"
    assert p.usage_count == 0


def test_content_hash_consistency():
    from app.services.pattern_sync import _compute_hash

    h1 = _compute_hash("hello world")
    h2 = _compute_hash("hello world")
    assert h1 == h2
    assert len(h1) == 16


# ── Migration tests ──────────────────────────────────────────────────────────


def test_migration_043_exists():
    path = Path(__file__).parent.parent / "alembic" / "versions" / "043_pattern_entries.py"
    assert path.exists(), f"Migration file not found: {path}"
    content = path.read_text()
    assert 'revision: str = "043"' in content
    assert "pattern_entries" in content
    assert "def downgrade" in content


# ── Sync service tests ───────────────────────────────────────────────────────


def test_content_body_format():
    from app.db.models import PatternEntry
    from app.services.pattern_sync import _content_body

    p = PatternEntry(
        pattern_id="py-fastapi",
        language="python",
        skill_family="api_endpoint",
        code_block="@app.get('/hello')\ndef hello(): return {'msg': 'hi'}",
        description="A simple FastAPI endpoint.",
        constraints="Use Pydantic models for validation.",
    )
    body = _content_body(p)
    assert "# python / api_endpoint: py-fastapi" in body
    assert "A simple FastAPI endpoint." in body
    assert "Constraints:" in body
    assert "```python" in body


def test_compute_hash_is_sha256_prefix():
    from app.services.pattern_sync import _compute_hash

    text = "test content"
    expected = hashlib.sha256(text.encode()).hexdigest()[:16]
    assert _compute_hash(text) == expected


# ── Loader tests ──────────────────────────────────────────────────────────────


def test_loader_hash_deterministic():
    from app.services.pattern_loader import _hash_code

    assert _hash_code("abc") == _hash_code("abc")
    assert _hash_code("abc") != _hash_code("def")


def test_loader_file_not_found():
    import asyncio

    from app.services.pattern_loader import load_patterns_from_yaml

    with pytest.raises(FileNotFoundError):
        asyncio.run(load_patterns_from_yaml("/nonexistent/path.yaml"))


# ── Eval harness extended tests ──────────────────────────────────────────────


def test_check_expectations_decision_path_warning():
    from app.services.eval_harness import EvalCase, _check_expectations

    case = EvalCase(prompt="test", expected_decision_path="deterministic")
    result = _check_expectations(
        case,
        100,
        50,
        {
            "choices": [{"message": {"content": "ok"}}],
            "_decision_path": "inference_first",
        },
    )
    assert result.decision_path_match is False
    assert any("decision_path mismatch" in w for w in result.warnings)
    assert len(result.failures) == 0


def test_check_expectations_decision_path_match():
    from app.services.eval_harness import EvalCase, _check_expectations

    case = EvalCase(prompt="test", expected_decision_path="deterministic")
    result = _check_expectations(
        case,
        100,
        50,
        {
            "choices": [{"message": {"content": "ok"}}],
            "_decision_path": "deterministic",
        },
    )
    assert result.decision_path_match is True
    assert len(result.warnings) == 0


def test_check_expectations_language_match():
    from app.services.eval_harness import EvalCase, _check_expectations

    case = EvalCase(prompt="test", expected_languages=["go"])
    result = _check_expectations(
        case,
        100,
        50,
        {
            "choices": [{"message": {"content": "ok"}}],
            "_detected_languages": ["go", "python"],
        },
    )
    assert result.language_match is True
    assert result.actual_languages == ["go", "python"]


def test_check_expectations_language_mismatch():
    from app.services.eval_harness import EvalCase, _check_expectations

    case = EvalCase(prompt="test", expected_languages=["rust"])
    result = _check_expectations(
        case,
        100,
        50,
        {
            "choices": [{"message": {"content": "ok"}}],
            "_detected_languages": ["go"],
        },
    )
    assert result.language_match is False
    assert any("language mismatch" in w for w in result.warnings)


def test_check_expectations_recall_routing():
    from app.services.eval_harness import EvalCase, _check_expectations

    case = EvalCase(prompt="test", expected_recall_routing="bypass")
    result = _check_expectations(
        case,
        100,
        50,
        {
            "choices": [{"message": {"content": "ok"}}],
            "_recall_routing": "bypass",
        },
    )
    assert result.recall_routing_match is True


def test_pattern_recall_suite_exists():
    from app.services.eval_harness import BUILTIN_SUITES

    assert "pattern_recall" in BUILTIN_SUITES
    suite = BUILTIN_SUITES["pattern_recall"]
    assert len(suite.cases) >= 5


def test_case_result_has_new_fields():
    from app.services.eval_harness import CaseResult

    cr = CaseResult(
        case_index=0,
        prompt_snippet="test",
        category="test",
        passed=True,
        decision_path_match=True,
        recall_routing_match=None,
        language_match=True,
        warnings=["test warning"],
    )
    assert cr.decision_path_match is True
    assert cr.language_match is True
    assert len(cr.warnings) == 1


def test_check_expectations_hard_failures():
    from app.services.eval_harness import EvalCase, _check_expectations

    case = EvalCase(prompt="test", max_latency_ms=50, max_tokens=10)
    result = _check_expectations(
        case,
        100,
        50,
        {
            "choices": [{"message": {"content": "ok"}}],
        },
    )
    assert len(result.failures) == 2
    assert any("latency" in f for f in result.failures)
    assert any("tokens" in f for f in result.failures)


# ── Bootstrap pattern validation ─────────────────────────────────────────────


BOOTSTRAP_DIR = Path(__file__).parent.parent.parent.parent / "bootstrap" / "patterns"


def test_bootstrap_yamls_parse():
    if not BOOTSTRAP_DIR.is_dir():
        pytest.skip("Bootstrap patterns directory not found")
    for yf in sorted(BOOTSTRAP_DIR.glob("*.yaml")):
        data = yaml.safe_load(yf.read_text())
        assert "patterns" in data, f"{yf.name} missing 'patterns' key"
        assert len(data["patterns"]) > 0, f"{yf.name} has no patterns"


def test_bootstrap_required_fields():
    if not BOOTSTRAP_DIR.is_dir():
        pytest.skip("Bootstrap patterns directory not found")
    required = {"pattern_id", "language", "skill_family", "code_block"}
    for yf in sorted(BOOTSTRAP_DIR.glob("*.yaml")):
        data = yaml.safe_load(yf.read_text())
        for i, entry in enumerate(data.get("patterns", [])):
            for field in required:
                assert entry.get(field), f"{yf.name} pattern[{i}] missing or empty '{field}'"


def test_bootstrap_no_duplicate_pattern_ids():
    if not BOOTSTRAP_DIR.is_dir():
        pytest.skip("Bootstrap patterns directory not found")
    all_ids: list[str] = []
    for yf in sorted(BOOTSTRAP_DIR.glob("*.yaml")):
        data = yaml.safe_load(yf.read_text())
        for entry in data.get("patterns", []):
            all_ids.append(entry.get("pattern_id", ""))
    dupes = [pid for pid in all_ids if all_ids.count(pid) > 1]
    assert len(set(dupes)) == 0, f"Duplicate pattern_ids: {set(dupes)}"


# ── Indexer content_profile allowlist ────────────────────────────────────────


def test_indexer_pattern_content_profile_allowed():
    """Verify 'pattern' is in the indexer content_profile allowlist."""
    pipeline_path = Path(__file__).parent.parent.parent / "rag" / "indexer" / "app" / "pipeline.py"
    if not pipeline_path.exists():
        pytest.skip("pipeline.py not found")
    content = pipeline_path.read_text()
    assert '"pattern"' in content
    assert '"conceptual"' in content
    assert '"troubleshooting"' in content
