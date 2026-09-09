import { createHash } from "node:crypto";
import { canonicalValidationToolName } from "../tool-aliases.js";

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
  resultContent?: string;
}

export interface QwenPivotOptions {
  recentAssistantText?: string | null;
  recentUserPrompt?: string | null;
  recentToolResultText?: string | null;
  stagnationWindow?: number;
  stagnationThreshold?: number;
  planNoActionLimit?: number;
  editRetryLimit?: number;
}

export type CacheMarkerBackend = "anthropic" | "dashscope" | "none";

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

  /** Explicit cache marker backend for this model family. Defaults to "none". */
  cacheMarkerBackend?(): CacheMarkerBackend;

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
  Write: {
    path: "file_path",
    filename: "file_path",
    file: "file_path",
    filepath: "file_path",
    target_path: "file_path",
    targetFile: "file_path",
    target_file: "file_path",
    text: "content",
    code: "content",
    body: "content",
    contents: "content",
    fileContent: "content",
    file_content: "content",
    fileContents: "content",
    file_contents: "content",
    fileText: "content",
    file_text: "content",
  },
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

export function remapCommonToolArgAliases(
  toolName: string,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; remapped: boolean } {
  const aliases = CLAUDE_CODE_PARAM_ALIASES[toolName] ?? CLAUDE_CODE_PARAM_ALIASES[canonicalValidationToolName(toolName)];
  if (!aliases) return { input, remapped: false };

  let remapped = false;
  const result: Record<string, unknown> = { ...input };
  for (const [alias, correctName] of Object.entries(aliases)) {
    if (alias === correctName || !(alias in input)) continue;

    if (!hasUsableToolArg(result[correctName]) && hasUsableToolArg(input[alias])) {
      result[correctName] = input[alias];
    }
    delete result[alias];
    remapped = true;
  }
  return { input: result, remapped };
}

function hasUsableToolArg(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/** Stable full-argument identity: retain case, offsets, URLs and edit content. */
export function fingerprintToolCall(call: RecentToolCall): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical({ tool: call.toolName, path: call.filePath, args: call.args }))).digest("hex");
}

const TOOL_CONTRACT_GUIDANCE = [
  "Use the offered tool names and schemas, including their path and approval semantics.",
  "Inspect existing content before targeted edits; new files may use the native write tool. Do not replace file tools with shell commands to evade schema errors.",
  "After a failed call, inspect the error and correct its cause. Successful reads, task updates and distinct edits are progress, not evidence of a loop.",
].join("\n");

/** Nudge only when repeated identical calls have explicit failure evidence. */
function repeatedFailurePrompt(calls: RecentToolCall[], options: QwenPivotOptions = {}): string | null {
  const threshold = Math.max(2, options.editRetryLimit ?? 3);
  if (calls.length < threshold) return null;
  const tail = calls.slice(-threshold);
  const fingerprint = fingerprintToolCall(tail[0]);
  if (!tail.every(call => fingerprintToolCall(call) === fingerprint)) return null;
  const failed = (content: string | undefined): boolean => {
    if (!content) return false;
    try {
      const result = JSON.parse(content) as Record<string, unknown>;
      if (!result || typeof result !== "object") return false;
      return result.is_error === true || result.isError === true || result.status === "failed" || result.status === "error"
        || (typeof result.exit_code === "number" && result.exit_code !== 0);
    } catch {
      return /^(?:Error:|File not found:|No such file or directory|ENOENT\b|ValidationError:)/im.test(content);
    }
  };
  if (!tail.every(call => failed(call.resultContent))) return null;
  return "The same tool call returned an explicit failure repeatedly. Inspect the latest error and current tool schema, then change the failing arguments or report the blocker. Do not repeat the unchanged failed call.";
}

class SchemaDrivenAdapter implements ModelAdapter {
  readonly family: string;
  readonly supportsThinking: boolean;
  constructor(family: string, supportsThinking = true) {
    this.family = family;
    this.supportsThinking = supportsThinking;
  }
  toolSystemPrompt(toolCount: number): string | undefined {
    return toolCount > 0 ? TOOL_CONTRACT_GUIDANCE : undefined;
  }
  normalizeToolCallArgs(args: string): string {
    return args.trim(); // malformed or missing JSON is not proof of an empty object
  }
  remapToolArgs(toolName: string, input: Record<string, unknown>) {
    return remapCommonToolArgAliases(toolName, input);
  }
  getEarlyPivotPrompt(calls: RecentToolCall[], options: QwenPivotOptions = {}): string | null {
    return repeatedFailurePrompt(calls, options);
  }
  dampenConsecutiveSameTools(_names: string[]): string | null {
    return null; // tool names alone cannot establish failure or stagnation
  }
  enrichToolDescription(_toolName: string, description: string): string {
    return description; // the native schema/description already defines the tool
  }
}

export class Qwen3CoderAdapter extends SchemaDrivenAdapter {
  /** Explicit deployment hint only; never inferred from a URL. */
  readonly nativeToolParser: boolean;
  constructor(nativeToolParser = false, readonly variant: "original" | "next" = "original") {
    super("qwen3-coder", false);
    this.nativeToolParser = nativeToolParser;
  }
  defaultSamplingParams(): { temperature: number; top_p: number } {
    return { temperature: this.variant === "next" ? 1.0 : 0.7, top_p: 0.95 };
  }
}

export class GenericOpenAIAdapter implements ModelAdapter {
  constructor(readonly family = "generic", readonly supportsThinking = true) {}
}

export function adapterUsesToolLoopSteering(family: string): boolean {
  return ["qwen3-coder", "qwen", "kimi", "minimax", "xiaomi", "deepseek", "glm"].includes(family);
}

export class KimiAdapter extends SchemaDrivenAdapter {
  constructor() { super("kimi"); }
  // Thinking vs instant modes have different recommendations. Let the endpoint
  // select defaults unless the caller/deployment supplies sampling parameters.
  defaultSamplingParams(): undefined { return undefined; }
}
export class MiniMaxAdapter extends SchemaDrivenAdapter {
  constructor() { super("minimax"); }
}
export class XiaomiMiMoAdapter extends SchemaDrivenAdapter {
  constructor() { super("xiaomi"); }
  defaultSamplingParams(): undefined { return undefined; }
}

export class ClaudeAdapter implements ModelAdapter {
  readonly family = "claude";
  readonly supportsThinking = true;

  cacheMarkerBackend(): CacheMarkerBackend {
    return "anthropic";
  }
}

export class DeepSeekAdapter extends SchemaDrivenAdapter {
  constructor() { super("deepseek"); }
}

/** Repair an unambiguous command alias without inventing executable content. */
export function repairBashToolCall(
  toolName: string,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; repaired: boolean } | null {
  if (canonicalValidationToolName(toolName) !== "Bash") return null;
  if (typeof input.command === "string") return null;
  // Only documented command aliases; never execute an arbitrary stray value.
  const aliases = ["cmd", "shell_command", "bash_command"];
  const present = aliases.filter(key => typeof input[key] === "string");
  if (present.length !== 1) return null;
  const out: Record<string, unknown> = { ...input, command: input[present[0]] };
  delete out[present[0]];
  return { input: out, repaired: true };
}

export function repairWriteToolCall(
  _toolName: string,
  _input: Record<string, unknown>,
): { rewrittenToolName: string; rewrittenInput: Record<string, unknown> } | null {
  // Short files are valid. Converting Write to Bash changes cwd resolution,
  // permissions and tool availability; let the offered tool validate its input.
  return null;
}

/** Arrays are not file content. Preserve invalid input for schema validation. */
export function repairWriteContentArray(
  _toolName: string,
  _input: Record<string, unknown>,
): { input: Record<string, unknown>; repaired: boolean } | null {
  return null;
}

export function normalizeFileToolArgs(
  toolName: string,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; normalized: boolean } {
  if (!["Write", "Read", "Edit", "Update"].includes(canonicalValidationToolName(toolName))) {
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
 * Retained compatibility entry point. A proxy cannot infer a client's file-tool
 * root or filesystem from its own OS. Preserve target identity; the configured
 * path sandbox and the execution host validate access, rather than relocating it.
 */
export function constrainFileToolPathToProjectRoot(
  _projectRoot: string | null | undefined,
  _toolName: string,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; constrained: boolean } {
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
  const required = requiredByTool[canonicalValidationToolName(toolName)];
  if (!required) return { valid: true, missing: [] };

  const alternates: Record<string, string[]> = {
    glob_pattern: ["pattern"],
  };
  const missing = required.filter((k) => {
    const v = input[k];
    if (typeof v === "string") return v.trim().length > 0 ? false : true;
    const alts = alternates[k];
    if (alts) {
      for (const alt of alts) {
        const av = input[alt];
        if (typeof av === "string" && av.trim().length > 0) return false;
      }
    }
    return true;
  });
  return { valid: missing.length === 0, missing };
}

/** @deprecated Host-looking paths are legitimate client paths; never relocate them. */
export function normalizeHallucinatedLinuxWritePath(filePath: string): string {
  return filePath;
}

/** Preserve path identity, including UNC paths, POSIX backslashes and repeated names. */
export function normalizeWorkspaceRelativeFilePath(filePath: string): string {
  return filePath;
}

export const KNOWN_ADAPTER_FAMILIES = [
  "qwen3-coder", "qwen3-coder-next", "qwen", "glm", "claude", "deepseek", "kimi", "minimax", "xiaomi", "generic",
] as const;
export type AdapterFamily = (typeof KNOWN_ADAPTER_FAMILIES)[number];

/**
 * Resolve adapter from the backend model name (e.g. "Qwen/Qwen3-Coder-480B-A35B-Instruct").
 * When `adapterHint` is set (from admin Model Registry), it overrides regex auto-detection.
 * Otherwise pattern-matches against known model families. Falls back to GenericOpenAIAdapter.
 */
export function resolveAdapter(backendModel: string, _baseUrl?: string, adapterHint?: string | null): ModelAdapter {
  const hint = (adapterHint ?? "").trim().toLowerCase();
  if (hint && (KNOWN_ADAPTER_FAMILIES as readonly string[]).includes(hint)) {
    return resolveByFamily(hint as AdapterFamily, backendModel);
  }
  const m = backendModel.toLowerCase();
  if (/qwen3.*coder/i.test(m)) return new Qwen3CoderAdapter(false, /coder-next/.test(m) ? "next" : "original");
  if (/qwen3/.test(m)) return new SchemaDrivenAdapter("qwen");
  if (/glm[-_.]?[45]/.test(m)) return new SchemaDrivenAdapter("glm");
  if (/claude|anthropic/i.test(m)) return new ClaudeAdapter();
  if (/deepseek/i.test(m)) return new DeepSeekAdapter();
  if (/kimi|moonshot|k2[.-]?[567]/i.test(m)) return new KimiAdapter();
  if (/minimax|abab/i.test(m)) return new MiniMaxAdapter();
  if (/xiaomi|mimo/i.test(m)) return new XiaomiMiMoAdapter();
  return new GenericOpenAIAdapter("generic");
}

function resolveByFamily(family: AdapterFamily, backendModel?: string): ModelAdapter {
  switch (family) {
    case "qwen3-coder": return new Qwen3CoderAdapter(false, /coder-next/i.test(backendModel ?? "") ? "next" : "original");
    case "qwen3-coder-next": return new Qwen3CoderAdapter(false, "next");
    case "qwen": return new SchemaDrivenAdapter("qwen");
    case "glm": return new SchemaDrivenAdapter("glm");
    case "claude": return new ClaudeAdapter();
    case "deepseek": return new DeepSeekAdapter();
    case "kimi": return new KimiAdapter();
    case "minimax": return new MiniMaxAdapter();
    case "xiaomi": return new XiaomiMiMoAdapter();
    case "generic": return new GenericOpenAIAdapter("generic");
  }
}
