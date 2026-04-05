from __future__ import annotations

import re
from pathlib import Path
from typing import Any

PROMPT_ID_RE = re.compile(r"^(?:##|###)\s+([A-Z]{1,3}\d+)\s*[-—]\s*(.+?)\s*$")


def parse_prompt_ids(pack_path: Path) -> list[dict[str, str]]:
    prompts: list[dict[str, str]] = []
    for line in pack_path.read_text(encoding="utf-8").splitlines():
        match = PROMPT_ID_RE.match(line.strip())
        if not match:
            continue
        prompts.append({"id": match.group(1), "title": match.group(2)})
    return prompts


def checklist_payload(pack_path: Path) -> dict[str, Any]:
    prompts = parse_prompt_ids(pack_path)
    return {
        "pack_path": str(pack_path),
        "prompt_count": len(prompts),
        "prompts": prompts,
        "required_fields_per_run": [
            "client",
            "prompt_id",
            "result",
            "request_id",
            "model_id",
            "duration_ms",
            "input_tokens",
            "output_tokens",
            "tool_calls_total",
            "structured_error_coverage",
            "completion_gate_blocked_rate",
            "critic_block_rate",
            "first_pass_verify_rate",
        ],
    }


def ab_scaffold_payload(pack_path: Path, run_a_name: str, run_b_name: str, model_id: str) -> dict[str, Any]:
    prompts = parse_prompt_ids(pack_path)
    metric_fields = [
        "request_id",
        "duration_ms",
        "input_tokens",
        "output_tokens",
        "tool_calls_total",
        "structured_error_coverage",
        "completion_gate_blocked_rate",
        "critic_block_rate",
        "first_pass_verify_rate",
    ]
    return {
        "pack_path": str(pack_path),
        "model_id": model_id,
        "runs": [
            {
                "name": run_a_name,
                "configuration": "synesis-stack",
                "prompts": prompts,
                "collect": metric_fields,
            },
            {
                "name": run_b_name,
                "configuration": "control-upstream",
                "prompts": prompts,
                "collect": metric_fields,
            },
        ],
        "compare": {
            "fields": metric_fields,
            "derived": [
                "duration_ms_delta_pct",
                "input_tokens_delta_pct",
                "output_tokens_delta_pct",
                "completion_gate_blocked_rate_delta",
                "critic_block_rate_delta",
                "first_pass_verify_rate_delta",
            ],
        },
    }
