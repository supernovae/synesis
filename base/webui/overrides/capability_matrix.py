from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlparse

log = logging.getLogger(__name__)

CAPABILITY_MATRIX_ADMIN_URL = os.getenv("SYNESIS_ADMIN_URL", "").rstrip("/")
CAPABILITY_MATRIX_ADMIN_TOKEN = os.getenv("SYNESIS_ADMIN_INTERNAL_TOKEN", "")
CAPABILITY_MATRIX_CACHE_TTL_S = max(5, int(os.getenv("SYNESIS_WEBUI_CAPABILITY_MATRIX_TTL_S", "30") or "30"))
_CAPABILITY_MATRIX_CACHE = {
    "etag": "",
    "fetched_at": 0.0,
    "payload": {
        "version": 1,
        "mode": "enforced",
        "global_optimizations_enabled": False,
        "overrides": [],
    },
}

KNOWN_CAPABILITY_KEYS = (
    "yarn.reducers_enabled",
    "yarn.transcript_prune_enabled",
    "yarn.phase_execution_policy_enabled",
    "yarn.json_compaction_enabled",
    "yarn.content_dedupe_enabled",
    "yarn.response_dedupe_enabled",
    "yarn.historical_normalize_enabled",
    "planner.context_optimizer_enabled",
    "webui.builtin_tools_enabled",
    "webui.file_context_enabled",
)


@dataclass(frozen=True)
class CapabilityMatrixInput:
    model_id: str
    model_path: str = ""
    family: str = ""


def _norm(value: str | None) -> str:
    return str(value or "").strip().lower()


def _infer_model_family(model_id: str) -> str:
    normalized = _norm(model_id)
    if not normalized:
        return "generic"
    return normalized.split("/", 1)[0] if "/" in normalized else normalized.split("-", 1)[0]


def _fetch_capability_matrix_payload() -> dict[str, Any]:
    if not CAPABILITY_MATRIX_ADMIN_URL or not CAPABILITY_MATRIX_ADMIN_TOKEN:
        return _CAPABILITY_MATRIX_CACHE["payload"]

    parsed_admin_url = urlparse(CAPABILITY_MATRIX_ADMIN_URL)
    if parsed_admin_url.scheme not in {"http", "https"} or not parsed_admin_url.netloc:
        return _CAPABILITY_MATRIX_CACHE["payload"]

    req = urllib_request.Request(  # noqa: S310 - scheme and authority validated above
        f"{CAPABILITY_MATRIX_ADMIN_URL}/api/v1/governance/capability-matrix/effective",
        headers={
            "Authorization": f"Bearer {CAPABILITY_MATRIX_ADMIN_TOKEN}",
            "x-synesis-service-token": CAPABILITY_MATRIX_ADMIN_TOKEN,
            "x-synesis-service-name": "synesis-webui",
            **({"If-None-Match": f'"{_CAPABILITY_MATRIX_CACHE["etag"]}"'} if _CAPABILITY_MATRIX_CACHE["etag"] else {}),
        },
    )

    try:
        # URL scheme and authority are validated above; endpoint is deployment configuration.
        with urllib_request.urlopen(req, timeout=4) as response:  # noqa: S310  # nosec B310
            if response.getcode() == 304:
                _CAPABILITY_MATRIX_CACHE["fetched_at"] = time.time()
                return _CAPABILITY_MATRIX_CACHE["payload"]
            payload = json.loads(response.read().decode("utf-8"))
            _CAPABILITY_MATRIX_CACHE["payload"] = {
                "version": int(payload.get("version", 1)),
                "mode": "shadow" if payload.get("mode") == "shadow" else "enforced",
                "global_optimizations_enabled": payload.get("global_optimizations_enabled") is True,
                "overrides": payload.get("overrides", []),
            }
            etag = payload.get("etag")
            if isinstance(etag, str) and etag.strip():
                _CAPABILITY_MATRIX_CACHE["etag"] = etag.strip().strip('"')
            _CAPABILITY_MATRIX_CACHE["fetched_at"] = time.time()
    except urllib_error.HTTPError as exc:
        if exc.code == 304:
            _CAPABILITY_MATRIX_CACHE["fetched_at"] = time.time()
        else:
            log.debug("capability matrix fetch failed status=%s", exc.code)
    except Exception as exc:
        log.debug("capability matrix fetch error: %s", exc)
    return _CAPABILITY_MATRIX_CACHE["payload"]


def get_cached_capability_matrix_payload() -> dict[str, Any]:
    if time.time() - float(_CAPABILITY_MATRIX_CACHE.get("fetched_at", 0.0)) >= CAPABILITY_MATRIX_CACHE_TTL_S:
        return _fetch_capability_matrix_payload()
    return _CAPABILITY_MATRIX_CACHE["payload"]


def _selector_rank(selector_type: str) -> int:
    if selector_type == "family_prefix":
        return 1
    if selector_type == "model_path_prefix":
        return 2
    return 3


def _matches_selector(row: dict[str, Any], matrix_input: CapabilityMatrixInput) -> bool:
    selector_type = row.get("selector_type", "")
    selector = _norm(row.get("selector", ""))
    if not selector:
        return False
    if selector_type == "exact_model":
        return _norm(matrix_input.model_id) == selector
    if selector_type == "model_path_prefix":
        model_path = _norm(matrix_input.model_path)
        return bool(model_path) and model_path.startswith(selector)
    if selector_type == "family_prefix":
        family = _norm(matrix_input.family)
        return bool(family) and family.startswith(selector)
    return False


def resolve_capability_matrix(
    matrix_document: dict[str, Any] | None,
    matrix_input: CapabilityMatrixInput,
) -> dict[str, Any]:
    matrix = matrix_document or {}
    mode = "shadow" if matrix.get("mode") == "shadow" else "enforced"
    global_enabled = matrix.get("global_optimizations_enabled") is True

    resolved = {key: global_enabled for key in KNOWN_CAPABILITY_KEYS}

    overrides = matrix.get("overrides", [])
    if not isinstance(overrides, list):
        overrides = []

    normalized_rows: list[dict[str, Any]] = []
    for row in overrides:
        if not isinstance(row, dict):
            continue
        selector_type = row.get("selector_type")
        if selector_type not in ("exact_model", "model_path_prefix", "family_prefix"):
            continue
        if row.get("enabled", True) is False:
            continue
        if not isinstance(row.get("id"), str):
            continue
        capabilities = row.get("capabilities")
        if not isinstance(capabilities, dict):
            continue
        normalized_rows.append(row)

    matches = [row for row in normalized_rows if _matches_selector(row, matrix_input)]
    matches.sort(
        key=lambda row: (
            _selector_rank(str(row.get("selector_type", ""))),
            int(row.get("priority", 0)),
            str(row.get("id", "")),
        )
    )

    for row in matches:
        capabilities = row.get("capabilities", {})
        for raw_key, raw_value in capabilities.items():
            if raw_key not in KNOWN_CAPABILITY_KEYS:
                continue
            if isinstance(raw_value, bool):
                resolved[raw_key] = raw_value

    return {
        "mode": mode,
        "global_optimizations_enabled": global_enabled,
        "resolved_capabilities": resolved,
        "matched_override_ids": [str(row.get("id", "")) for row in matches],
        "matched_selectors": [
            {
                "id": str(row.get("id", "")),
                "selector_type": str(row.get("selector_type", "")),
                "selector": str(row.get("selector", "")),
                "priority": int(row.get("priority", 0)),
            }
            for row in matches
        ],
    }


async def resolve_webui_capabilities(model: dict[str, Any]) -> dict[str, Any]:
    matrix = await asyncio.to_thread(get_cached_capability_matrix_payload)
    model_info = model.get("info", {}) if isinstance(model, dict) else {}
    model_meta = model_info.get("meta", {}) if isinstance(model_info, dict) else {}
    model_capabilities = model_meta.get("capabilities") or {}
    model_id = str(model.get("id") or model.get("model") or model_meta.get("id") or model_meta.get("model_id") or "")
    model_path = str(model_meta.get("model_path") or model_meta.get("path") or model_id)
    family = str(model_meta.get("family") or model_meta.get("model_family") or _infer_model_family(model_id))
    resolution = resolve_capability_matrix(
        matrix,
        CapabilityMatrixInput(model_id=model_id, model_path=model_path, family=family),
    )
    enforced = resolution.get("mode") == "enforced"
    resolved = resolution.get("resolved_capabilities", {})
    return {
        "resolution": resolution,
        "builtin_tools_enabled": bool(
            resolved.get("webui.builtin_tools_enabled", False)
            if enforced
            else model_capabilities.get("builtin_tools", True)
        ),
        "file_context_enabled": bool(
            resolved.get("webui.file_context_enabled", False)
            if enforced
            else model_capabilities.get("file_context", True)
        ),
        "model_id": model_id,
        "model_path": model_path,
        "family": family,
    }
