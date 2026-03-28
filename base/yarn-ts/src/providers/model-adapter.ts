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

  /** Provider options to pass to AI SDK (e.g., thinking config). */
  providerOptions?(): Record<string, Record<string, unknown>> | undefined;

  /** Whether this model supports thinking/reasoning blocks. */
  supportsThinking: boolean;

  /** Max tool definitions this model handles well (for future schema pruning). */
  maxEffectiveTools?: number;
}

export class Qwen3CoderAdapter implements ModelAdapter {
  readonly family = "qwen3-coder";
  readonly supportsThinking = false;
  readonly maxEffectiveTools = 40;

  toolSystemPrompt(toolCount: number): string | undefined {
    if (toolCount === 0) return undefined;
    return [
      "# Tool Calling Guidelines",
      "You have access to tools. When calling a tool, always provide the `arguments` field as a valid JSON object.",
      "If a tool requires no arguments, pass an empty object: `{}`.",
      "Do not omit the arguments field. Call one tool at a time unless explicitly asked to batch.",
    ].join("\n");
  }

  normalizeToolCallArgs(args: string): string {
    const trimmed = args.trim();
    if (!trimmed || trimmed === "null" || trimmed === "undefined") return "{}";
    return trimmed;
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
