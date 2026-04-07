const CORE_TOOL_NAMES = new Set([
  "Read",
  "Write",
  "Edit",
  "Update",
  "Bash",
  "Glob",
  "Grep",
]);

/** Prefer keeping catalog search tools over web when the adapter tool budget forces pruning. */
const SYNESIS_KNOWLEDGE_FIRST_TOOLS = new Set(["synesis_knowledge_search", "search_developer_docs"]);
const SYNESIS_WEB_SEARCH_TOOLS = new Set(["synesis_web_search", "web_search"]);

function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

export function extractToolSchemaName(tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const t = tool as Record<string, unknown>;
  const direct = t.name;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const fn = t.function;
  if (fn && typeof fn === "object") {
    const n = (fn as Record<string, unknown>).name;
    if (typeof n === "string" && n.trim()) return n.trim();
  }
  return "";
}

function scoreTool(
  name: string,
  recentTools: Set<string>,
  requestedTools: Set<string>,
): number {
  const norm = normalizeName(name);
  let score = 0;
  if (CORE_TOOL_NAMES.has(name)) score += 100;
  if (SYNESIS_KNOWLEDGE_FIRST_TOOLS.has(norm)) score += 28;
  else if (SYNESIS_WEB_SEARCH_TOOLS.has(norm)) score += 14;
  if (recentTools.has(norm)) score += 40;
  if (requestedTools.has(norm)) score += 30;
  return score;
}

export interface ToolPruningResult {
  tools: unknown[];
  pruned: boolean;
  prunedCount: number;
}

export function pruneToolSchemas(
  tools: unknown[] | undefined,
  maxTools: number,
  recentToolNames: string[],
  requestedToolNames: string[],
): ToolPruningResult {
  const list = Array.isArray(tools) ? tools : [];
  if (maxTools <= 0 || list.length <= maxTools) {
    return { tools: list, pruned: false, prunedCount: 0 };
  }

  const recent = new Set(recentToolNames.map(normalizeName));
  const requested = new Set(requestedToolNames.map(normalizeName));

  const ranked = list.map((tool, index) => {
    const name = extractToolSchemaName(tool);
    return {
      index,
      score: scoreTool(name, recent, requested),
    };
  });
  ranked.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  const keepIndexes = new Set(ranked.slice(0, maxTools).map((r) => r.index));
  const out = list.filter((_, idx) => keepIndexes.has(idx));
  return {
    tools: out,
    pruned: out.length < list.length,
    prunedCount: Math.max(0, list.length - out.length),
  };
}
