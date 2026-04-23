/**
 * Context Token Estimator
 *
 * Fast token estimation without tiktoken dependency.  Uses per-role character
 * multipliers derived from empirical sampling of Claude, GPT-4, and Kimi K2
 * tokenizers across typical coding-session content.
 *
 * Tool results (code, stack traces, JSON) compress to ~3.5 chars/token.
 * Assistant prose is ~4.2 chars/token.
 * System prompts with XML structure are ~3.8 chars/token.
 * User text is ~4.0 chars/token.
 *
 * The per-message overhead accounts for role tokens and message framing.
 */

export interface TokenEstimate {
  messageTokens: number;
  toolSchemaTokens: number;
  totalTokens: number;
  breakdown: {
    systemTokens: number;
    userTokens: number;
    assistantTokens: number;
    toolResultTokens: number;
  };
}

const CHARS_PER_TOKEN_SYSTEM = 3.8;
const CHARS_PER_TOKEN_USER = 4.0;
const CHARS_PER_TOKEN_ASSISTANT = 4.2;
const CHARS_PER_TOKEN_TOOL = 3.5;
const CHARS_PER_TOKEN_TOOL_SCHEMA = 3.2;

const PER_MESSAGE_OVERHEAD_TOKENS = 4;

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const block = item as Record<string, unknown>;
      if (typeof block.text === "string") total += block.text.length;
      else if (typeof block.content === "string") total += block.content.length;
      else if (typeof block.input === "string") total += block.input.length;
      else {
        try { total += JSON.stringify(block).length; } catch { /* skip */ }
      }
    }
    return total;
  }
  try { return JSON.stringify(content ?? "").length; } catch { return 0; }
}

function toolCallChars(message: Record<string, unknown>): number {
  const calls = message.tool_calls as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(calls)) return 0;
  let total = 0;
  for (const call of calls) {
    const fn = call.function as Record<string, unknown> | undefined;
    if (fn) {
      if (typeof fn.name === "string") total += fn.name.length;
      if (typeof fn.arguments === "string") total += fn.arguments.length;
    }
    if (typeof call.name === "string") total += call.name.length;
    if (typeof call.input === "string") total += call.input.length;
    else if (call.input && typeof call.input === "object") {
      try { total += JSON.stringify(call.input).length; } catch { /* skip */ }
    }
  }
  return total;
}

export function estimateTokens(
  messages: Array<{ role: string; content: unknown }>,
  tools?: unknown[],
): TokenEstimate {
  let systemTokens = 0;
  let userTokens = 0;
  let assistantTokens = 0;
  let toolResultTokens = 0;

  for (const msg of messages) {
    const chars = contentChars(msg.content)
      + toolCallChars(msg as Record<string, unknown>);
    const overhead = PER_MESSAGE_OVERHEAD_TOKENS;

    switch (msg.role) {
      case "system":
        systemTokens += Math.ceil(chars / CHARS_PER_TOKEN_SYSTEM) + overhead;
        break;
      case "user":
        userTokens += Math.ceil(chars / CHARS_PER_TOKEN_USER) + overhead;
        break;
      case "assistant":
        assistantTokens += Math.ceil(chars / CHARS_PER_TOKEN_ASSISTANT) + overhead;
        break;
      case "tool":
      case "tool_result":
        toolResultTokens += Math.ceil(chars / CHARS_PER_TOKEN_TOOL) + overhead;
        break;
      default:
        userTokens += Math.ceil(chars / CHARS_PER_TOKEN_USER) + overhead;
    }
  }

  const messageTokens = systemTokens + userTokens + assistantTokens + toolResultTokens;

  let toolSchemaTokens = 0;
  if (tools && tools.length > 0) {
    try {
      const schemaChars = JSON.stringify(tools).length;
      toolSchemaTokens = Math.ceil(schemaChars / CHARS_PER_TOKEN_TOOL_SCHEMA);
    } catch { /* skip */ }
  }

  return {
    messageTokens,
    toolSchemaTokens,
    totalTokens: messageTokens + toolSchemaTokens,
    breakdown: {
      systemTokens,
      userTokens,
      assistantTokens,
      toolResultTokens,
    },
  };
}

export function estimateMessageTokens(
  message: { role: string; content: unknown },
): number {
  const chars = contentChars(message.content)
    + toolCallChars(message as Record<string, unknown>);
  const overhead = PER_MESSAGE_OVERHEAD_TOKENS;

  switch (message.role) {
    case "system":
      return Math.ceil(chars / CHARS_PER_TOKEN_SYSTEM) + overhead;
    case "assistant":
      return Math.ceil(chars / CHARS_PER_TOKEN_ASSISTANT) + overhead;
    case "tool":
    case "tool_result":
      return Math.ceil(chars / CHARS_PER_TOKEN_TOOL) + overhead;
    default:
      return Math.ceil(chars / CHARS_PER_TOKEN_USER) + overhead;
  }
}
