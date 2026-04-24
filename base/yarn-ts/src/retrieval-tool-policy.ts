/**
 * Optional system prompt fragment when Synesis retrieval tools are present.
 * Encourages knowledge-first lookup without requiring RAG on every turn.
 */

import { extractToolSchemaName } from "./compat/tool-schema-pruning.js";

const SYNESIS_KNOWLEDGE_TOOLS = new Set(["synesis_knowledge_search", "search_developer_docs"]);
const SYNESIS_WEB_TOOLS = new Set(["synesis_web_search", "web_search"]);
const SHELL_EXECUTION_TOOLS = new Set([
  "bash",
  "execute_command",
  "run_terminal_cmd",
  "run_shell",
  "shell",
]);

function toolListIncludesSynesisRetrieval(tools: unknown[]): boolean {
  for (const t of tools) {
    const n = extractToolSchemaName(t);
    if (!n) continue;
    const norm = n.trim().toLowerCase();
    if (SYNESIS_KNOWLEDGE_TOOLS.has(norm) || SYNESIS_WEB_TOOLS.has(norm)) return true;
  }
  return false;
}

function toolListIncludesShellExecution(tools: unknown[]): boolean {
  for (const t of tools) {
    const n = extractToolSchemaName(t);
    if (!n) continue;
    const norm = n.trim().toLowerCase();
    if (SHELL_EXECUTION_TOOLS.has(norm)) return true;
  }
  return false;
}

const POLICY_LINES = [
  "## Synesis retrieval (optional — only when you need external facts)",
  "Do not run knowledge or web search on every turn; use them when you lack specifics.",
  "1) Prefer **synesis_knowledge_search** or **search_developer_docs** for API/CLI/framework reference, flags, and patterns (distilled chunks, smaller than full pages).",
  "2) Use **synesis_web_search** for freshness or when the catalog returns nothing useful. Start with default snippet results.",
  "3) Set **fetch_pages** only if snippets are insufficient — full pages are token-heavy.",
];

const STDOUT_EFFICIENCY_LINES = [
  "## Shell output efficiency (token + retry saver)",
  "For commands that can emit long output (tests/build/lint/install/logs), capture once and inspect from file.",
  "Preferred pattern: `<command> > /tmp/_synesis_cmd_out.txt 2>&1; echo \"EXIT:$?\"; tail -120 /tmp/_synesis_cmd_out.txt`",
  "Do NOT re-run the same command just to swap `| cat`, `| tee`, `| head`, or `| tail` variants.",
  "If details are still missing, inspect the same output file with targeted reads (`tail`, `rg -n`, `sed -n`) instead of re-executing the command.",
];

/**
 * Returns a short policy block if the effective tool list includes Synesis retrieval tools.
 */
export function buildRetrievalPolicyToolPromptFragment(tools: unknown[] | undefined): string | undefined {
  const list = Array.isArray(tools) ? tools : [];
  if (!toolListIncludesSynesisRetrieval(list)) return undefined;
  return POLICY_LINES.join("\n");
}

/**
 * Returns a short policy block if shell execution tools are present.
 * This reduces churn from stdout truncation and output-recovery retries.
 */
export function buildStdoutEfficiencyToolPromptFragment(tools: unknown[] | undefined): string | undefined {
  const list = Array.isArray(tools) ? tools : [];
  if (!toolListIncludesShellExecution(list)) return undefined;
  return STDOUT_EFFICIENCY_LINES.join("\n");
}

/**
 * Merge adapter-specific tool guidance with Synesis retrieval policy.
 */
export function mergeToolSystemPrompts(
  ...fragments: Array<string | undefined>
): string | undefined {
  const parts = fragments.map((f) => f?.trim()).filter(
    (s): s is string => Boolean(s && s.length > 0),
  );
  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}
