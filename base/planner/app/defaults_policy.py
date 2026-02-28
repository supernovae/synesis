"""DefaultsPolicy — code constants as baseline, YAML overrides layered on top.

Design: Policy + Defaults as data, not prompt prose. Enables tuning without
editing prompts. Precedence: Code → Org config → Project config.

Hard fences (is_hard_fence=True) cannot be overridden by YAML.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger("synesis.defaults_policy")

# -----------------------------------------------------------------------------
# Code constants (Tier 1 baseline) — guarantees sane defaults even if config missing
# -----------------------------------------------------------------------------

CODE_DEFAULTS: dict[str, Any] = {
    "default_language": "python",
    "default_test_runner": "pytest",
    "default_python_version": "3.11",
    "default_files": {
        "single_file": "main.py",
        "python_project": ["hello.py", "test_hello.py"],
        "python_with_tests": ["hello.py", "test_hello.py"],
    },
    "allow_questions_for_trivial": False,  # Hard fence
    "plan_required_for_small": False,
    "plan_required_for_trivial": False,
}

# Fields that cannot be overridden by YAML (safety/integrity)
HARD_FENCES = frozenset(
    {
        "allow_questions_for_trivial",
        "trivial_fast_path_never_asks",
    }
)


def _load_yaml(path: str | Path) -> dict[str, Any]:
    """Load YAML file. Returns {} if file missing or invalid."""
    try:
        import yaml

        p = Path(path)
        if not p.exists():
            return {}
        with open(p) as f:
            data = yaml.safe_load(f)
            return dict(data) if isinstance(data, dict) else {}
    except Exception as e:
        logger.debug("defaults_policy: load_yaml failed %s: %s", path, e)
        return {}


def _merge_overrides(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Merge override into base. Hard fences from base cannot be overridden."""
    result = dict(base)
    for k, v in override.items():
        if k in HARD_FENCES:
            continue
        if isinstance(v, dict) and isinstance(result.get(k), dict):
            result[k] = _merge_overrides(result[k], v)
        else:
            result[k] = v
    return result


@dataclass
class DefaultsPolicy:
    """Resolved policy with source metadata for debugging."""

    default_language: str = "python"
    default_test_runner: str = "pytest"
    default_python_version: str = "3.11"
    default_files: dict[str, list[str] | str] = field(default_factory=lambda: {"single_file": "main.py", "python_project": ["hello.py", "test_hello.py"]})
    allow_questions_for_trivial: bool = False
    plan_required_for_small: bool = False
    plan_required_for_trivial: bool = False
    # Optional: plan-approval thresholds, budget tuning (from YAML)
    plan_approval_min_steps: int = 0
    source: str = "code"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DefaultsPolicy":
        """Build from resolved dict."""
        files = data.get("default_files", CODE_DEFAULTS["default_files"])
        return cls(
            default_language=str(data.get("default_language", CODE_DEFAULTS["default_language"])),
            default_test_runner=str(data.get("default_test_runner", CODE_DEFAULTS["default_test_runner"])),
            default_python_version=str(data.get("default_python_version", CODE_DEFAULTS["default_python_version"])),
            default_files=dict(files) if isinstance(files, dict) else {"single_file": "main.py", "python_project": ["hello.py", "test_hello.py"]},
            allow_questions_for_trivial=CODE_DEFAULTS["allow_questions_for_trivial"],  # Hard fence
            plan_required_for_small=bool(data.get("plan_required_for_small", CODE_DEFAULTS["plan_required_for_small"])),
            plan_required_for_trivial=bool(data.get("plan_required_for_trivial", CODE_DEFAULTS["plan_required_for_trivial"])),
            plan_approval_min_steps=int(data.get("plan_approval_min_steps", 0)),
            source=data.get("_source", "merged"),
        )

    def get_trivial_files(self, language: str, include_tests: bool = True) -> list[str]:
        """Default touched_files for trivial tasks. Python: hello.py+test_hello.py; others: main.py."""
        if language == "python":
            return list(self.default_files.get("python_project", ["hello.py", "test_hello.py"]))
        return ["main.py", "main_test.py"] if include_tests else ["main.py"]

    def get_defaults_used(self, language: str) -> list[str]:
        """Human-readable defaults for micro-ack."""
        if language == "python":
            return [f"Python {self.default_python_version}", self.default_test_runner]
        return ["default runtime"]


_resolved: DefaultsPolicy | None = None


def get_defaults_policy() -> DefaultsPolicy:
    """Resolve policy: code → org YAML → project YAML. Cached after first load."""
    global _resolved
    if _resolved is not None:
        return _resolved

    merged = dict(CODE_DEFAULTS)
    merged["_source"] = "code"

    # Org config: settings.defaults_policy_path > SYNESIS_DEFAULTS_PATH > /etc/synesis/defaults.yaml
    import os

    from .config import settings

    org_path = (
        (settings.defaults_policy_path if settings.defaults_policy_path else None)
        or os.environ.get("SYNESIS_DEFAULTS_PATH")
        or "/etc/synesis/defaults.yaml"
    )
    org_data = _load_yaml(org_path)
    if org_data:
        merged = _merge_overrides(merged, org_data)
        merged["_source"] = "org"

    # Project config: .synesis.yaml in workspace (optional; would need workspace path from state)
    # Skip for now — project config requires runtime context

    _resolved = DefaultsPolicy.from_dict(merged)
    return _resolved


def reset_defaults_policy() -> None:
    """Reset cache (for tests)."""
    global _resolved
    _resolved = None
