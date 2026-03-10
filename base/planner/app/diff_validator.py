"""Two-Phase Commit: validate diff shape before Sandbox.

Phase 1 (Proposal): Worker + DiffValidator validates that the "shape" of the
change matches strategy constraints (max_files_touched, max_loc_delta).

Pass-through for single-file: when only generated_code (no patch_ops), passes.
Transition: Worker will move from generated_code to generated_patches;
structured patches are more resilient than raw text.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..schemas import IntegrityFailure


def _unique_paths(files_touched: list[str], patch_ops: list) -> set[str]:
    """Extract unique file paths from files_touched and patch_ops."""
    paths: set[str] = set()
    for ft in files_touched or []:
        p = (ft or "").strip()
        if p and not p.startswith("#"):
            paths.add(p)
    for op in patch_ops or []:
        path = op.get("path", "") if isinstance(op, dict) else getattr(op, "path", "")
        if path:
            paths.add(path.strip())
    return paths


def validate_diff_shape(
    files_touched: list[str],
    patch_ops: list,
    revision_constraints: dict[str, Any],
    revision_strategy: str,
) -> IntegrityFailure | None:
    """Validate diff shape against revision_constraints. Returns IntegrityFailure on violation.

    Revision Constraints as Guardrails: Reject before Sandbox if Worker exceeds
    max_files_touched during e.g. Minimal Fix strategy.
    """
    constraints = revision_constraints or {}
    max_files = constraints.get("max_files_touched")
    if max_files is None:
        return None

    paths = _unique_paths(files_touched, patch_ops)
    # Single-file flow: generated_code only, no paths → implicitly 1 file, pass
    if not paths:
        return None

    file_count = len(paths)
    if file_count <= max_files:
        return None

    strategy_label = (revision_strategy or "current").replace("_", " ").title()
    return _integrity_failure(
        category="scope",
        evidence=f"Touched {file_count} files; strategy allows {max_files}",
        remediation=(
            f"Strategy '{strategy_label}' allows only {max_files} file change(s). You touched {file_count}. "
            "Re-evaluate if this change can be more surgical or request a 'Refactor' strategy escalation."
        ),
    )


def _integrity_failure(category: str, evidence: str, remediation: str) -> IntegrityFailure:
    from ..schemas import IntegrityFailure

    return IntegrityFailure(category=category, evidence=evidence, remediation=remediation)


def validate_proposed_diff_set(
    proposed_diff_set: list[dict[str, Any]],
    revision_constraints: dict[str, Any],
    target_workspace: str,
) -> tuple[bool, str]:
    """Validate diff shape for proposed_diff_set format (multi-file Worker schema).

    Used when Worker outputs proposed_diff_set instead of generated_code.
    Returns (passed, message).
    """
    if not proposed_diff_set:
        return True, ""
    constraints = revision_constraints or {}
    max_files = constraints.get("max_files_touched", 10)
    max_delta = constraints.get("max_loc_delta", 200)

    if len(proposed_diff_set) > max_files:
        return False, (
            f"Strategy allows only {max_files} file(s). You proposed {len(proposed_diff_set)}. "
            "Re-evaluate or request Refactor strategy escalation."
        )

    total_delta = 0
    for entry in proposed_diff_set:
        old_c = (entry.get("old_content") or "").splitlines()
        new_c = (entry.get("new_content") or "").splitlines()
        total_delta += abs(len(new_c) - len(old_c))
    if total_delta > max_delta:
        return False, f"LOC delta {total_delta} exceeds max {max_delta}."

    prefix = (target_workspace or "").rstrip("/")
    if prefix:
        for entry in proposed_diff_set:
            p = (entry.get("path") or "").strip()
            if p and not (p.startswith(prefix + "/") or p == prefix):
                return False, f"Path {p} is outside target_workspace."
    return True, ""
