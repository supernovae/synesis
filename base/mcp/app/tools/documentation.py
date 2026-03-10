"""Documentation MCP Tool — versioned API docs for common frameworks.

Provides grounded, version-specific documentation snippets to coding agents,
eliminating the #1 coding LLM failure mode: version hallucination.

Currently supports a curated set of frameworks with version-tagged doc URLs.
Future: integrate with RAG-indexed documentation collections.
"""

from __future__ import annotations

from typing import Any

TOOL_DEFINITION = {
    "name": "synesis_docs_lookup",
    "description": (
        "Look up API documentation for a framework/library at a specific version. "
        "Returns doc URLs, key API references, and migration notes between versions."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "framework": {
                "type": "string",
                "description": "Framework or library name (e.g., fastapi, langchain, react)",
            },
            "version": {
                "type": "string",
                "description": "Target version (e.g., 1.0.0). Omit for latest.",
            },
            "topic": {
                "type": "string",
                "description": "Specific API or topic to look up (e.g., 'streaming', 'middleware')",
            },
        },
        "required": ["framework"],
    },
}

# Curated documentation registry: framework -> version -> doc info
_DOCS_REGISTRY: dict[str, dict[str, dict[str, Any]]] = {
    "fastapi": {
        "latest": {
            "version": "0.115.x",
            "docs_url": "https://fastapi.tiangolo.com",
            "api_ref": "https://fastapi.tiangolo.com/reference/",
            "changelog": "https://fastapi.tiangolo.com/release-notes/",
        },
    },
    "langchain": {
        "latest": {
            "version": "0.3.x / 1.0.x",
            "docs_url": "https://python.langchain.com/docs/",
            "api_ref": "https://python.langchain.com/api_reference/",
            "changelog": "https://github.com/langchain-ai/langchain/blob/master/CHANGELOG.md",
            "migration_notes": {
                "0.2->0.3": "ChatModel.bind_tools() replaces deprecated .with_tools()",
                "0.3->1.0": "astream_events v2, max_completion_tokens replaces max_tokens",
            },
        },
    },
    "langgraph": {
        "latest": {
            "version": "0.4.x",
            "docs_url": "https://langchain-ai.github.io/langgraph/",
            "api_ref": "https://langchain-ai.github.io/langgraph/reference/",
        },
    },
    "vllm": {
        "latest": {
            "version": "0.8.x",
            "docs_url": "https://docs.vllm.ai/en/latest/",
            "api_ref": "https://docs.vllm.ai/en/latest/api/",
            "recipes": "https://docs.vllm.ai/projects/recipes/en/latest/",
        },
    },
    "react": {
        "latest": {
            "version": "19.x",
            "docs_url": "https://react.dev",
            "api_ref": "https://react.dev/reference/react",
        },
    },
    "kubernetes": {
        "latest": {
            "version": "1.31",
            "docs_url": "https://kubernetes.io/docs/",
            "api_ref": "https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.31/",
        },
    },
    "openshift": {
        "latest": {
            "version": "4.17",
            "docs_url": "https://docs.redhat.com/en/documentation/openshift_container_platform/4.17",
            "api_ref": "https://docs.redhat.com/en/documentation/openshift_container_platform/4.17/html/api_reference",
        },
    },
}


async def handle(args: dict[str, Any]) -> dict[str, Any]:
    """Look up framework documentation."""
    framework = args.get("framework", "").lower().strip()
    version = args.get("version", "latest")
    topic = args.get("topic", "")

    if framework not in _DOCS_REGISTRY:
        available = sorted(_DOCS_REGISTRY.keys())
        return {
            "found": False,
            "framework": framework,
            "error": f"Framework '{framework}' not in documentation registry",
            "available_frameworks": available,
            "suggestion": "Use synesis_search to find documentation in the RAG catalog",
        }

    versions = _DOCS_REGISTRY[framework]
    doc_info = versions.get(version) or versions.get("latest", {})

    result: dict[str, Any] = {
        "found": True,
        "framework": framework,
        "version": doc_info.get("version", version),
        "docs_url": doc_info.get("docs_url", ""),
        "api_reference": doc_info.get("api_ref", ""),
    }

    if "changelog" in doc_info:
        result["changelog"] = doc_info["changelog"]
    if "recipes" in doc_info:
        result["recipes"] = doc_info["recipes"]
    if "migration_notes" in doc_info:
        result["migration_notes"] = doc_info["migration_notes"]

    if topic:
        result["topic_hint"] = (
            f"Search the docs at {doc_info.get('docs_url', '')} for '{topic}'. "
            f"For API specifics, check {doc_info.get('api_ref', '')}."
        )

    return result
