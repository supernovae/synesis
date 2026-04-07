/**
 * Optional system prompt fragment when Synesis retrieval tools are present.
 * Encourages knowledge-first lookup without requiring RAG on every turn.
 */

import { extractToolSchemaName } from "./compat/tool-schema-pruning.js";

const SYNESIS_KNOWLEDGE_TOOLS = new Set(["synesis_knowledge_search", "search_developer_docs"]);
const SYNESIS_WEB_TOOLS = new Set(["synesis_web_search", "web_search"]);

function toolListIncludesSynesisRetrieval(tools: unknown[]): boolean {
  for (const t of tools) {
    const n = extractToolSchemaName(t);
    if (!n) continue;
    const norm = n.trim().toLowerCase();
    if (SYNESIS_KNOWLEDGE_TOOLS.has(norm) || SYNESIS_WEB_TOOLS.has(norm)) return true;
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

/**
 * Returns a short policy block if the effective tool list includes Synesis retrieval tools.
 */
export function buildRetrievalPolicyToolPromptFragment(tools: unknown[] | undefined): string | undefined {
  const list = Array.isArray(tools) ? tools : [];
  if (!toolListIncludesSynesisRetrieval(list)) return undefined;
  return POLICY_LINES.join("\n");
}

/**
 * Merge adapter-specific tool guidance with Synesis retrieval policy.
 */
export function mergeToolSystemPrompts(
  adapterPrompt: string | undefined,
  retrievalFragment: string | undefined,
): string | undefined {
  const parts = [adapterPrompt?.trim(), retrievalFragment?.trim()].filter(
    (s): s is string => Boolean(s && s.length > 0),
  );
  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}
