"""Handler: OpenAPI/Swagger specification files.

Fetches spec files from URLs, parses endpoints, and produces one
chunk per endpoint with method, path, parameters, and schema info.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx
import yaml

from . import register
from .base import Chunk, RawDocument

logger = logging.getLogger("synesis.indexer.handler.openapi_spec")

MAX_SCHEMA_DEPTH = 3


@register
class OpenAPISpecHandler:
    handler_type = "openapi_spec"
    source_type = "openapi"

    def fetch(self, source_config: dict[str, Any]) -> list[RawDocument]:
        config = source_config.get("config", {})
        url = config.get("url", "")
        name = source_config.get("name", url)

        if not url:
            logger.error("openapi_spec handler requires config.url")
            return []

        try:
            with httpx.Client(timeout=30, follow_redirects=True) as client:
                resp = client.get(url)
                resp.raise_for_status()
                content = resp.text
        except Exception as e:
            logger.error("Failed to fetch spec %s: %s", url, e)
            return []

        return [
            RawDocument(
                doc_id=f"openapi:{name}",
                name=name,
                content=content,
                source_url=url,
                metadata={"spec_name": name},
            )
        ]

    def parse_and_chunk(self, doc: RawDocument) -> list[Chunk]:
        content = doc.content if isinstance(doc.content, str) else doc.content.decode("utf-8", errors="replace")
        spec_name = doc.metadata.get("spec_name", doc.name)

        try:
            if content.lstrip().startswith("{"):
                spec = json.loads(content)
            else:
                spec = yaml.safe_load(content)
        except Exception as e:
            logger.warning("Failed to parse spec %s: %s", spec_name, e)
            return []

        if not isinstance(spec, dict):
            return []

        paths = spec.get("paths", {})
        components = spec.get("components", spec.get("definitions", {}))
        schemas = components.get("schemas", components) if isinstance(components, dict) else {}

        chunks: list[Chunk] = []
        idx = 0

        for path, path_item in paths.items():
            if not isinstance(path_item, dict):
                continue

            for method in ("get", "post", "put", "patch", "delete", "head", "options"):
                operation = path_item.get(method)
                if not operation or not isinstance(operation, dict):
                    continue

                text = _format_endpoint(path, method, operation, schemas, spec_name)
                endpoint_id = f"{method.upper()} {path}"
                op_tags = operation.get("tags", [])

                chunks.append(
                    Chunk(
                        text=text[:8000],
                        section=endpoint_id,
                        heading_path=f"{spec_name} > {endpoint_id}",
                        chunk_index=idx,
                        metadata={"endpoint": endpoint_id, "tags": op_tags},
                    )
                )
                idx += 1

        logger.info("Parsed %d endpoints from %s", len(chunks), spec_name)
        return chunks


def _format_endpoint(
    path: str,
    method: str,
    operation: dict,
    schemas: dict,
    spec_name: str,
) -> str:
    lines = [f"{method.upper()} {path}"]

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
        for media_type, media_obj in request_body.get("content", {}).items():
            if isinstance(media_obj, dict) and "schema" in media_obj:
                schema_summary = _summarize_schema(media_obj["schema"], schemas, depth=0)
                lines.append(f"Request Body ({media_type}): {schema_summary}")
                break

    responses = operation.get("responses", {})
    if isinstance(responses, dict):
        for status, resp in sorted(responses.items()):
            if not isinstance(resp, dict):
                continue
            resp_desc = resp.get("description", "")[:200]
            schema_info = ""
            for media_type, media_obj in resp.get("content", {}).items():
                if isinstance(media_obj, dict) and "schema" in media_obj:
                    schema_info = _get_schema_type(media_obj["schema"], schemas, depth=0)
                    break
            line = f"Response {status}: {resp_desc}"
            if schema_info:
                line += f" [{schema_info}]"
            lines.append(line)

    return "\n".join(lines)


def _resolve_ref(ref: str, schemas: dict) -> dict:
    if not ref.startswith("#/"):
        return {}
    name = ref.lstrip("#/").split("/")[-1]
    return schemas.get(name, {})


def _get_schema_type(schema: dict, schemas: dict, depth: int) -> str:
    if not isinstance(schema, dict):
        return "any"
    if "$ref" in schema:
        return schema["$ref"].split("/")[-1]
    schema_type = schema.get("type", "")
    if schema_type == "array":
        item_type = _get_schema_type(schema.get("items", {}), schemas, depth + 1)
        return f"array[{item_type}]"
    if schema_type == "object" and depth < MAX_SCHEMA_DEPTH:
        props = schema.get("properties", {})
        if props:
            keys = list(props.keys())[:5]
            return "object{" + ", ".join(keys) + ("..." if len(props) > 5 else "") + "}"
        return "object"
    return schema_type or "any"


def _summarize_schema(schema: dict, schemas: dict, depth: int) -> str:
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
        parts = []
        for pname, pschema in list(props.items())[:10]:
            ptype = _get_schema_type(pschema, schemas, depth + 1) if isinstance(pschema, dict) else "any"
            req = "*" if pname in required else ""
            parts.append(f"{pname}{req}: {ptype}")
        extra = f" +{len(props) - 10} more" if len(props) > 10 else ""
        return "{ " + ", ".join(parts) + extra + " }"
    if schema_type == "array":
        return f"array[{_get_schema_type(schema.get('items', {}), schemas, depth + 1)}]"
    return schema_type
