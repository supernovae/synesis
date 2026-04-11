import path from "node:path";

/**
 * Model-specific adapters for upstream LLM behavioral differences.
 *
 * Each adapter encapsulates per-model quirks: tool-use system prompts,
 * argument normalization, provider options, and capability flags.
 * Adapters are resolved automatically from the TierConfig.backendModel string.
 */

export interface RecentToolCall {
  toolName: string;
  filePath?: string;
  args?: Record<string, unknown>;
}

export interface QwenPivotOptions {
  recentAssistantText?: string | null;
  stagnationWindow?: number;
  stagnationThreshold?: number;
  planNoActionLimit?: number;
  editRetryLimit?: number;
}

export interface ModelAdapter {
  readonly family: string;

  /** Extra system prompt fragment for tool-use guidance (model-specific). Must be pure/deterministic. */
  toolSystemPrompt?(toolCount: number): string | undefined;

  /** Normalize tool call arguments from model response before forwarding to client. */
  normalizeToolCallArgs?(args: string): string;

  /**
   * Remap tool call arguments to match the expected schema.
   * Models like Qwen3-Coder use generic param names (path, content) while
   * Claude Code tools expect specific names (file_path, command).
   * Returns the remapped input object and whether any changes were made.
   */
  remapToolArgs?(toolName: string, input: Record<string, unknown>): { input: Record<string, unknown>; remapped: boolean };

  /** Provider options to pass to AI SDK (e.g., thinking config). */
  providerOptions?(): Record<string, Record<string, unknown>> | undefined;

  /** Whether this model supports thinking/reasoning blocks. */
  supportsThinking: boolean;

  /** Max tool definitions this model handles well (for future schema pruning). */
  maxEffectiveTools?: number;

  /**
   * Detect model-specific early pivot condition (e.g. read-loop).
   * Returns a pivot prompt string when intervention is needed, null otherwise.
   */
  getEarlyPivotPrompt?(recentToolCalls: RecentToolCall[], options?: QwenPivotOptions): string | null;

  /**
   * Detect consecutive calls to the same tool and return a nudge prompt.
   * Returns null when no intervention is needed.
   */
  dampenConsecutiveSameTools?(recentToolNames: string[]): string | null;

  /**
   * Append model-specific usage hints to a tool's description string.
   * Returns the (possibly enriched) description.
   */
  enrichToolDescription?(toolName: string, description: string): string;

  /**
   * Model-recommended sampling defaults (temperature, top_p, etc.).
   * Yarn uses these as fallback when the client request omits sampling params.
   * Client-specified values always take precedence.
   */
  defaultSamplingParams?(): { temperature?: number; top_p?: number } | undefined;
}

export interface ToolArgValidationResult {
  valid: boolean;
  missing: string[];
}

/**
 * Common parameter name aliases that models use incorrectly.
 * Maps { wrongName: correctName } per tool.
 */
const CLAUDE_CODE_PARAM_ALIASES: Record<string, Record<string, string>> = {
  Write: { path: "file_path", filename: "file_path", file: "file_path", filepath: "file_path", text: "content", code: "content", file_content: "content", body: "content" },
  Read: { path: "file_path", filename: "file_path", file: "file_path", filepath: "file_path" },
  Edit: { path: "file_path", filename: "file_path", file: "file_path", filepath: "file_path", find: "old_string", search: "old_string", replace: "new_string", replacement: "new_string" },
  Update: { path: "file_path", filename: "file_path", file: "file_path", filepath: "file_path", find: "old_string", search: "old_string", replace: "new_string", replacement: "new_string" },
  Bash: {
    cmd: "command",
    script: "command",
    shell_command: "command",
    bash_command: "command",
    run: "command",
    input: "command",
    text: "command",
    shell: "command",
    line: "command",
    code: "command",
  },
  Glob: { pattern: "glob_pattern", glob: "glob_pattern", path: "target_directory", directory: "target_directory" },
  Grep: { query: "pattern", search: "pattern", regex: "pattern", path: "target_directory", directory: "target_directory" },
  WebFetch: { url: "url" },
};

const IMPLEMENT_INTENT_RE =
  /\b(i('| a)?ll|let me|i need to|i should|i can)\b.{0,40}\b(implement|add|fix|update|enhance|complete|continue)\b/i;

const FINGERPRINT_ARG_KEYS = [
  "file_path",
  "old_string",
  "new_string",
  "command",
  "pattern",
  "glob_pattern",
] as const;

function truncateForFingerprint(value: string, max = 80): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}…`;
}

function isActionToolCall(call: RecentToolCall): boolean {
  const t = call.toolName.trim().toLowerCase();
  if (t === "edit" || t === "update" || t === "write") return true;
  if (t !== "bash") return false;
  const cmdRaw = call.args?.command;
  if (typeof cmdRaw !== "string") return false;
  const cmd = cmdRaw.toLowerCase();
  return /\b(test|build|lint|vet)\b/.test(cmd);
}

export function fingerprintToolCall(call: RecentToolCall): string {
  const tool = call.toolName.trim().toLowerCase();
  const args = call.args ?? {};
  const canonicalArgs: Record<string, unknown> = { ...args };
  if (canonicalArgs.file_path === undefined && canonicalArgs.path !== undefined) {
    canonicalArgs.file_path = canonicalArgs.path;
  }
  delete canonicalArgs.path;
  const rawPath =
    (typeof call.filePath === "string" && call.filePath.trim()) ||
    (typeof canonicalArgs.file_path === "string" && canonicalArgs.file_path.trim()) ||
    (typeof canonicalArgs.filename === "string" && canonicalArgs.filename.trim()) ||
    "";
  const normalizedPath = rawPath
    ? normalizeWorkspaceRelativeFilePath(rawPath).toLowerCase()
    : "";
  const parts: string[] = [`t:${tool}`];
  if (normalizedPath) parts.push(`p:${normalizedPath}`);

  for (const key of FINGERPRINT_ARG_KEYS) {
    const raw = canonicalArgs[key];
    if (raw === undefined || raw === null) continue;
    let normalized = "";
    if (key === "file_path" && typeof raw === "string") {
      normalized = normalizeWorkspaceRelativeFilePath(raw).toLowerCase();
    } else if (typeof raw === "string") {
      normalized = truncateForFingerprint(raw);
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      normalized = String(raw);
    } else {
      normalized = truncateForFingerprint(JSON.stringify(raw));
    }
    if (normalized) parts.push(`${key}:${normalized}`);
  }
  return parts.join("|");
}

export class Qwen3CoderAdapter implements ModelAdapter {
  readonly family = "qwen3-coder";
  readonly supportsThinking = false;
  readonly maxEffectiveTools = 40;

  /**
   * When true, the backend handles XML→JSON tool call conversion natively
   * (DashScope, vLLM with --tool-call-parser=qwen3_coder). We skip the
   * heavy heredoc workaround prompt and trust tool calls to come through clean.
   */
  readonly nativeToolParser: boolean;

  constructor(nativeToolParser = false) {
    this.nativeToolParser = nativeToolParser;
  }

  defaultSamplingParams(): { temperature: number; top_p: number } {
    return { temperature: 1.0, top_p: 0.95 };
  }

  toolSystemPrompt(toolCount: number): string | undefined {
    if (toolCount === 0) return undefined;

    const workflowDiscipline = [
      "",
      "## Workflow discipline",
      "- **Read-then-act**: After reading a file, your NEXT action must be an edit, write, or bash command — never re-read the same file.",
      "- **Plan commitment**: Once you state a plan, execute it step by step. Do not re-gather information you already have.",
      "- **Progressive narrowing**: Each tool call must produce NEW information or make a change. If a search returns results, act on them — do not search again with slightly different terms.",
      "- **File offset awareness**: When reading large files, use offset/limit parameters to read specific sections. Do not re-read from line 1 if you already have the beginning.",
      "- **Edit failures**: If an Edit/Update call fails, do NOT retry with identical arguments. Re-read the file to get current content, then adjust your old_string to match exactly.",
    ].join("\n");

    // Backend with native XML parser handles tool calls correctly — minimal guidance only
    if (this.nativeToolParser) {
      return [
        "# Tool Calling Guidelines",
        "Use the EXACT parameter names from each tool's schema.",
        "If a tool requires no arguments, pass an empty object: `{}`.",
        "Use RELATIVE file paths (e.g., `hello.go`, `cmd/main.go`), not absolute paths.",
        "For file tools, paths are workspace-relative. Do NOT prefix paths with the workspace folder name.",
        "Do NOT assume shell `cd` changes file-tool path roots.",
        workflowDiscipline,
      ].join("\n");
    }

    // JSON-only backend (DeepInfra, OpenRouter) — steer toward Bash heredoc for code
    return [
      "# Tool Calling Guidelines",
      "You have access to tools. When calling a tool, you MUST use the EXACT parameter names from the tool's schema.",
      "If a tool requires no arguments, pass an empty object: `{}`.",
      "Do not omit the arguments field. Call one tool at a time.",
      "Never emit XML tool wrappers/tags (e.g. <tool_call>, <tool>, </tool>).",
      "Tool calls must be plain JSON arguments through the tool API only.",
      "",
      "## Critical parameter names (use these EXACTLY):",
      "- **Write tool**: `file_path` (string), `content` (string). Both required.",
      "- **Read tool**: `file_path` (string). Required.",
      "- **Edit tool**: `file_path`, `old_string`, `new_string`.",
      "- **Bash tool**: `command` (string). Required.",
      "- **Grep tool**: `pattern` (string).",
      "- **Glob tool**: `glob_pattern` (string).",
      "",
      "## Creating files (PREFERRED method for source code):",
      "For files containing source code, use the **Bash** tool with a heredoc instead of the Write tool.",
      "This avoids JSON escaping problems with quotes and newlines in code.",
      "",
      "Example — create a Go file:",
      '{"command": "cat > hello.go << \'EOF\'\\npackage main\\n\\nimport \\"fmt\\"\\n\\nfunc main() {\\n\\tfmt.Println(\\"Hello, World!\\")\\n}\\nEOF"}',
      "",
      "Example — create a Python file:",
      '{"command": "cat > app.py << \'EOF\'\\nfrom flask import Flask\\n\\napp = Flask(__name__)\\n\\n@app.route(\\"/\\")\\ndef index():\\n    return \\"Hello\\"\\nEOF"}',
      "",
      "Only use the Write tool for short config files or single-line content.",
      "",
      "## File paths:",
      "Use RELATIVE paths from the current working directory (e.g., `hello.go`, `cmd/main.go`).",
      "Do NOT use absolute paths like `/home/user/...`. The user's OS may not be Linux.",
      "For file tools, do NOT prefix with the repository/workspace folder name.",
      "Shell `cd` usage does not change file-tool root semantics; keep file paths workspace-relative.",
      "",
      "## Directories (avoid getting lost):",
      "Do not `mkdir` and `cd` into a folder that repeats the project name multiple times (e.g. `aws-cost-calculator/aws-cost-calculator/...`).",
      "If the workspace is empty or you are already at the project root, create files there (`main.go`, `go.mod`) instead of nesting duplicate path segments.",
      workflowDiscipline,
    ].join("\n");
  }

  normalizeToolCallArgs(args: string): string {
    const trimmed = args.trim();
    if (!trimmed || trimmed === "null" || trimmed === "undefined") return "{}";
    return trimmed;
  }

  remapToolArgs(toolName: string, input: Record<string, unknown>): { input: Record<string, unknown>; remapped: boolean } {
    const aliases = CLAUDE_CODE_PARAM_ALIASES[toolName];
    if (!aliases) return { input, remapped: false };

    let remapped = false;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const correctName = aliases[key];
      if (correctName && !(correctName in input)) {
        result[correctName] = value;
        remapped = true;
      } else {
        result[key] = value;
      }
    }
    return { input: result, remapped };
  }

  getEarlyPivotPrompt(recentToolCalls: RecentToolCall[], options: QwenPivotOptions = {}): string | null {
    if (recentToolCalls.length < 3) return null;

    const planNoActionLimit = Math.max(1, options.planNoActionLimit ?? 4);
    const editRetryLimit = Math.max(2, options.editRetryLimit ?? 3);
    const stagnationWindow = Math.max(3, options.stagnationWindow ?? 8);
    const stagnationThreshold = Math.max(2, options.stagnationThreshold ?? 3);

    const noAction = this._detectPlanWithoutAction(
      recentToolCalls,
      options.recentAssistantText,
      planNoActionLimit,
    );
    if (noAction) return noAction;

    // Ordered checks: edit-retry before broader repeated-intent/read loops.
    const editRetries = this._detectEditRetryLoop(recentToolCalls, editRetryLimit);
    if (editRetries) return editRetries;

    const repeatedIntent = this._detectRepeatedIntentLoop(
      recentToolCalls,
      stagnationWindow,
      stagnationThreshold,
    );
    if (repeatedIntent) return repeatedIntent;

    return this._detectReadLoop(recentToolCalls, stagnationThreshold);
  }

  dampenConsecutiveSameTools(recentToolNames: string[]): string | null {
    if (recentToolNames.length < 3) return null;

    const READ_SEARCH_TOOLS = new Set(["Read", "cat", "head", "tail", "read"]);
    const GREP_FIND_TOOLS = new Set(["Grep", "grep", "find", "Glob", "glob", "rg"]);

    const tail = recentToolNames.slice(-6);
    let consecutiveCount = 1;
    const lastTool = tail[tail.length - 1];
    for (let i = tail.length - 2; i >= 0; i--) {
      if (tail[i] === lastTool) {
        consecutiveCount++;
      } else {
        break;
      }
    }

    const isReadSearch = READ_SEARCH_TOOLS.has(lastTool);
    const isGrepFind = GREP_FIND_TOOLS.has(lastTool);
    const threshold = (isReadSearch || isGrepFind) ? 3 : lastTool === "Bash" ? 6 : 4;

    if (consecutiveCount < threshold) return null;

    if (isReadSearch) {
      return `You have called ${lastTool} ${consecutiveCount} times consecutively. You have enough information — make your edit now using Edit or Write. Do not read again.`;
    }
    if (isGrepFind) {
      return `You have called ${lastTool} ${consecutiveCount} times consecutively. Narrow your approach: act on the results you have, or try a different tool.`;
    }
    return `You have called ${lastTool} ${consecutiveCount} times consecutively. Vary your approach: if gathering info, now act on it. If something is failing, re-read the error and try a different strategy.`;
  }

  enrichToolDescription(toolName: string, description: string): string {
    const hints: Record<string, string> = {
      Read: " [Qwen hint: Read a file ONCE. After reading, make your edit. Do not re-read the same file.]",
      Edit: " [Qwen hint: PREFERRED for code changes. If the edit fails, re-read the file to get current content before retrying with corrected old_string.]",
      Update: " [Qwen hint: PREFERRED for code changes. If the update fails, re-read the file to get current content before retrying with corrected old_string.]",
      Bash: " [Qwen hint: Use for running tests, builds, and creating files via heredoc. Do not use cat to read files — use the Read tool instead.]",
      Grep: " [Qwen hint: Search once, then act on results. Do not repeat with minor variations.]",
      Glob: " [Qwen hint: Search once, then act on results. Do not repeat with minor variations.]",
    };
    const hint = hints[toolName];
    return hint ? description + hint : description;
  }

  private _detectPlanWithoutAction(
    recentToolCalls: RecentToolCall[],
    recentAssistantText: string | null | undefined,
    noActionLimit: number,
  ): string | null {
    const text = (recentAssistantText ?? "").trim();
    if (!text || !IMPLEMENT_INTENT_RE.test(text)) return null;
    const tail = recentToolCalls.slice(-noActionLimit);
    if (tail.length < noActionLimit) return null;
    if (tail.some((c) => isActionToolCall(c))) return null;
    return "You stated an implementation plan but did not execute it. Your next step must be exactly one concrete action: (1) Edit/Write code, (2) run a test/build command, or (3) state a blocker and pick a different strategy.";
  }

  private _detectRepeatedIntentLoop(
    recentToolCalls: RecentToolCall[],
    window: number,
    threshold: number,
  ): string | null {
    const tail = recentToolCalls.slice(-window);
    const counts = new Map<string, { count: number; sample: RecentToolCall }>();
    for (const call of tail) {
      if (isActionToolCall(call)) continue;
      const sig = fingerprintToolCall(call);
      const prev = counts.get(sig);
      if (prev) {
        prev.count += 1;
      } else {
        counts.set(sig, { count: 1, sample: call });
      }
    }
    let top: { count: number; sample: RecentToolCall } | null = null;
    for (const value of counts.values()) {
      if (value.count >= threshold && (!top || value.count > top.count)) {
        top = value;
      }
    }
    if (!top) return null;
    const target = top.sample.filePath?.trim()
      || (typeof top.sample.args?.file_path === "string" ? top.sample.args.file_path : "")
      || "the same target";
    return `You are repeating the same intent on ${target} (${top.count} times) without forward progress. Stop repeating this call pattern. Make one concrete change now (Edit/Write or test/build), and do not re-read or re-search ${target} until after that action.`;
  }

  private _detectReadLoop(recentToolCalls: RecentToolCall[], threshold: number): string | null {
    const READ_LIKE = new Set(["Read", "cat", "head", "tail", "read"]);
    const EDIT_LIKE = new Set(["Edit", "Update", "Write", "edit", "update", "write"]);
    const tail = recentToolCalls.slice(-Math.max(6, threshold + 2));
    const readCalls: RecentToolCall[] = [];
    for (let i = tail.length - 1; i >= 0; i--) {
      if (READ_LIKE.has(tail[i].toolName)) {
        readCalls.push(tail[i]);
      } else if (EDIT_LIKE.has(tail[i].toolName)) {
        break;
      } else {
        break;
      }
    }
    if (readCalls.length < threshold) return null;
    // If the model is adapting (switching between Read and Bash on the same
    // file), give it extra room — only fire when the SAME fingerprint appears
    // repeatedly without any tool change.
    const readTools = new Set(readCalls.map((c) => c.toolName));
    if (readTools.size > 1 && readCalls.length < threshold + 2) return null;
    const filePaths = readCalls.map((c) => c.filePath).filter(Boolean);
    const uniqueFiles = [...new Set(filePaths)];
    if (uniqueFiles.length === 0) return null;
    const fileList = uniqueFiles.slice(0, 4).join(", ");
    return `You have read ${fileList} multiple times. You have enough context. Write the code change now using Edit or Bash. Do not read these files again.`;
  }

  /** Detect repeated Edit/Update calls to the same file (error-retry loop). */
  private _detectEditRetryLoop(recentToolCalls: RecentToolCall[], minRetries: number): string | null {
    if (recentToolCalls.length < minRetries) return null;

    const tail = recentToolCalls.slice(-5);
    const EDIT_TOOLS = new Set(["Edit", "Update", "edit", "update"]);

    let consecutiveEdits = 0;
    let editFile: string | undefined;
    for (let i = tail.length - 1; i >= 0; i--) {
      const call = tail[i];
      if (!EDIT_TOOLS.has(call.toolName)) break;
      if (editFile === undefined) {
        editFile = call.filePath;
      } else if (call.filePath !== editFile) {
        break;
      }
      consecutiveEdits++;
    }

    if (consecutiveEdits >= minRetries && editFile) {
      return `You have attempted to edit ${editFile} ${consecutiveEdits} times and it keeps failing. STOP retrying the same edit. Re-read the file first to see its current content, then construct a new Edit with the correct old_string that matches the actual file content.`;
    }
    return null;
  }
}

export class GenericOpenAIAdapter implements ModelAdapter {
  readonly family: string;
  readonly supportsThinking = false;

  constructor(family = "generic") {
    this.family = family;
  }
}

export class DeepSeekAdapter implements ModelAdapter {
  readonly family = "deepseek";
  readonly supportsThinking = true;

  providerOptions(): Record<string, Record<string, unknown>> {
    return { openai: { reasoningParser: "deepseek_r1" } };
  }
}

/**
 * Adapter-neutral: detect malformed Write tool calls and convert to Bash heredoc.
 *
 * JSON tool calling breaks when code content contains nested quotes (the Qwen3-Coder
 * paper explicitly notes "heavy escaping overhead for multi-line code" in JSON format).
 * When the model fails to properly serialize code, the content comes through truncated
 * or garbled. This function detects that and rewrites the tool call as a Bash heredoc,
 * which avoids JSON escaping entirely.
 *
 * Returns null if no repair needed, or a replacement tool call if repaired.
 */
/**
 * Qwen3 / JSON tool backends sometimes emit Bash with the shell command in a
 * wrong property, or a single stray key copied from user text (e.g. `{"World!":""}`)
 * with no `command` field — the client then treats the stray key as the command
 * (`command not found: World!:`).
 */
export function repairBashToolCall(
  toolName: string,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; repaired: boolean } | null {
  if (toolName !== "Bash") return null;

  const ALLOWED = new Set(["command", "description", "is_background", "timeout"]);
  const cmd = input.command;
  if (typeof cmd === "string" && cmd.trim()) return null;

  const extras = Object.entries(input).filter(([k]) => k && !ALLOWED.has(k));
  const nonEmptyStringPairs = extras.filter(([, v]) => typeof v === "string" && (v as string).trim());

  // Wrong key but the value is the real shell command
  if (nonEmptyStringPairs.length === 1) {
    const [, v] = nonEmptyStringPairs[0];
    const out: Record<string, unknown> = { command: v };
    if (typeof input.description === "string") out.description = input.description;
    if (typeof input.is_background === "boolean") out.is_background = input.is_background;
    return { input: out, repaired: true };
  }

  // Single stray key with empty value — unrecoverable; fail clearly for the user
  if (extras.length === 1 && nonEmptyStringPairs.length === 0) {
    const [k, v] = extras[0];
    if (v === "" || v === null || v === undefined) {
      const msg =
        "Synesis Yarn: model sent invalid Bash arguments (no command string). " +
        "Try again, or use a backend with native Qwen3 tool parsing (vLLM --tool-call-parser=qwen3_coder or DashScope).";
      return {
        input: {
          command: `echo ${shellEscape(msg)} >&2; exit 1`,
          description: `Repaired malformed Bash args (stray key ${JSON.stringify(k)})`,
        },
        repaired: true,
      };
    }
  }

  return null;
}

export function repairWriteToolCall(
  toolName: string,
  input: Record<string, unknown>,
): { rewrittenToolName: string; rewrittenInput: Record<string, unknown> } | null {
  if (toolName !== "Write") return null;

  const filePath = input.file_path as string | undefined;
  const content = input.content as string | undefined;

  if (!filePath || typeof filePath !== "string") return null;
  if (!content || typeof content !== "string") return null;

  // Heuristics for garbled content:
  // 1. Content looks like Python dict syntax (model failed JSON encoding)
  // 2. Content is suspiciously short for a source file (< 20 chars) but has a code extension
  // 3. Content has no newlines but the file extension suggests multi-line code
  const codeExtensions = /\.(go|py|js|ts|jsx|tsx|rs|c|cpp|h|java|rb|sh|yaml|yml|toml|json|html|css)$/i;
  const looksLikePythonDict = /^\{['"][^"']+['"]\s*:/.test(content.trim());
  const tooShortForCode = content.length < 20 && codeExtensions.test(filePath);
  const noNewlinesInCode = !content.includes("\n") && content.length < 50 && codeExtensions.test(filePath);

  // Never Bash-repair obvious JSON-serialization garbage — a heredoc of `{'World!': ''}` is worse than
  // leaving the Write as-is so the client can show a failed tool / model can retry.
  if (looksLikePythonDict) return null;

  if (!tooShortForCode && !noNewlinesInCode) return null;

  const safePath = normalizeHallucinatedLinuxWritePath(filePath);

  // Rewrite as Bash heredoc -- avoids JSON escaping entirely
  const heredocCmd = `cat > ${shellEscape(safePath)} << 'SYNESIS_EOF'\n${content}\nSYNESIS_EOF`;
  return {
    rewrittenToolName: "Bash",
    rewrittenInput: {
      command: heredocCmd,
      description: `Create ${safePath} (repaired from malformed Write)`,
    },
  };
}

export function normalizeFileToolArgs(
  toolName: string,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; normalized: boolean } {
  if (!["Write", "Read", "Edit", "Update"].includes(toolName)) {
    return { input, normalized: false };
  }
  const filePath = input.file_path;
  if (typeof filePath !== "string" || !filePath.trim()) {
    return { input, normalized: false };
  }
  const normalizedPath = normalizeWorkspaceRelativeFilePath(filePath);
  if (normalizedPath === filePath) {
    return { input, normalized: false };
  }
  return { input: { ...input, file_path: normalizedPath }, normalized: true };
}

/**
 * Normalise file_path for Read / Write / Edit / Update tool calls.
 *
 * Design principle: the **client** (Claude Code) is the security boundary.
 * It prompts the user for permission on sensitive paths and controls what
 * actually executes on disk.  Yarn should:
 *
 *  1. Fix hallucinated paths      — `/home/user/…`, `C:\Users\…` on macOS
 *  2. Normalise in-root absolutes — `/Users/me/proj/main.go` → `main.go`
 *  3. Pass through legitimate out-of-root absolutes unchanged so the client
 *     can apply its own permission model (e.g. `~/.claude/plans/`).
 *
 * Only truly foreign / hallucinated paths (Linux sandbox, Windows-on-Unix)
 * are clamped to basename.  Relative traversals (`../../x`) are left alone
 * because `normalizeWorkspaceRelativeFilePath` already stripped hallucinated
 * prefixes; what remains is intentional.
 */
export function constrainFileToolPathToProjectRoot(
  projectRoot: string | null | undefined,
  toolName: string,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; constrained: boolean } {
  if (!projectRoot?.trim()) return { input, constrained: false };
  if (!["Write", "Read", "Edit", "Update"].includes(toolName)) return { input, constrained: false };
  const fp = input.file_path;
  if (typeof fp !== "string" || !fp.trim()) return { input, constrained: false };

  const root = path.resolve(projectRoot.trim());
  const raw = fp.trim();
  const maybeHostLikeNoSlash = /^(Users|home|root)\//.test(raw);
  const withHostSlash = maybeHostLikeNoSlash ? `/${raw}` : raw;
  const looksWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(withHostSlash);

  // Windows drive-letter paths on a non-Windows host are always hallucinated.
  if (looksWindowsAbsolute && path.sep !== "\\") {
    const base = path.basename(withHostSlash.replace(/\\/g, "/"));
    const clamped =
      base && base !== "." && base !== ".."
        ? base.split(path.sep).join("/")
        : "file";
    return { input: { ...input, file_path: clamped }, constrained: true };
  }

  const resolved = path.isAbsolute(withHostSlash) ? path.resolve(withHostSlash) : path.resolve(root, withHostSlash);
  const rel = path.relative(root, resolved);
  const inside =
    rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));

  if (inside) {
    // In-root absolute → project-relative (convenience, not security).
    const normalizedRel = (rel || ".").split(path.sep).join("/");
    const prev = raw.replace(/\\/g, "/");
    if (normalizedRel === prev) return { input, constrained: false };
    return { input: { ...input, file_path: normalizedRel }, constrained: true };
  }

  // Out-of-root: pass through legitimate absolute paths to the client.
  // The client (Claude Code) enforces its own read/write permission model.
  if (path.isAbsolute(withHostSlash)) {
    return { input, constrained: false };
  }

  // Relative traversal (e.g. ../../foo) — leave as-is; normalizeWorkspaceRelativeFilePath
  // already stripped hallucinated prefixes.
  return { input, constrained: false };
}

export function validateToolArgs(
  toolName: string,
  input: Record<string, unknown>,
): ToolArgValidationResult {
  const requiredByTool: Record<string, string[]> = {
    Write: ["file_path", "content"],
    Read: ["file_path"],
    Edit: ["file_path", "old_string", "new_string"],
    Update: ["file_path", "old_string", "new_string"],
    Bash: ["command"],
    Glob: ["glob_pattern"],
    Grep: ["pattern"],
    WebFetch: ["url"],
  };
  const required = requiredByTool[toolName];
  if (!required) return { valid: true, missing: [] };

  const missing = required.filter((k) => {
    const v = input[k];
    if (typeof v === "string") return v.trim().length === 0;
    return v === undefined || v === null;
  });
  return { valid: missing.length === 0, missing };
}

/**
 * Models often hallucinate `/home/user/foo.go` (Linux sandbox). Claude Code runs on the user's machine;
 * use a relative path (basename or tail after /home/<user>/).
 */
export function normalizeHallucinatedLinuxWritePath(filePath: string): string {
  const p = filePath.trim();
  const homeUser = /^\/home\/[^/]+\/(.+)$/;
  const m = p.match(homeUser);
  if (m) return m[1];
  if (p.startsWith("/root/")) return p.slice("/root/".length);
  return p;
}

/**
 * Normalize common file-path quirks from tool calls:
 * - surrounding quotes/backticks
 * - Windows separators
 * - duplicated leading repo segment (e.g. foo/foo/bar.go)
 * - leading "./"
 */
export function normalizeWorkspaceRelativeFilePath(filePath: string): string {
  let p = filePath.trim();
  if (!p) return p;
  p = p.replace(/^["'`]+|["'`]+$/g, "");
  p = p.replace(/\\/g, "/");
  p = p.replace(/^\.\/+/, "");
  p = p.replace(/\/{2,}/g, "/");
  const preHallucinated = p;
  p = normalizeHallucinatedLinuxWritePath(p);
  const hallucinatedLinuxPathRewritten = preHallucinated !== p;
  const preserveLeadingSlash = p.startsWith("/") && !hallucinatedLinuxPathRewritten;

  const parts = p.split("/").filter((s) => s.length > 0);
  let guard = 0;
  while (
    parts.length >= 2 &&
    parts[0] === parts[1] &&
    parts[0] !== "." &&
    parts[0] !== ".." &&
    guard < 32
  ) {
    parts.shift();
    guard += 1;
  }
  const normalized = parts.join("/");
  return preserveLeadingSlash ? `/${normalized}` : normalized;
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Backends that handle the Qwen3-Coder XML tool format server-side,
 * converting XML tool calls to clean JSON before returning them via the API.
 */
function hasNativeQwenToolParser(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  const u = baseUrl.toLowerCase();
  // DashScope (Alibaba) — all regional endpoints
  if (u.includes("dashscope")) return true;
  // Local vLLM with qwen3_coder parser — svc.cluster.local endpoints
  if (u.includes(".svc.cluster.local") || u.includes("localhost") || u.includes("127.0.0.1")) return true;
  return false;
}

export const KNOWN_ADAPTER_FAMILIES = [
  "qwen3-coder", "deepseek", "kimi", "minimax", "generic",
] as const;
export type AdapterFamily = (typeof KNOWN_ADAPTER_FAMILIES)[number];

/**
 * Resolve adapter from the backend model name (e.g. "Qwen/Qwen3-Coder-480B-A35B-Instruct").
 * When `adapterHint` is set (from admin Model Registry), it overrides regex auto-detection.
 * Otherwise pattern-matches against known model families. Falls back to GenericOpenAIAdapter.
 */
export function resolveAdapter(backendModel: string, baseUrl?: string, adapterHint?: string | null): ModelAdapter {
  const hint = (adapterHint ?? "").trim().toLowerCase();
  if (hint && (KNOWN_ADAPTER_FAMILIES as readonly string[]).includes(hint)) {
    return resolveByFamily(hint as AdapterFamily, baseUrl);
  }
  const m = backendModel.toLowerCase();
  if (/qwen3.*coder/i.test(m)) return new Qwen3CoderAdapter(hasNativeQwenToolParser(baseUrl));
  if (/deepseek/i.test(m)) return new DeepSeekAdapter();
  if (/kimi|moonshot/i.test(m)) return new GenericOpenAIAdapter("kimi");
  if (/minimax|abab/i.test(m)) return new GenericOpenAIAdapter("minimax");
  return new GenericOpenAIAdapter("generic");
}

function resolveByFamily(family: AdapterFamily, baseUrl?: string): ModelAdapter {
  switch (family) {
    case "qwen3-coder": return new Qwen3CoderAdapter(hasNativeQwenToolParser(baseUrl));
    case "deepseek": return new DeepSeekAdapter();
    case "kimi": return new GenericOpenAIAdapter("kimi");
    case "minimax": return new GenericOpenAIAdapter("minimax");
    case "generic": return new GenericOpenAIAdapter("generic");
  }
}
