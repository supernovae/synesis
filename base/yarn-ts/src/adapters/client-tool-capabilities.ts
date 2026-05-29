export interface ClientToolDefinition {
  name?: string;
  function?: { name?: string };
  [key: string]: unknown;
}

export interface ClientToolCapabilities {
  clientKind: string;
  toolNames: string[];
  isOpenCode: boolean;
  isClaudeCode: boolean;
  planModeRequested: boolean;
  hasTodoTool: boolean;
  todoToolName: string | null;
  taskToolNames: string[];
  hasQuestionTool: boolean;
  questionToolName: string | null;
  hasApplyPatchTool: boolean;
  applyPatchToolName: string | null;
  hasAgentTool: boolean;
  hasMonitorTool: boolean;
  hasPlanModeTool: boolean;
  enterPlanModeToolName: string | null;
  exitPlanModeToolName: string | null;
  hasLspTool: boolean;
  hasSkillTool: boolean;
  hasWebFetchTool: boolean;
  hasWebSearchTool: boolean;
}

const TODO_TOOLS = new Set([
  "todowrite", "todo_write", "taskupdate", "task_update", "taskcreate", "task_create", "taskdelete", "task_delete",
]);
const CLAUDE_TASK_TOOLS = new Set([
  "taskcreate", "task_create", "taskupdate", "task_update", "tasklist", "task_list", "taskget", "task_get", "taskdelete", "task_delete",
]);
const QUESTION_TOOLS = new Set(["question", "askquestion", "ask_question", "askfollowupquestion", "ask_followup_question", "askuserquestion", "ask_user_question"]);
const APPLY_PATCH_TOOLS = new Set(["apply_patch", "applypatch", "patch"]);
const LSP_TOOLS = new Set(["lsp", "language_server"]);
const SKILL_TOOLS = new Set(["skill", "load_skill"]);
const WEB_FETCH_TOOLS = new Set(["webfetch", "web_fetch", "fetch"]);
const WEB_SEARCH_TOOLS = new Set(["websearch", "web_search", "search_web"]);
const AGENT_TOOLS = new Set(["agent", "task"]);
const MONITOR_TOOLS = new Set(["monitor"]);
const PLAN_ENTER_TOOLS = new Set(["enterplanmode", "enter_plan_mode"]);
const PLAN_EXIT_TOOLS = new Set(["exitplanmode", "exit_plan_mode"]);

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

export const CLAUDE_CODE_BUILTIN_TOOLS = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "ListMcpResourcesTool",
  "LSP",
  "Monitor",
  "NotebookEdit",
  "PowerShell",
  "PushNotification",
  "Read",
  "ReadMcpResourceTool",
  "RemoteTrigger",
  "ScheduleWakeup",
  "SendMessage",
  "ShareOnboardingGuide",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TeamCreate",
  "TeamDelete",
  "TodoWrite",
  "ToolSearch",
  "WaitForMcpServers",
  "WebFetch",
  "WebSearch",
  "Write",
] as const;

const OPENCODE_UNAVAILABLE_TOOL_ALIASES: Array<[alias: string, target: string]> = [
  ["write_file", "write"],
  ["file_write", "write"],
  ["create_file", "write"],
  ["read_file", "read"],
  ["str_replace", "edit"],
  ["replace_in_file", "edit"],
  ["ask_question", "question"],
  ["ask_user_question", "question"],
  ["ask_followup_question", "question"],
  ["todo_write", "todowrite"],
  ["web_fetch", "webfetch"],
  ["web_search", "websearch"],
];

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

function listMatchingTools(
  tools: Array<{ raw: string; normalized: string }>,
  candidates: ReadonlySet<string>,
): string[] {
  return tools.filter((tool) => candidates.has(tool.normalized)).map((tool) => tool.raw);
}

function preferredTaskToolName(tools: Array<{ raw: string; normalized: string }>): string | null {
  const preferences = ["taskupdate", "task_update", "taskcreate", "task_create", "todowrite", "todo_write", "taskdelete", "task_delete"];
  for (const pref of preferences) {
    const match = tools.find((tool) => tool.normalized === pref);
    if (match) return match.raw;
  }
  return firstMatchingTool(tools, TODO_TOOLS);
}

function hasAny(names: ReadonlySet<string>, candidates: string[]): boolean {
  return candidates.some((candidate) => names.has(candidate));
}

function opencodeAliasGuidance(toolNames: string[]): string | null {
  const offeredByNormalizedName = new Map<string, string>();
  for (const raw of toolNames) {
    offeredByNormalizedName.set(normalizeToolName(raw), raw);
  }
  const aliases = OPENCODE_UNAVAILABLE_TOOL_ALIASES
    .map(([alias, target]) => {
      const offered = offeredByNormalizedName.get(normalizeToolName(target));
      return offered ? `${alias}->${offered}` : null;
    })
    .filter((entry): entry is string => Boolean(entry));
  return aliases.length > 0 ? aliases.join(",") : null;
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
  const isClaudeCode = client.includes("claude-code")
    || client.includes("claude_code")
    || normalizedNames.has("enter_plan_mode")
    || normalizedNames.has("exit_plan_mode")
    || (
      hasAny(normalizedNames, ["taskcreate", "task_create"])
      && hasAny(normalizedNames, ["taskupdate", "task_update"])
      && normalizedNames.has("ask_user_question")
    );

  const taskToolNames = listMatchingTools(namedTools, CLAUDE_TASK_TOOLS);
  const todoToolName = preferredTaskToolName(namedTools);
  const questionToolName = firstMatchingTool(namedTools, QUESTION_TOOLS);
  const applyPatchToolName = firstMatchingTool(namedTools, APPLY_PATCH_TOOLS);
  const enterPlanModeToolName = firstMatchingTool(namedTools, PLAN_ENTER_TOOLS);
  const exitPlanModeToolName = firstMatchingTool(namedTools, PLAN_EXIT_TOOLS);
  const hasPlanModeTool = Boolean(enterPlanModeToolName || exitPlanModeToolName);

  return {
    clientKind: client || "unknown",
    toolNames: namedTools.map((tool) => tool.raw),
    isOpenCode,
    isClaudeCode,
    planModeRequested: isPlanModePrompt(latestUserPrompt),
    hasTodoTool: Boolean(todoToolName),
    todoToolName,
    taskToolNames,
    hasQuestionTool: Boolean(questionToolName),
    questionToolName,
    hasApplyPatchTool: Boolean(applyPatchToolName),
    applyPatchToolName,
    hasAgentTool: namedTools.some((tool) => AGENT_TOOLS.has(tool.normalized)),
    hasMonitorTool: namedTools.some((tool) => MONITOR_TOOLS.has(tool.normalized)),
    hasPlanModeTool,
    enterPlanModeToolName,
    exitPlanModeToolName,
    hasLspTool: namedTools.some((tool) => LSP_TOOLS.has(tool.normalized)),
    hasSkillTool: namedTools.some((tool) => SKILL_TOOLS.has(tool.normalized)),
    hasWebFetchTool: namedTools.some((tool) => WEB_FETCH_TOOLS.has(tool.normalized)),
    hasWebSearchTool: namedTools.some((tool) => WEB_SEARCH_TOOLS.has(tool.normalized)),
  };
}

export function buildClientToolCapabilityBlock(capabilities: ClientToolCapabilities): string | null {
  if (!capabilities.isOpenCode && !capabilities.isClaudeCode && !capabilities.hasTodoTool && !capabilities.hasQuestionTool) {
    return null;
  }

  const lines = [
    `<synesis_client_tool_capabilities client="${capabilities.clientKind}" opencode="${capabilities.isOpenCode}" claude_code="${capabilities.isClaudeCode}">`,
  ];
  if (capabilities.toolNames.length > 0) {
    lines.push(`tools=${capabilities.toolNames.join(",")}`);
  }
  if (capabilities.isOpenCode) {
    lines.push(`opencode_builtin_tools=${OPENCODE_BUILTIN_TOOLS.join(",")}`);
    lines.push("exact_tool_names_required=true");
    lines.push("- OpenCode native tool calls must use only exact names from tools=. Do not call aliases from other agent APIs.");
    const aliasGuidance = opencodeAliasGuidance(capabilities.toolNames);
    if (aliasGuidance) {
      lines.push(`unavailable_tool_aliases=${aliasGuidance}`);
    }
  }
  if (capabilities.isClaudeCode) {
    lines.push(`claude_code_builtin_tools=${CLAUDE_CODE_BUILTIN_TOOLS.join(",")}`);
    if (capabilities.taskToolNames.length > 0) {
      lines.push(`claude_code_task_tools=${capabilities.taskToolNames.join(",")}`);
    }
    if (capabilities.hasPlanModeTool) {
      lines.push(`claude_code_plan_mode_tools=${[capabilities.enterPlanModeToolName, capabilities.exitPlanModeToolName].filter(Boolean).join(",")}`);
    }
    lines.push("- Claude Code task list: prefer TaskCreate/TaskUpdate/TaskList/TaskGet over legacy TodoWrite when those tools are offered. Preserve existing tasks with TaskList/TaskGet, create only missing tasks, and update statuses instead of recreating duplicates.");
    lines.push("- Claude Code plan mode: EnterPlanMode is for planning without edits; ExitPlanMode presents the final plan for approval and may require permission. Do not start implementation until plan mode has exited or the user explicitly asked to execute.");
    lines.push("- Claude Code Bash/PowerShell: each command is a process; cd may persist only inside allowed project roots, environment exports do not persist, long-running work should use run_in_background or Monitor, and truncated output should be read from the saved output file.");
    lines.push("- Claude Code file tools: Read returns line-numbered content and supports offset/limit, images, PDFs, and notebooks. Edit/MultiEdit require prior file context and exact unique old_string matches. Write is full-file create/overwrite and should be used for new files or intentional full replacement after reading existing files.");
    lines.push("- Claude Code search/navigation: Glob finds file names, caps results, and may include ignored files; Grep uses ripgrep regex and respects .gitignore; LSP should be preferred for definitions, references, hover/type info, symbols, implementations, call hierarchy, and post-edit diagnostics when available.");
    lines.push("- Claude Code Agent/Monitor: Agent is for bounded subagent research or isolated multi-step work and returns only a final result to the parent; Monitor watches long-running logs/status and uses Bash permission patterns.");
  }
  if (capabilities.hasTodoTool && capabilities.todoToolName && capabilities.isClaudeCode) {
    lines.push(`task_tool=${capabilities.todoToolName}`);
    lines.push(`claude_code_primary_task_mutator=${capabilities.todoToolName}`);
  } else if (capabilities.hasTodoTool && capabilities.todoToolName) {
    lines.push(`task_tool=${capabilities.todoToolName}`);
    lines.push("- For macro tasks, explicit plan mode, or multi-step work, prefer the task tool for a 3-7 item plan before editing. Preserve existing completed todos and update statuses instead of duplicating tasks.");
    lines.push("- During multi-step implementation, update task status as each component finishes before starting a distant later component. Do not leave the first todo in_progress while completing many later todos.");
    if (capabilities.isOpenCode || capabilities.todoToolName.toLowerCase() === "todowrite") {
      lines.push('- OpenCode todowrite exact shape: {"todos":[{"id":"todo_1","content":"Concrete task","status":"pending","priority":"high"}]}. Each item must include id, content, status, and priority.');
      lines.push("- Never call todowrite with arrays of strings, title-only items, or status-only updates.");
    }
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
  if (!capabilities.isOpenCode && !capabilities.isClaudeCode && !capabilities.hasTodoTool && !capabilities.hasQuestionTool) {
    return description;
  }

  const normalized = normalizeToolName(toolName);
  if (capabilities.isClaudeCode) {
    if (normalized === "taskcreate" || normalized === "task_create") {
      return appendHint(description, " [Synesis: Claude Code native task list. Create only missing concrete tasks; use TaskList/TaskGet first when preserving existing task state matters.]");
    }
    if (normalized === "taskupdate" || normalized === "task_update") {
      return appendHint(description, " [Synesis: Claude Code native task list. Update status/details/dependencies or delete/obsolete tasks; do not recreate duplicate tasks.]");
    }
    if (normalized === "tasklist" || normalized === "task_list" || normalized === "taskget" || normalized === "task_get") {
      return appendHint(description, " [Synesis: Claude Code native task list. Use to inspect current task state before creating or updating tasks.]");
    }
    if (PLAN_ENTER_TOOLS.has(normalized)) {
      return appendHint(description, " [Synesis: Enter Claude Code plan mode for approach design only; do not perform implementation edits while still in plan mode.]");
    }
    if (PLAN_EXIT_TOOLS.has(normalized)) {
      return appendHint(description, " [Synesis: Present the completed plan for approval and exit plan mode before implementation.]");
    }
    if (AGENT_TOOLS.has(normalized)) {
      return appendHint(description, " [Synesis: Use Agent for bounded autonomous research or isolated multi-step work. Parent sees only the final result; subagent tool permissions still apply.]");
    }
    if (normalized === "bash" || normalized === "powershell") {
      return appendHint(description, " [Synesis: Each command runs as a process; cd persistence is limited to allowed roots and env exports do not persist. Use timeout/run_in_background for long work; read saved output files when output is truncated.]");
    }
    if (MONITOR_TOOLS.has(normalized)) {
      return appendHint(description, " [Synesis: Use Monitor for background log/status/file-change watching; Bash permission patterns apply.]");
    }
    if (normalized === "glob") {
      return appendHint(description, " [Synesis: Claude Code Glob finds file names, supports ** and brace patterns, returns newest first, caps results, and may include gitignored files unless configured otherwise. Narrow broad patterns when truncated.]");
    }
    if (normalized === "grep") {
      return appendHint(description, " [Synesis: Claude Code Grep uses ripgrep regex, respects .gitignore, defaults to files_with_matches, and supports output_mode, glob, type, and multiline. Escape regex metacharacters.]");
    }
    if (normalized === "read") {
      return appendHint(description, " [Synesis: Claude Code Read returns line-numbered file content, supports offset/limit paging, and can read images, PDFs, and notebooks. Read files before Edit/Write on existing paths.]");
    }
    if (normalized === "edit" || normalized === "multi_edit") {
      return appendHint(description, " [Synesis: Claude Code Edit is exact string replacement after prior file context; old_string must match exactly and uniquely unless replace_all is set.]");
    }
    if (normalized === "write") {
      return appendHint(description, " [Synesis: Claude Code Write creates or overwrites full files. Use for new files or deliberate full replacement; read an existing file first before overwriting.]");
    }
    if (normalized === "lsp") {
      return appendHint(description, " [Synesis: Claude Code LSP provides definitions, references, hover/type info, symbols, implementations, call hierarchy, and post-edit diagnostics when a language plugin/server is active.]");
    }
    if (normalized === "notebookedit" || normalized === "notebook_edit") {
      return appendHint(description, " [Synesis: Claude Code NotebookEdit targets notebook cells by cell_id with replace/insert/delete modes; it is not string replacement across the notebook.]");
    }
    if (normalized === "webfetch" || normalized === "web_fetch") {
      return appendHint(description, " [Synesis: Claude Code WebFetch is lossy extraction via a prompt over fetched content, caches briefly, upgrades HTTP to HTTPS, and reports redirects for follow-up fetches.]");
    }
    if (normalized === "websearch" || normalized === "web_search") {
      return appendHint(description, " [Synesis: Claude Code WebSearch returns search results, not page contents. Follow result URLs with WebFetch and do not combine allowed_domains with blocked_domains.]");
    }
  }

  if (TODO_TOOLS.has(normalized)) {
    return appendHint(description, ' [Synesis: Use for macro tasks, /plan mode, and multi-step implementation. Create 3-7 concrete todos before edits, then update statuses as each component finishes before starting distant later tasks. OpenCode todowrite requires each item to include id, content, status, and priority, e.g. {"todos":[{"id":"todo_1","content":"Concrete task","status":"pending","priority":"high"}]}.]');
  }
  if (QUESTION_TOOLS.has(normalized)) {
    return appendHint(description, " [Synesis: Use only for real ambiguity or user preference choices. Ask concise questions with clear options; otherwise continue with the next safe step.]");
  }
  if (APPLY_PATCH_TOOLS.has(normalized)) {
    return appendHint(description, " [Synesis: Best for targeted existing-file changes after reading context. Keep patches scoped and avoid parallel patch calls for the same file.]");
  }
  if (normalized === "write" || normalized === "write_file") {
    const exactName = capabilities.isOpenCode && normalized === "write"
      ? " Exact OpenCode tool name is write; do not call write_file/file_write/create_file."
      : "";
    return appendHint(description, ` [Synesis: Use for new files or intentional full replacement. For existing files, read first and prefer edit/apply_patch when possible.${exactName}]`);
  }
  if (normalized === "edit" || normalized === "str_replace") {
    const exactName = capabilities.isOpenCode && normalized === "edit"
      ? " Exact OpenCode tool name is edit; do not call str_replace/replace_in_file."
      : "";
    return appendHint(description, ` [Synesis: Use after reading the file. Prefer one focused edit per file and wait for the result before another edit to that file.${exactName}]`);
  }
  if (normalized === "read") {
    const exactName = capabilities.isOpenCode
      ? " Exact OpenCode tool name is read; do not call read_file."
      : "";
    return appendHint(description, ` [Synesis: Read files before editing existing paths.${exactName}]`);
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
