export interface ClientToolDefinition {
  name?: string;
  function?: { name?: string };
  [key: string]: unknown;
}

export interface ClientToolCapabilities {
  clientKind: string;
  toolNames: string[];
  isOpenCode: boolean;
  planModeRequested: boolean;
  hasTodoTool: boolean;
  todoToolName: string | null;
  hasQuestionTool: boolean;
  questionToolName: string | null;
  hasApplyPatchTool: boolean;
  applyPatchToolName: string | null;
  hasLspTool: boolean;
  hasSkillTool: boolean;
  hasWebFetchTool: boolean;
  hasWebSearchTool: boolean;
}

const TODO_TOOLS = new Set(["todowrite", "todo_write", "taskupdate", "task_update", "taskcreate", "task_create"]);
const QUESTION_TOOLS = new Set(["question", "askquestion", "ask_question", "askfollowupquestion", "ask_followup_question", "askuserquestion", "ask_user_question"]);
const APPLY_PATCH_TOOLS = new Set(["apply_patch", "applypatch", "patch"]);
const LSP_TOOLS = new Set(["lsp", "language_server"]);
const SKILL_TOOLS = new Set(["skill", "load_skill"]);
const WEB_FETCH_TOOLS = new Set(["webfetch", "web_fetch", "fetch"]);
const WEB_SEARCH_TOOLS = new Set(["websearch", "web_search", "search_web"]);

export const OPENCODE_BUILTIN_TOOLS = [
  "bash",
  "edit",
  "write",
  "read",
  "grep",
  "glob",
  "lsp",
  "apply_patch",
  "skill",
  "todowrite",
  "webfetch",
  "websearch",
  "question",
] as const;

function normalizeToolName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/-/g, "_");
}

function toolDefinitionName(tool: ClientToolDefinition): string {
  return typeof tool.name === "string" && tool.name.trim()
    ? tool.name.trim()
    : typeof tool.function?.name === "string" && tool.function.name.trim()
      ? tool.function.name.trim()
      : "";
}

function firstMatchingTool(
  tools: Array<{ raw: string; normalized: string }>,
  candidates: ReadonlySet<string>,
): string | null {
  return tools.find((tool) => candidates.has(tool.normalized))?.raw ?? null;
}

export function isPlanModePrompt(prompt: string | undefined): boolean {
  return /^\s*\/plan(?:\s|$)/i.test(String(prompt ?? ""));
}

export function detectClientToolCapabilities(
  tools: ClientToolDefinition[] | undefined | null,
  clientKind: string,
  latestUserPrompt?: string,
): ClientToolCapabilities {
  const client = clientKind.trim().toLowerCase();
  const namedTools = Array.isArray(tools)
    ? tools
      .map((tool) => toolDefinitionName(tool))
      .filter((name) => name.length > 0)
      .map((raw) => ({ raw, normalized: normalizeToolName(raw) }))
    : [];
  const normalizedNames = new Set(namedTools.map((tool) => tool.normalized));
  const isOpenCode = client.includes("opencode")
    || (normalizedNames.has("todowrite") && normalizedNames.has("question") && normalizedNames.has("apply_patch"));

  const todoToolName = firstMatchingTool(namedTools, TODO_TOOLS);
  const questionToolName = firstMatchingTool(namedTools, QUESTION_TOOLS);
  const applyPatchToolName = firstMatchingTool(namedTools, APPLY_PATCH_TOOLS);

  return {
    clientKind: client || "unknown",
    toolNames: namedTools.map((tool) => tool.raw),
    isOpenCode,
    planModeRequested: isPlanModePrompt(latestUserPrompt),
    hasTodoTool: Boolean(todoToolName),
    todoToolName,
    hasQuestionTool: Boolean(questionToolName),
    questionToolName,
    hasApplyPatchTool: Boolean(applyPatchToolName),
    applyPatchToolName,
    hasLspTool: namedTools.some((tool) => LSP_TOOLS.has(tool.normalized)),
    hasSkillTool: namedTools.some((tool) => SKILL_TOOLS.has(tool.normalized)),
    hasWebFetchTool: namedTools.some((tool) => WEB_FETCH_TOOLS.has(tool.normalized)),
    hasWebSearchTool: namedTools.some((tool) => WEB_SEARCH_TOOLS.has(tool.normalized)),
  };
}

export function buildClientToolCapabilityBlock(capabilities: ClientToolCapabilities): string | null {
  if (!capabilities.isOpenCode && !capabilities.hasTodoTool && !capabilities.hasQuestionTool) {
    return null;
  }

  const lines = [
    `<synesis_client_tool_capabilities client="${capabilities.clientKind}" opencode="${capabilities.isOpenCode}">`,
  ];
  if (capabilities.isOpenCode) {
    lines.push(`opencode_builtin_tools=${OPENCODE_BUILTIN_TOOLS.join(",")}`);
  }
  if (capabilities.hasTodoTool && capabilities.todoToolName) {
    lines.push(`task_tool=${capabilities.todoToolName}`);
    lines.push("- For macro tasks, explicit plan mode, or multi-step work, prefer the task tool for a 3-7 item plan before editing. Preserve existing completed todos and update statuses instead of duplicating tasks.");
  }
  if (capabilities.hasQuestionTool && capabilities.questionToolName) {
    lines.push(`question_tool=${capabilities.questionToolName}`);
    lines.push("- If requirements are genuinely ambiguous, use the question tool with concise options. Do not ask a question when the next safe step is obvious or the user asked to proceed.");
  }
  if (capabilities.hasApplyPatchTool && capabilities.applyPatchToolName) {
    lines.push(`patch_tool=${capabilities.applyPatchToolName}`);
    lines.push("- Prefer targeted edit/apply_patch for existing files after reading them; use write only for new files or deliberate full replacement.");
  }
  if (capabilities.hasWebSearchTool || capabilities.hasWebFetchTool) {
    lines.push("- Use websearch for discovery and webfetch for retrieving a known URL.");
  }
  if (capabilities.hasLspTool) {
    lines.push("- Use lsp for definitions, references, hover, symbols, and call hierarchy when code navigation is needed.");
  }
  if (capabilities.hasSkillTool) {
    lines.push("- Use skill when the task clearly matches an available skill's domain.");
  }
  lines.push("</synesis_client_tool_capabilities>");
  return lines.join("\n");
}

function appendHint(description: string, hint: string): string {
  return description.includes(hint) ? description : `${description}${hint}`;
}

export function enrichToolDescriptionForClient(
  toolName: string,
  description: string,
  capabilities: ClientToolCapabilities,
): string {
  if (!capabilities.isOpenCode && !capabilities.hasTodoTool && !capabilities.hasQuestionTool) {
    return description;
  }

  const normalized = normalizeToolName(toolName);
  if (TODO_TOOLS.has(normalized)) {
    return appendHint(description, " [Synesis: Use for macro tasks, /plan mode, and multi-step implementation. Create 3-7 concrete todos before edits, then update statuses as work progresses.]");
  }
  if (QUESTION_TOOLS.has(normalized)) {
    return appendHint(description, " [Synesis: Use only for real ambiguity or user preference choices. Ask concise questions with clear options; otherwise continue with the next safe step.]");
  }
  if (APPLY_PATCH_TOOLS.has(normalized)) {
    return appendHint(description, " [Synesis: Best for targeted existing-file changes after reading context. Keep patches scoped and avoid parallel patch calls for the same file.]");
  }
  if (normalized === "write" || normalized === "write_file") {
    return appendHint(description, " [Synesis: Use for new files or intentional full replacement. For existing files, read first and prefer edit/apply_patch when possible.]");
  }
  if (normalized === "edit" || normalized === "str_replace") {
    return appendHint(description, " [Synesis: Use after reading the file. Prefer one focused edit per file and wait for the result before another edit to that file.]");
  }
  if (normalized === "websearch" || normalized === "web_search") {
    return appendHint(description, " [Synesis: Use for discovery/current information; use webfetch when you already have the URL.]");
  }
  if (normalized === "webfetch" || normalized === "web_fetch") {
    return appendHint(description, " [Synesis: Use to retrieve a known URL; use websearch first when you need to discover sources.]");
  }
  if (LSP_TOOLS.has(normalized)) {
    return appendHint(description, " [Synesis: Prefer for definitions, references, hover, symbols, and call hierarchy before broad grep when symbol navigation is needed.]");
  }
  return description;
}

export function enrichToolSchemasForClient(
  tools: unknown[],
  capabilities: ClientToolCapabilities,
): unknown[] {
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const t = tool as Record<string, unknown>;
    if (t.type === "function" && t.function && typeof t.function === "object") {
      const fn = t.function as Record<string, unknown>;
      const name = fn.name;
      const desc = fn.description;
      if (typeof name === "string" && typeof desc === "string") {
        const enriched = enrichToolDescriptionForClient(name, desc, capabilities);
        return enriched === desc ? tool : { ...t, function: { ...fn, description: enriched } };
      }
      return tool;
    }
    const name = t.name;
    const desc = t.description;
    if (typeof name === "string" && typeof desc === "string") {
      const enriched = enrichToolDescriptionForClient(name, desc, capabilities);
      return enriched === desc ? tool : { ...t, description: enriched };
    }
    return tool;
  });
}
