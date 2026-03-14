"""Read models.yaml and LiteLLM config for model registry."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

from ..deps import MODELS_YAML_PATH

logger = logging.getLogger("synesis.admin.models")

_cache: dict[str, Any] | None = None


def _load_models_yaml() -> dict[str, Any]:
    global _cache
    if _cache is not None:
        return _cache
    p = Path(MODELS_YAML_PATH)
    if not p.exists():
        logger.info("models_yaml_not_found path=%s", p)
        return {}
    try:
        with open(p) as f:
            _cache = yaml.safe_load(f) or {}
        return _cache
    except Exception as exc:
        logger.warning("models_yaml_error error=%s", str(exc)[:80])
        return {}


def get_model_registry() -> list[dict]:
    data = _load_models_yaml()
    roles = data.get("roles", {})
    models = []
    for role_name, role_cfg in roles.items():
        models.append({
            "role": role_name,
            "model_name": role_cfg.get("default_model", ""),
            "served_name": role_cfg.get("served_model_name", role_name),
            "endpoint": f"http://{role_cfg.get('service_name', role_name)}.{role_cfg.get('namespace', 'synesis-models')}.svc.cluster.local:8080/v1",
            "status": "healthy",
            "description": role_cfg.get("description", ""),
        })
    return models


def get_cost_estimates() -> list[dict]:
    data = _load_models_yaml()
    profiles = data.get("profiles", {})
    costs = []

    for profile_name, profile_cfg in profiles.items():
        assignments = profile_cfg.get("assignments", {})
        for role, assignment in assignments.items():
            model = assignment.get("model_override", "")
            notes = assignment.get("notes", "")
            input_cost = 0.0
            output_cost = 0.0
            if "$" in notes and "/M" in notes:
                try:
                    parts = notes.split("$")
                    for part in parts[1:]:
                        val = part.split("/M")[0].strip()
                        num = float(val)
                        if input_cost == 0:
                            input_cost = num
                        else:
                            output_cost = num
                except (ValueError, IndexError):
                    pass

            costs.append({
                "role": role,
                "model": model,
                "profile": profile_name,
                "input_per_million": input_cost,
                "output_per_million": output_cost,
                "estimated_monthly": 0,
            })
    return costs
