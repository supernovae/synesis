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

/**
 * Common parameter name aliases that models use incorrectly.
 * Maps { wrongName: correctName } per tool.
 */
const CLAUDE_CODE_PARAM_ALIASES: Record<string, Record<string, string>> = {
  Write: { path: "file_path", filename: "file_path", file: "file_path", filepath: "file_path", text: "content", code: "content", file_content: "content", body: "content" },
  Read: { path: "file_path", filename: "file_path", file: "file_path", filepath: "file_path" },
  Edit: { path: "file_path", filename: "file_path", file: "file_path", filepath: "file_path", find: "old_string", search: "old_string", replace: "new_string", replacement: "new_string" },
  Bash: { cmd: "command", script: "command", shell_command: "command", bash_command: "command", run: "command" },
  Glob: { pattern: "glob_pattern", glob: "glob_pattern", path: "target_directory", directory: "target_directory" },
  Grep: { query: "pattern", search: "pattern", regex: "pattern", path: "target_directory", directory: "target_directory" },
  WebFetch: { url: "url" },
};

export class Qwen3CoderAdapter implements ModelAdapter {
  readonly family = "qwen3-coder";
  readonly supportsThinking = false;
  readonly maxEffectiveTools = 40;

  toolSystemPrompt(toolCount: number): string | undefined {
    if (toolCount === 0) return undefined;
    return [
      "# Tool Calling Guidelines",
      "You have access to tools. When calling a tool, you MUST use the EXACT parameter names from the tool's schema.",
      "If a tool requires no arguments, pass an empty object: `{}`.",
      "Do not omit the arguments field. Call one tool at a time.",
      "",
      "## Critical parameter names (use these EXACTLY):",
      "- **Write tool**: `file_path` (string, required), `content` (string, required). Do NOT use `path` or `filename`.",
      "- **Read tool**: `file_path` (string, required). Do NOT use `path` or `filename`.",
      "- **Edit tool**: `file_path`, `old_string`, `new_string`. Do NOT use `path`, `find`, or `replace`.",
      "- **Bash tool**: `command` (string, required). Do NOT use `cmd` or `script`.",
      "- **Grep tool**: `pattern` (string, required).",
      "- **Glob tool**: `glob_pattern` (string, required).",
      "",
      "When creating files, ALWAYS include the full file content in the `content` parameter. Never leave it empty.",
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
 * Resolve adapter from the backend model name (e.g. "Qwen/Qwen3-Coder-480B-A35B-Instruct").
 * Pattern-matches against known model families. Falls back to GenericOpenAIAdapter.
 */
export function resolveAdapter(backendModel: string, _baseUrl?: string): ModelAdapter {
  const m = backendModel.toLowerCase();
  if (/qwen3.*coder/i.test(m)) return new Qwen3CoderAdapter();
  if (/deepseek/i.test(m)) return new DeepSeekAdapter();
  if (/kimi|moonshot/i.test(m)) return new GenericOpenAIAdapter("kimi");
  if (/minimax|abab/i.test(m)) return new GenericOpenAIAdapter("minimax");
  return new GenericOpenAIAdapter("generic");
}
