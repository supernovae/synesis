import type { SynesisMcpAuth } from "./auth-types.js";
import type { SynesisMcpDeps } from "./deps.js";
import { dispatchSynesisTool } from "./dispatch.js";
import {
  knowledgeSearchInputSchema,
  resolvePackInputSchema,
  contextBundleInputSchema,
  codeSearchInputSchema,
  docsSearchInputSchema,
  configSearchInputSchema,
  terraformPlanAnalyzeInputSchema,
  ecmaEnvironmentCheckInputSchema,
  ecmaPackageRiskInputSchema,
} from "./knowledge-schemas.js";
import { webSearchInputSchema } from "./web-search-schemas.js";
import { classifyInputSchema, planInputSchema, critiqueInputSchema } from "./planner-tools.js";
import { patchIntegritySchema } from "./cve-license-docs-patch.js";
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

export interface RegisterSynesisMcpToolsOptions {
  /** Register niche/advanced tools in addition to the core set (default: false). */
  allTools?: boolean;
}

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
 * Register Synesis platform tools on an MCP server instance.
 *
 * Core tools (always registered): synesis_search, synesis_resolve_pack,
 * synesis_context_bundle, synesis_code_search, synesis_docs_search,
 * synesis_web_search, synesis_patch_integrity.
 *
 * Extended tools (registered when `options.allTools` is true): synesis_classify,
 * synesis_plan, synesis_critique, synesis_config_search,
 * synesis_terraform_plan_analyze, synesis_ecma_environment_check,
 * synesis_ecma_package_risk_analyze.
 */
export function registerSynesisMcpTools(
  server: ToolRegistrationServer,
  auth: SynesisMcpAuth,
  deps: SynesisMcpDeps,
  options?: RegisterSynesisMcpToolsOptions,
): void {
  const allTools = options?.allTools === true;

  // ── Core tools (always registered) ──

  registerTool(
    server,
    "synesis_search",
    {
      description:
        "Graph-native RAG retrieval against the Synesis content graph. Supports pack, symbol, temporal, and graph-expansion filters with your PAT scope.",
      inputSchema: knowledgeSearchInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_resolve_pack",
    {
      description:
        "Resolve an installed SynPack v2 from a library, language, package, symbol, topic, or version request. Returns pack ids, source versions, quality/trust/freshness, and node/example/card counts.",
      inputSchema: resolvePackInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_context_bundle",
    {
      description:
        "Retrieve an answer-ready SynPack v2 context bundle for a topic/symbol/task/version. Returns context cards, examples, anti-patterns, related symbols, source evidence, freshness warnings, and quality signals.",
      inputSchema: contextBundleInputSchema,
    },
    auth,
    deps,
  );

  registerTool(
    server,
    "synesis_web_search",
    {
      description:
        "Web search with standard attribution fields. Use when evidence is likely outside the indexed Synesis corpora.",
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
    "synesis_patch_integrity",
    {
      description:
        "Deterministic safety checks on code/patches (secrets, egress, path traversal, dangerous commands).",
      inputSchema: patchIntegritySchema,
    },
    auth,
    deps,
  );

  // ── Extended tools (allTools only) ──

  if (allTools) {
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
          "Read-only JS/TS environment analyzer. Pass package.json, tsconfig/jsconfig, deno.json, bunfig.toml, and lockfile names to detect runtime, module system, TypeScript strictness, and recommended EcmaPack filters.",
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
          "Read-only package.json risk analyzer for JS/TS. Flags lifecycle scripts and legacy/heavy dependency additions so the harness can request approval before package changes.",
        inputSchema: ecmaPackageRiskInputSchema,
      },
      auth,
      deps,
    );
  }
}
