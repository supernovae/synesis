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
import type { z } from "zod/v4";

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

type ToolResult = ReturnType<typeof jsonResult>;
type ToolConfig = {
  description: string;
  inputSchema: z.ZodType;
};
type ToolRegistrationServer = {
  registerTool(
    name: string,
    config: ToolConfig,
    callback: (args: unknown) => ToolResult | Promise<ToolResult>,
  ): void;
};

function argsRecord(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

function registerTool(
  server: ToolRegistrationServer,
  name: string,
  config: ToolConfig,
  auth: SynesisMcpAuth,
  deps: SynesisMcpDeps,
): void {
  server.registerTool(name, config, async (args) => {
    const parsed = config.inputSchema.safeParse(argsRecord(args));
    if (!parsed.success) {
      return jsonResult({
        error: "validation_error",
        message: "Invalid tool arguments",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    return jsonResult(await dispatchSynesisTool(name, argsRecord(parsed.data), auth, deps));
  });
}

/**
 * Register all Synesis platform tools on an MCP server instance.
 * Call once per `McpServer` (typically one server per HTTP request / stdio session).
 */
export function registerSynesisMcpTools(
  server: ToolRegistrationServer,
  auth: SynesisMcpAuth,
  deps: SynesisMcpDeps,
): void {
  registerTool(
    server,
    "synesis_search",
    {
      description:
        "Graph-native RAG retrieval against the Synesis content graph. Supports pack, symbol, temporal, and graph-expansion filters via planner /v1/knowledge/search with your PAT scope.",
      inputSchema: knowledgeSearchInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_web_search",
    {
      description:
        "Web search via planner /v1/web/search (SearXNG-backed) with standard attribution fields.",
      inputSchema: webSearchInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "web_search",
    {
      description: "Alias for synesis_web_search.",
      inputSchema: webSearchInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_code_search",
    {
      description: "Search the Synesis code corpus (artifact_kind=code).",
      inputSchema: codeSearchInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_docs_search",
    {
      description: "Search the Synesis documentation corpus (artifact_kind=docs).",
      inputSchema: docsSearchInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_config_search",
    {
      description:
        "Search the Synesis configuration corpus (artifact_kind=config): YAML, JSON, HCL, Kubernetes, etc.",
      inputSchema: configSearchInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "search_developer_docs",
    {
      description:
        "RAG over official developer documentation for programming languages and frameworks (e.g., Python, React, Go). Use this to look up API references and best practices before falling back to web search.",
      inputSchema: devDocsSearchInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_classify",
    {
      description:
        "Classify a task description via planner entry classifier (intent, difficulty, taxonomy).",
      inputSchema: classifyInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_plan",
    {
      description: "Generate an execution plan via planner chat completions.",
      inputSchema: planInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_critique",
    {
      description: "Submit code for critic model review.",
      inputSchema: critiqueInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_cve_check",
    {
      description: "Check packages for CVEs via OSV.dev API.",
      inputSchema: cvePackagesSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_license_check",
    {
      description: "Check SPDX license compatibility against a target license.",
      inputSchema: licensePackagesSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_docs_lookup",
    {
      description: "Curated documentation URLs for known frameworks (fastapi, langchain, vllm, …).",
      inputSchema: docsLookupSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_patch_integrity",
    {
      description:
        "Deterministic safety checks on code/patches (secrets, egress, path traversal, dangerous commands).",
      inputSchema: patchIntegritySchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_terraform_plan_analyze",
    {
      description:
        "Analyze Terraform plan JSON for destructive, replacement, update, and additive resource changes. Read-only: does not run terraform, import, apply, or destroy. Returns hard-gate approval context when risk is high.",
      inputSchema: terraformPlanAnalyzeInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_ecma_environment_check",
    {
      description:
        "Read-only JS/TS environment analyzer. Pass package.json, tsconfig/jsconfig, deno.json, bunfig.toml, and lockfile names to detect runtime, module system, TypeScript strictness, and recommended EcmaPack filters. It does not install packages or mutate files.",
      inputSchema: ecmaEnvironmentCheckInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_ecma_package_risk_analyze",
    {
      description:
        "Read-only package.json risk analyzer for JS/TS. Flags lifecycle scripts and legacy/heavy dependency additions so the harness can request approval before package changes. It does not run npm, bun, yarn, pnpm, or deno.",
      inputSchema: ecmaPackageRiskInputSchema,
    },
    auth,
    deps,
  );
}
