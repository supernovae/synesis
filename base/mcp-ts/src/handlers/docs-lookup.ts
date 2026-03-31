import type { McpToolDefinition } from "../tool-registry.js";

/** Curated registry — mirrors `base/mcp/app/tools/documentation.py` */
const DOCS_REGISTRY: Record<string, Record<string, Record<string, unknown>>> = {
  fastapi: {
    latest: {
      version: "0.115.x",
      docs_url: "https://fastapi.tiangolo.com",
      api_ref: "https://fastapi.tiangolo.com/reference/",
      changelog: "https://fastapi.tiangolo.com/release-notes/",
    },
  },
  langchain: {
    latest: {
      version: "0.3.x / 1.0.x",
      docs_url: "https://python.langchain.com/docs/",
      api_ref: "https://python.langchain.com/api_reference/",
      changelog: "https://github.com/langchain-ai/langchain/blob/master/CHANGELOG.md",
      migration_notes: {
        "0.2->0.3": "ChatModel.bind_tools() replaces deprecated .with_tools()",
        "0.3->1.0": "astream_events v2, max_completion_tokens replaces max_tokens",
      },
    },
  },
  langgraph: {
    latest: {
      version: "0.4.x",
      docs_url: "https://langchain-ai.github.io/langgraph/",
      api_ref: "https://langchain-ai.github.io/langgraph/reference/",
    },
  },
  vllm: {
    latest: {
      version: "0.8.x",
      docs_url: "https://docs.vllm.ai/en/latest/",
      api_ref: "https://docs.vllm.ai/en/latest/api/",
      recipes: "https://docs.vllm.ai/projects/recipes/en/latest/",
    },
  },
  react: {
    latest: {
      version: "19.x",
      docs_url: "https://react.dev",
      api_ref: "https://react.dev/reference/react",
    },
  },
  kubernetes: {
    latest: {
      version: "1.31",
      docs_url: "https://kubernetes.io/docs/",
      api_ref: "https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.31/",
    },
  },
  openshift: {
    latest: {
      version: "4.17",
      docs_url: "https://docs.redhat.com/en/documentation/openshift_container_platform/4.17",
      api_ref:
        "https://docs.redhat.com/en/documentation/openshift_container_platform/4.17/html/api_reference",
    },
  },
};

export function createDocsLookupTool(): McpToolDefinition {
  return {
    name: "synesis_docs_lookup",
    description:
      "Look up versioned documentation for curated frameworks (fastapi, langchain, langgraph, vllm, react, kubernetes, openshift): doc URLs, API references, changelogs, and migration notes.",
    inputSchema: {
      type: "object",
      properties: {
        framework: {
          type: "string",
          description: "Framework or library name (e.g., fastapi, langchain, react)",
        },
        version: {
          type: "string",
          description: "Target version (e.g., 1.0.0). Omit for latest.",
        },
        topic: {
          type: "string",
          description: "Specific API or topic (e.g., streaming, middleware)",
        },
      },
      required: ["framework"],
    },
    handler: async (args) => {
      try {
        const framework = String(args.framework ?? "")
          .toLowerCase()
          .trim();
        const version =
          args.version === undefined || args.version === null
            ? "latest"
            : String(args.version);
        const topic =
          args.topic === undefined || args.topic === null ? "" : String(args.topic);

        if (!framework) {
          return { error: "validation_error", message: "framework is required" };
        }

        if (!DOCS_REGISTRY[framework]) {
          const available = Object.keys(DOCS_REGISTRY).sort();
          return {
            found: false,
            framework,
            error: `Framework '${framework}' not in documentation registry`,
            available_frameworks: available,
            suggestion: "Use synesis_search to find documentation in the RAG catalog",
          };
        }

        const versions = DOCS_REGISTRY[framework];
        const docInfo =
          (versions[version] as Record<string, unknown> | undefined) ??
          (versions.latest as Record<string, unknown> | undefined) ??
          {};

        const result: Record<string, unknown> = {
          found: true,
          framework,
          version: docInfo.version ?? version,
          docs_url: docInfo.docs_url ?? "",
          api_reference: docInfo.api_ref ?? "",
        };

        if (docInfo.changelog !== undefined) result.changelog = docInfo.changelog;
        if (docInfo.recipes !== undefined) result.recipes = docInfo.recipes;
        if (docInfo.migration_notes !== undefined) {
          result.migration_notes = docInfo.migration_notes;
        }

        if (topic.trim()) {
          const docsUrl = String(docInfo.docs_url ?? "");
          const apiRef = String(docInfo.api_ref ?? "");
          result.topic_hint =
            `Search the docs at ${docsUrl} for '${topic}'. ` +
            `For API specifics, check ${apiRef}.`;
        }

        return result;
      } catch (e) {
        return {
          error: "docs_lookup_failed",
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}
