#!/usr/bin/env python3
"""Deterministic baseline evaluator for planner-ts migration parity.

Reads a JSON state from stdin, evaluates Python deterministic validators,
and writes a compact JSON result to stdout.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def _load_state() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
        return {}
    except json.JSONDecodeError:
        return {}


def main() -> int:
    planner_root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(planner_root))

    from app.contract_validator import (  # noqa: PLC0415
        validate_citation_preservation,
        validate_decision_drift,
        validate_style_compliance,
    )
    from app.oscillation_detector import detect_oscillation  # noqa: PLC0415

    state = _load_state()

    style_passed, style_violations = validate_style_compliance(state)
    decision_passed, decision_violations = validate_decision_drift(state)
    citation_passed, citation_violations = validate_citation_preservation(state)
    osc = detect_oscillation(state)

    payload = {
        "style_passed": bool(style_passed),
        "decision_passed": bool(decision_passed),
        "citation_passed": bool(citation_passed),
        "style_violations_count": len(style_violations),
        "decision_violations_count": len(decision_violations),
        "citation_violations_count": len(citation_violations),
        "oscillation_total_score": float(round(osc.total_score, 6)),
        "oscillation_decision_score": float(round(osc.decision_score, 6)),
    }
    sys.stdout.write(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
