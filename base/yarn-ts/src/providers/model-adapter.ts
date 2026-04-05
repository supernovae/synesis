import path from "node:path";

/**
 * Model-specific adapters for upstream LLM behavioral differences.
 *
 * Each adapter encapsulates per-model quirks: tool-use system prompts,
 * argument normalization, provider options, and capability flags.
 * Adapters are resolved automatically from the TierConfig.backendModel string.
 */

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

  toolSystemPrompt(toolCount: number): string | undefined {
    if (toolCount === 0) return undefined;

    // Backend with native XML parser handles tool calls correctly — minimal guidance only
    if (this.nativeToolParser) {
      return [
        "# Tool Calling Guidelines",
        "Use the EXACT parameter names from each tool's schema.",
        "If a tool requires no arguments, pass an empty object: `{}`.",
        "Use RELATIVE file paths (e.g., `hello.go`, `cmd/main.go`), not absolute paths.",
        "For file tools, paths are workspace-relative. Do NOT prefix paths with the workspace folder name.",
        "Do NOT assume shell `cd` changes file-tool path roots.",
      ].join("\n");
    }

    // JSON-only backend (DeepInfra, OpenRouter) — steer toward Bash heredoc for code
    return [
      "# Tool Calling Guidelines",
      "You have access to tools. When calling a tool, you MUST use the EXACT parameter names from the tool's schema.",
      "If a tool requires no arguments, pass an empty object: `{}`.",
      "Do not omit the arguments field. Call one tool at a time.",
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
 * When project_root is known (client-provided absolute path), ensure file_path resolves under it.
 * Outside paths are clamped to basename under root (best-effort). Uses path.resolve string rules only.
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

  // On non-Windows hosts, treat Windows drive-letter paths as foreign absolute paths
  // and clamp to basename under root rather than creating "C:" directories in-repo.
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
    const normalizedRel = (rel || ".").split(path.sep).join("/");
    const prev = raw.replace(/\\/g, "/");
    if (normalizedRel === prev) return { input, constrained: false };
    return { input: { ...input, file_path: normalizedRel }, constrained: true };
  }
  const base = path.basename(resolved);
  const clamped =
    base && base !== "." && base !== ".."
      ? base.split(path.sep).join("/")
      : "file";
  return { input: { ...input, file_path: clamped }, constrained: true };
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

/**
 * Resolve adapter from the backend model name (e.g. "Qwen/Qwen3-Coder-480B-A35B-Instruct").
 * Pattern-matches against known model families. Falls back to GenericOpenAIAdapter.
 */
export function resolveAdapter(backendModel: string, baseUrl?: string): ModelAdapter {
  const m = backendModel.toLowerCase();
  if (/qwen3.*coder/i.test(m)) return new Qwen3CoderAdapter(hasNativeQwenToolParser(baseUrl));
  if (/deepseek/i.test(m)) return new DeepSeekAdapter();
  if (/kimi|moonshot/i.test(m)) return new GenericOpenAIAdapter("kimi");
  if (/minimax|abab/i.test(m)) return new GenericOpenAIAdapter("minimax");
  return new GenericOpenAIAdapter("generic");
}
