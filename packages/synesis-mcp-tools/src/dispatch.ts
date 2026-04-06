import type { SynesisMcpAuth } from "./auth-types.js";
import type { SynesisMcpDeps } from "./deps.js";
import { runKnowledgeSearch } from "./knowledge.js";
import { runWebSearch } from "./web-search.js";
import { runClassify, runPlan, runCritique } from "./planner-tools.js";
import {
  runCveCheck,
  runLicenseCheck,
  runDocsLookup,
  runPatchIntegrity,
} from "./cve-license-docs-patch.js";

export const SYNESIS_MCP_TOOL_NAMES = [
  "synesis_search",
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
  /** Yarn UI name — same behavior as synesis_search */
  "synesis_knowledge_search",
  "synesis_web_search",
  /** Alias for compatibility; canonical is synesis_web_search. */
  "web_search",
] as const;

export type SynesisMcpToolName = (typeof SYNESIS_MCP_TOOL_NAMES)[number];

export async function dispatchSynesisTool(
  name: string,
  args: Record<string, unknown>,
  auth: SynesisMcpAuth,
  deps: SynesisMcpDeps,
): Promise<unknown> {
  switch (name) {
    case "synesis_search":
    case "synesis_knowledge_search":
      return runKnowledgeSearch(args, auth, deps, undefined);
    case "synesis_web_search":
      return runWebSearch(args, auth, deps, "synesis_web_search");
    case "web_search":
      return runWebSearch(args, auth, deps, "synesis_web_search");
    case "synesis_code_search":
      return runKnowledgeSearch(args, auth, deps, "code");
    case "synesis_docs_search":
      return runKnowledgeSearch(args, auth, deps, "docs");
    case "search_developer_docs":
      return runKnowledgeSearch(args, auth, deps, "docs");
    case "synesis_config_search":
      return runKnowledgeSearch(args, auth, deps, "config");
    case "synesis_classify":
      return runClassify(args, auth, deps);
    case "synesis_plan":
      return runPlan(args, auth, deps);
    case "synesis_critique":
      return runCritique(args, auth, deps);
    case "synesis_cve_check":
      return runCveCheck(args);
    case "synesis_license_check":
      return runLicenseCheck(args);
    case "synesis_docs_lookup":
      return runDocsLookup(args);
    case "synesis_patch_integrity":
      return runPatchIntegrity(args);
    default:
      return { error: "unknown_tool", message: `Unknown tool: ${name}` };
  }
}
