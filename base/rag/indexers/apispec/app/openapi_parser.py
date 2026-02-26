"""OpenAPI/Swagger spec parser for RAG ingestion.

Parses OpenAPI 3.x and Swagger 2.0 specs into endpoint-level chunks.
Each endpoint becomes one chunk containing the path, method, description,
parameters, request body, and response schema in natural language.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

import yaml

logger = logging.getLogger("synesis.indexer.apispec")

MAX_SCHEMA_DEPTH = 3


@dataclass
class EndpointChunk:
    text: str
    source: str
    endpoint: str


def parse_spec(spec_content: str, spec_name: str) -> list[EndpointChunk]:
    """Parse an OpenAPI/Swagger spec into endpoint chunks."""
    try:
        if spec_content.lstrip().startswith("{"):
            spec = json.loads(spec_content)
        else:
            spec = yaml.safe_load(spec_content)
    except Exception as e:
        logger.warning(f"Failed to parse spec {spec_name}: {e}")
        return []

    if not isinstance(spec, dict):
        return []

    version = spec.get("openapi", spec.get("swagger", ""))
    paths = spec.get("paths", {})
    components = spec.get("components", spec.get("definitions", {}))
    schemas = components.get("schemas", components) if isinstance(components, dict) else {}

    chunks: list[EndpointChunk] = []

    for path, path_item in paths.items():
        if not isinstance(path_item, dict):
            continue

        for method in ("get", "post", "put", "patch", "delete", "head", "options"):
            operation = path_item.get(method)
            if not operation or not isinstance(operation, dict):
                continue

            text = _format_endpoint(path, method, operation, schemas, spec_name)
            endpoint_id = f"{method.upper()} {path}"

            chunks.append(EndpointChunk(
                text=text[:8000],
                source=f"spec:{spec_name} endpoint:{endpoint_id}",
                endpoint=endpoint_id,
            ))

    logger.info(f"Parsed {len(chunks)} endpoints from {spec_name} (version: {version})")
    return chunks


def _format_endpoint(
    path: str,
    method: str,
    operation: dict[str, Any],
    schemas: dict[str, Any],
    spec_name: str,
) -> str:
    """Format a single endpoint as a human-readable chunk."""
    lines: list[str] = []

    lines.append(f"{method.upper()} {path}")

    summary = operation.get("summary", "")
    description = operation.get("description", "")
    if summary:
        lines.append(f"Summary: {summary}")
    if description and description != summary:
        lines.append(f"Description: {description[:500]}")

    tags = operation.get("tags", [])
    if tags:
        lines.append(f"Tags: {', '.join(tags)}")

    params = operation.get("parameters", [])
    if params:
        lines.append("Parameters:")
        for param in params[:15]:
            if not isinstance(param, dict):
                continue
            name = param.get("name", "?")
            location = param.get("in", "?")
            required = "required" if param.get("required") else "optional"
            param_desc = param.get("description", "")[:100]
            schema_type = _get_schema_type(param.get("schema", {}), schemas, depth=0)
            lines.append(f"  - {name} ({location}, {required}, {schema_type}): {param_desc}")

    request_body = operation.get("requestBody", {})
    if isinstance(request_body, dict):
        content = request_body.get("content", {})
        for media_type, media_obj in content.items():
            if not isinstance(media_obj, dict):
                continue
            schema = media_obj.get("schema", {})
            schema_summary = _summarize_schema(schema, schemas, depth=0)
            lines.append(f"Request Body ({media_type}): {schema_summary}")
            break

    responses = operation.get("responses", {})
    if isinstance(responses, dict):
        for status, resp in sorted(responses.items()):
            if not isinstance(resp, dict):
                continue
            resp_desc = resp.get("description", "")[:200]
            content = resp.get("content", {})
            schema_info = ""
            for media_type, media_obj in content.items():
                if isinstance(media_obj, dict) and "schema" in media_obj:
                    schema_info = _get_schema_type(media_obj["schema"], schemas, depth=0)
                    break
            line = f"Response {status}: {resp_desc}"
            if schema_info:
                line += f" [{schema_info}]"
            lines.append(line)

    return "\n".join(lines)


def _resolve_ref(ref: str, schemas: dict[str, Any]) -> dict[str, Any]:
    """Resolve a $ref to its schema definition."""
    if not ref.startswith("#/"):
        return {}
    parts = ref.lstrip("#/").split("/")
    name = parts[-1] if parts else ""
    return schemas.get(name, {})


def _get_schema_type(schema: dict[str, Any], schemas: dict, depth: int) -> str:
    if not isinstance(schema, dict):
        return "any"

    if "$ref" in schema:
        ref = schema["$ref"]
        name = ref.split("/")[-1]
        return name

    schema_type = schema.get("type", "")
    if schema_type == "array":
        items = schema.get("items", {})
        item_type = _get_schema_type(items, schemas, depth + 1)
        return f"array[{item_type}]"
    if schema_type == "object" and depth < MAX_SCHEMA_DEPTH:
        props = schema.get("properties", {})
        if props:
            keys = list(props.keys())[:5]
            return "object{" + ", ".join(keys) + ("..." if len(props) > 5 else "") + "}"
        return "object"

    return schema_type or "any"


def _summarize_schema(schema: dict[str, Any], schemas: dict, depth: int) -> str:
    """Generate a human-readable schema summary."""
    if not isinstance(schema, dict):
        return "any"

    if "$ref" in schema:
        name = schema["$ref"].split("/")[-1]
        if depth < MAX_SCHEMA_DEPTH:
            resolved = _resolve_ref(schema["$ref"], schemas)
            if resolved:
                return f"{name} {_summarize_schema(resolved, schemas, depth + 1)}"
        return name

    schema_type = schema.get("type", "object")
    if schema_type == "object":
        props = schema.get("properties", {})
        required = set(schema.get("required", []))
        parts: list[str] = []
        for pname, pschema in list(props.items())[:10]:
            ptype = _get_schema_type(pschema, schemas, depth + 1) if isinstance(pschema, dict) else "any"
            req = "*" if pname in required else ""
            parts.append(f"{pname}{req}: {ptype}")
        extra = f" +{len(props) - 10} more" if len(props) > 10 else ""
        return "{ " + ", ".join(parts) + extra + " }"

    if schema_type == "array":
        items = schema.get("items", {})
        return f"array[{_get_schema_type(items, schemas, depth + 1)}]"

    return schema_type
