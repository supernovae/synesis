import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SynesisMcpAuth } from "./auth-types.js";
import type { SynesisMcpDeps } from "./deps.js";
import { dispatchSynesisTool } from "./dispatch.js";
import {
  knowledgeSearchInputSchema,
  codeSearchInputSchema,
  docsSearchInputSchema,
  configSearchInputSchema,
} from "./knowledge-schemas.js";
import { classifyInputSchema, planInputSchema, critiqueInputSchema } from "./planner-tools.js";
import {
  cvePackagesSchema,
  licensePackagesSchema,
  docsLookupSchema,
  patchIntegritySchema,
} from "./cve-license-docs-patch.js";

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

/**
 * Register all Synesis platform tools on an MCP server instance.
 * Call once per `McpServer` (typically one server per HTTP request / stdio session).
 */
export function registerSynesisMcpTools(server: McpServer, auth: SynesisMcpAuth, deps: SynesisMcpDeps): void {
  server.registerTool(
    "synesis_search",
    {
      description:
        "RAG retrieval against the Synesis knowledge catalog. Returns ranked chunks with provenance and scores. Uses planner /v1/knowledge/search with your PAT scope.",
      inputSchema: knowledgeSearchInputSchema,
    },
    async (args) =>
      jsonResult(await dispatchSynesisTool("synesis_search", args as Record<string, unknown>, auth, deps)),
  );

  server.registerTool(
    "synesis_code_search",
    {
      description: "Search the Synesis code corpus (artifact_kind=code).",
      inputSchema: codeSearchInputSchema,
    },
    async (args) =>
      jsonResult(
        await dispatchSynesisTool("synesis_code_search", args as Record<string, unknown>, auth, deps),
      ),
  );

  server.registerTool(
    "synesis_docs_search",
    {
      description: "Search the Synesis documentation corpus (artifact_kind=docs).",
      inputSchema: docsSearchInputSchema,
    },
    async (args) =>
      jsonResult(
        await dispatchSynesisTool("synesis_docs_search", args as Record<string, unknown>, auth, deps),
      ),
  );

  server.registerTool(
    "synesis_config_search",
    {
      description:
        "Search the Synesis configuration corpus (artifact_kind=config): YAML, JSON, HCL, Kubernetes, etc.",
      inputSchema: configSearchInputSchema,
    },
    async (args) =>
      jsonResult(
        await dispatchSynesisTool("synesis_config_search", args as Record<string, unknown>, auth, deps),
      ),
  );

  server.registerTool(
    "synesis_classify",
    {
      description:
        "Classify a task description via planner entry classifier (intent, difficulty, taxonomy).",
      inputSchema: classifyInputSchema,
    },
    async (args) =>
      jsonResult(await dispatchSynesisTool("synesis_classify", args as Record<string, unknown>, auth, deps)),
  );

  server.registerTool(
    "synesis_plan",
    {
      description: "Generate an execution plan via planner chat completions.",
      inputSchema: planInputSchema,
    },
    async (args) =>
      jsonResult(await dispatchSynesisTool("synesis_plan", args as Record<string, unknown>, auth, deps)),
  );

  server.registerTool(
    "synesis_critique",
    {
      description: "Submit code for critic model review.",
      inputSchema: critiqueInputSchema,
    },
    async (args) =>
      jsonResult(await dispatchSynesisTool("synesis_critique", args as Record<string, unknown>, auth, deps)),
  );

  server.registerTool(
    "synesis_cve_check",
    {
      description: "Check packages for CVEs via OSV.dev API.",
      inputSchema: cvePackagesSchema,
    },
    async (args) =>
      jsonResult(await dispatchSynesisTool("synesis_cve_check", args as Record<string, unknown>, auth, deps)),
  );

  server.registerTool(
    "synesis_license_check",
    {
      description: "Check SPDX license compatibility against a target license.",
      inputSchema: licensePackagesSchema,
    },
    async (args) =>
      jsonResult(
        await dispatchSynesisTool("synesis_license_check", args as Record<string, unknown>, auth, deps),
      ),
  );

  server.registerTool(
    "synesis_docs_lookup",
    {
      description: "Curated documentation URLs for known frameworks (fastapi, langchain, vllm, …).",
      inputSchema: docsLookupSchema,
    },
    async (args) =>
      jsonResult(await dispatchSynesisTool("synesis_docs_lookup", args as Record<string, unknown>, auth, deps)),
  );

  server.registerTool(
    "synesis_patch_integrity",
    {
      description:
        "Deterministic safety checks on code/patches (secrets, egress, path traversal, dangerous commands).",
      inputSchema: patchIntegritySchema,
    },
    async (args) =>
      jsonResult(
        await dispatchSynesisTool("synesis_patch_integrity", args as Record<string, unknown>, auth, deps),
      ),
  );
}
