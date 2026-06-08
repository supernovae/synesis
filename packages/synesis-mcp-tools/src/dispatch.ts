import type { SynesisMcpAuth } from "./auth-types.js";
import type { SynesisMcpDeps } from "./deps.js";
import { runContextBundle, runKnowledgeSearch, runResolvePack } from "./knowledge.js";
import { runWebSearch } from "./web-search.js";
import { runClassify, runPlan, runCritique } from "./planner-tools.js";
import {
  runCveCheck,
  runLicenseCheck,
  runDocsLookup,
  runPatchIntegrity,
} from "./cve-license-docs-patch.js";
import { runTerraformPlanAnalyze } from "./terraform-plan.js";
import { runEcmaEnvironmentCheck, runEcmaPackageRiskAnalyze } from "./ecma-tools.js";
import {
  codeSearchInputSchema,
  configSearchInputSchema,
  contextBundleInputSchema,
  devDocsSearchInputSchema,
  docsSearchInputSchema,
  knowledgeSearchInputSchema,
  resolvePackInputSchema,
  terraformPlanAnalyzeInputSchema,
  ecmaEnvironmentCheckInputSchema,
  ecmaPackageRiskInputSchema,
} from "./knowledge-schemas.js";
import { webSearchInputSchema } from "./web-search-schemas.js";
import { classifyInputSchema, critiqueInputSchema, planInputSchema } from "./planner-tools.js";
import {
  cvePackagesSchema,
  docsLookupSchema,
  licensePackagesSchema,
  patchIntegritySchema,
} from "./cve-license-docs-patch.js";
import type { z } from "zod/v4";

export const SYNESIS_MCP_TOOL_NAMES = [
  "synesis_search",
  "synesis_resolve_pack",
  "synesis_context_bundle",
  "synesis_code_search",
  "synesis_docs_search",
  "synesis_config_search",
  "search_developer_docs",
  "synesis_classify",
  "synesis_plan",
  "synesis_critique",
  "synesis_cve_check",
  "synesis_license_check",
  "synesis_docs_lookup",
  "synesis_patch_integrity",
  "synesis_terraform_plan_analyze",
  "synesis_ecma_environment_check",
  "synesis_ecma_package_risk_analyze",
  /** Yarn UI name — same behavior as synesis_search */
  "synesis_knowledge_search",
  "synesis_web_search",
  /** Alias for compatibility; canonical is synesis_web_search. */
  "web_search",
] as const;

export type SynesisMcpToolName = (typeof SYNESIS_MCP_TOOL_NAMES)[number];

const TOOL_INPUT_SCHEMAS: Record<SynesisMcpToolName, z.ZodType> = {
  synesis_search: knowledgeSearchInputSchema,
  synesis_knowledge_search: knowledgeSearchInputSchema,
  synesis_resolve_pack: resolvePackInputSchema,
  synesis_context_bundle: contextBundleInputSchema,
  synesis_code_search: codeSearchInputSchema,
  synesis_docs_search: docsSearchInputSchema,
  search_developer_docs: devDocsSearchInputSchema,
  synesis_config_search: configSearchInputSchema,
  synesis_classify: classifyInputSchema,
  synesis_plan: planInputSchema,
  synesis_critique: critiqueInputSchema,
  synesis_cve_check: cvePackagesSchema,
  synesis_license_check: licensePackagesSchema,
  synesis_docs_lookup: docsLookupSchema,
  synesis_patch_integrity: patchIntegritySchema,
  synesis_terraform_plan_analyze: terraformPlanAnalyzeInputSchema,
  synesis_ecma_environment_check: ecmaEnvironmentCheckInputSchema,
  synesis_ecma_package_risk_analyze: ecmaPackageRiskInputSchema,
  synesis_web_search: webSearchInputSchema,
  web_search: webSearchInputSchema,
};

function validationErrorFromItems(issues: Array<{ path: string; message: string }>): Record<string, unknown> {
  return {
    error: "validation_error",
    message: "Invalid tool arguments",
    issues,
  };
}

function validationError(issues: z.core.$ZodIssue[]): Record<string, unknown> {
  return validationErrorFromItems(issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  })));
}

export function normalizeSynesisToolArgs(args: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: Record<string, unknown> } {
  if (args === undefined) return { ok: true, args: {} };
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return { ok: true, args: args as Record<string, unknown> };
  }
  return {
    ok: false,
    error: validationErrorFromItems([{ path: "", message: "Tool arguments must be an object" }]),
  };
}

export async function dispatchSynesisTool(
  name: string,
  args: unknown,
  auth: SynesisMcpAuth,
  deps: SynesisMcpDeps,
): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(TOOL_INPUT_SCHEMAS, name)) {
    return { error: "unknown_tool", message: `Unknown tool: ${name}` };
  }
  const toolName = name as SynesisMcpToolName;
  const normalizedArgs = normalizeSynesisToolArgs(args);
  if (!normalizedArgs.ok) return normalizedArgs.error;

  const parsedArgs = TOOL_INPUT_SCHEMAS[toolName].safeParse(normalizedArgs.args);
  if (!parsedArgs.success) {
    return validationError(parsedArgs.error.issues);
  }

  switch (name) {
    case "synesis_search":
    case "synesis_knowledge_search":
      return runKnowledgeSearch(parsedArgs.data as Record<string, unknown>, auth, deps, undefined);
    case "synesis_resolve_pack":
      return runResolvePack(parsedArgs.data as Record<string, unknown>, auth, deps);
    case "synesis_context_bundle":
      return runContextBundle(parsedArgs.data as Record<string, unknown>, auth, deps);
    case "synesis_web_search":
      return runWebSearch(parsedArgs.data as Record<string, unknown>, auth, deps, "synesis_web_search");
    case "web_search":
      return runWebSearch(parsedArgs.data as Record<string, unknown>, auth, deps, "synesis_web_search");
    case "synesis_code_search":
      return runKnowledgeSearch(parsedArgs.data as Record<string, unknown>, auth, deps, "code");
    case "synesis_docs_search":
      return runKnowledgeSearch(parsedArgs.data as Record<string, unknown>, auth, deps, "docs");
    case "search_developer_docs":
      return runKnowledgeSearch(parsedArgs.data as Record<string, unknown>, auth, deps, "docs");
    case "synesis_config_search":
      return runKnowledgeSearch(parsedArgs.data as Record<string, unknown>, auth, deps, "config");
    case "synesis_classify":
      return runClassify(parsedArgs.data as Record<string, unknown>, auth, deps);
    case "synesis_plan":
      return runPlan(parsedArgs.data as Record<string, unknown>, auth, deps);
    case "synesis_critique":
      return runCritique(parsedArgs.data as Record<string, unknown>, auth, deps);
    case "synesis_cve_check":
      return runCveCheck(parsedArgs.data as Record<string, unknown>);
    case "synesis_license_check":
      return runLicenseCheck(parsedArgs.data as Record<string, unknown>);
    case "synesis_docs_lookup":
      return runDocsLookup(parsedArgs.data as Record<string, unknown>);
    case "synesis_patch_integrity":
      return runPatchIntegrity(parsedArgs.data as Record<string, unknown>);
    case "synesis_terraform_plan_analyze":
      return runTerraformPlanAnalyze(parsedArgs.data as Record<string, unknown>, auth, deps);
    case "synesis_ecma_environment_check":
      return runEcmaEnvironmentCheck(parsedArgs.data as Record<string, unknown>, auth, deps);
    case "synesis_ecma_package_risk_analyze":
      return runEcmaPackageRiskAnalyze(parsedArgs.data as Record<string, unknown>, auth, deps);
    default:
      return { error: "unknown_tool", message: `Unknown tool: ${name}` };
  }
}
