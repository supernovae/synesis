import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SynesisMcpAuth } from "./auth-types.js";
import type { SynesisMcpDeps } from "./deps.js";
import { dispatchSynesisTool } from "./dispatch.js";
import {
  knowledgeSearchInputSchema,
  codeSearchInputSchema,
  docsSearchInputSchema,
  configSearchInputSchema,
  devDocsSearchInputSchema,
  terraformPlanAnalyzeInputSchema,
  ecmaEnvironmentCheckInputSchema,
  ecmaPackageRiskInputSchema,
} from "./knowledge-schemas.js";
import { webSearchInputSchema } from "./web-search-schemas.js";
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
        "Graph-native RAG retrieval against the Synesis content graph. Supports pack, symbol, temporal, and graph-expansion filters via planner /v1/knowledge/search with your PAT scope.",
      inputSchema: knowledgeSearchInputSchema,
    },
    async (args) =>
      jsonResult(await dispatchSynesisTool("synesis_search", args as Record<string, unknown>, auth, deps)),
  );

  server.registerTool(
    "synesis_web_search",
    {
      description:
        "Web search via planner /v1/web/search (SearXNG-backed) with standard attribution fields.",
      inputSchema: webSearchInputSchema,
    },
    async (args) =>
      jsonResult(
        await dispatchSynesisTool("synesis_web_search", args as Record<string, unknown>, auth, deps),
      ),
  );

  server.registerTool(
    "web_search",
    {
      description: "Alias for synesis_web_search.",
      inputSchema: webSearchInputSchema,
    },
    async (args) =>
      jsonResult(
        await dispatchSynesisTool("web_search", args as Record<string, unknown>, auth, deps),
      ),
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
    "search_developer_docs",
    {
      description:
        "RAG over official developer documentation for programming languages and frameworks (e.g., Python, React, Go). Use this to look up API references and best practices before falling back to web search.",
      inputSchema: devDocsSearchInputSchema,
    },
    async (args) =>
      jsonResult(
        await dispatchSynesisTool("search_developer_docs", args as Record<string, unknown>, auth, deps),
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

  server.registerTool(
    "synesis_terraform_plan_analyze",
    {
      description:
        "Analyze Terraform plan JSON for destructive, replacement, update, and additive resource changes. Read-only: does not run terraform, import, apply, or destroy. Returns hard-gate approval context when risk is high.",
      inputSchema: terraformPlanAnalyzeInputSchema,
    },
    async (args) =>
      jsonResult(
        await dispatchSynesisTool("synesis_terraform_plan_analyze", args as Record<string, unknown>, auth, deps),
      ),
  );

  server.registerTool(
    "synesis_ecma_environment_check",
    {
      description:
        "Read-only JS/TS environment analyzer. Pass package.json, tsconfig/jsconfig, deno.json, bunfig.toml, and lockfile names to detect runtime, module system, TypeScript strictness, and recommended EcmaPack filters. It does not install packages or mutate files.",
      inputSchema: ecmaEnvironmentCheckInputSchema,
    },
    async (args) =>
      jsonResult(
        await dispatchSynesisTool("synesis_ecma_environment_check", args as Record<string, unknown>, auth, deps),
      ),
  );

  server.registerTool(
    "synesis_ecma_package_risk_analyze",
    {
      description:
        "Read-only package.json risk analyzer for JS/TS. Flags lifecycle scripts and legacy/heavy dependency additions so the harness can request approval before package changes. It does not run npm, bun, yarn, pnpm, or deno.",
      inputSchema: ecmaPackageRiskInputSchema,
    },
    async (args) =>
      jsonResult(
        await dispatchSynesisTool("synesis_ecma_package_risk_analyze", args as Record<string, unknown>, auth, deps),
      ),
  );
}
