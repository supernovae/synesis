import { jsonSchema } from "ai";
import type { ToolSet, Tool, ModelMessage } from "ai";

interface OpenAIChatMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type?: string;
    function?: { name: string; arguments: string };
  }>;
}

let synthCounter = 0;

/**
 * Repair malformed tool_calls in conversation history so strict providers
 * (e.g. DeepInfra) don't reject the request with 422.
 *
 * Fixes: empty tool-call IDs, missing function.arguments, and propagates
 * synthetic IDs to the matching tool-result messages that follow.
 */
export function sanitizeToolCalls(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  const pendingEmptyIdQueue: string[] = [];

  const validToolCallIds = new Set<string>();
  let availableEmptyToolMessages = 0;

  for (const m of messages) {
    if (m.role === "tool") {
      if (m.tool_call_id) {
        validToolCallIds.add(m.tool_call_id);
      } else {
        availableEmptyToolMessages++;
      }
    }
  }

  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      let changed = false;
      const fixedCalls = [];

      for (const tc of m.tool_calls) {
        let id = tc.id;
        if (!id) {
          if (availableEmptyToolMessages > 0) {
            availableEmptyToolMessages--;
            id = `call_synth_${++synthCounter}_${Date.now().toString(36)}`;
            pendingEmptyIdQueue.push(id);
            changed = true;
          } else {
            changed = true;
            continue;
          }
        } else if (!validToolCallIds.has(id)) {
          changed = true;
          continue;
        }

        const fn = tc.function;
        const args = fn?.arguments ?? "{}";
        const name = fn?.name ?? "";
        if (!fn || fn.arguments === undefined) changed = true;

        fixedCalls.push({
          id,
          type: tc.type ?? "function",
          function: { name, arguments: args },
        });
      }

      if (fixedCalls.length === 0) {
        const { tool_calls, ...rest } = m;
        out.push(rest);
      } else {
        out.push(changed ? { ...m, tool_calls: fixedCalls } : m);
      }
      continue;
    }

    if (m.role === "tool" && !m.tool_call_id && pendingEmptyIdQueue.length > 0) {
      out.push({ ...m, tool_call_id: pendingEmptyIdQueue.shift()! });
      continue;
    }

    out.push(m);
  }

  return out;
}

/**
 * Convert raw OpenAI chat-format messages into the Vercel AI SDK ModelMessage
 * format that generateText / streamText accept directly.
 *
 * This replaces convertToModelMessages (which expects the SDK's own UI format
 * with `.parts` arrays and crashes on raw OpenAI payloads).
 */
export function openAIMessagesToModelMessages(messages: OpenAIChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        out.push({ role: "system", content: String(m.content ?? "") });
        break;
      case "user":
        out.push({ role: "user", content: String(m.content ?? "") });
        break;
      case "assistant": {
        const parts: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }> = [];
        const text = typeof m.content === "string" ? m.content : "";
        if (text) parts.push({ type: "text", text });
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            let parsedInput: unknown = {};
            try { parsedInput = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* keep {} */ }
            parts.push({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: tc.function?.name ?? "",
              input: parsedInput
            });
          }
        }
        if (parts.length === 0) parts.push({ type: "text", text: "" });
        out.push({ role: "assistant", content: parts } as ModelMessage);
        break;
      }
      case "tool": {
        const resultContent = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
        out.push({
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: m.tool_call_id ?? "",
            toolName: m.name ?? "",
            output: { type: "text" as const, value: resultContent }
          }]
        } as ModelMessage);
        break;
      }
      default:
        out.push({ role: "user", content: String(m.content ?? "") });
    }
  }
  return out;
}

interface OpenAITool {
  type?: string;
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface ClaudeTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface ClaudeContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
}

export function openAIToolsToSDK(tools: OpenAITool[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const out: ToolSet = {};
  for (const t of tools) {
    const fn = t.function;
    if (!fn?.name) continue;
    out[fn.name] = {
      description: fn.description ?? "",
      inputSchema: jsonSchema(fn.parameters ?? { type: "object", properties: {} })
    } as Tool;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function claudeToolsToSDK(tools: ClaudeTool[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const out: ToolSet = {};
  for (const t of tools) {
    if (!t.name) continue;
    out[t.name] = {
      description: t.description ?? "",
      inputSchema: jsonSchema(t.input_schema ?? { type: "object", properties: {} })
    } as Tool;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mapToolChoice(choice: unknown): "auto" | "none" | "required" | { type: "tool"; toolName: string } | undefined {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === "string") {
    if (choice === "auto" || choice === "none" || choice === "required") return choice;
    if (choice === "any") return "required";
    return "auto";
  }
  if (typeof choice === "object") {
    const obj = choice as Record<string, unknown>;
    if (obj.type === "tool" && typeof obj.name === "string") {
      return { type: "tool", toolName: obj.name };
    }
    if (obj.type === "function" && typeof (obj.function as Record<string, unknown>)?.name === "string") {
      return { type: "tool", toolName: (obj.function as Record<string, unknown>).name as string };
    }
    if (obj.type === "auto") return "auto";
    if (obj.type === "none") return "none";
    if (obj.type === "any" || obj.type === "required") return "required";
  }
  return "auto";
}

interface SDKToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export function sdkToolCallsToOpenAI(toolCalls: SDKToolCall[]): Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> {
  return toolCalls.map((tc) => ({
    id: tc.toolCallId,
    type: "function" as const,
    function: {
      name: tc.toolName,
      arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input)
    }
  }));
}

export function sdkToolCallsToClaude(toolCalls: SDKToolCall[]): ClaudeContentBlock[] {
  return toolCalls.map((tc) => ({
    type: "tool_use",
    id: tc.toolCallId,
    name: tc.toolName,
    input: tc.input
  }));
}

interface ClaudeMessage {
  role: string;
  content: string | ClaudeContentBlock[];
}

type ReduceToolResultFn = (content: unknown, toolName?: string) => string;

export function claudeMessagesToOpenAI(
  messages: ClaudeMessage[],
  reduceToolResult?: ReduceToolResultFn
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) {
      out.push({ role: m.role, content: JSON.stringify(m.content) });
      continue;
    }
    const textParts: string[] = [];
    const toolUseParts: ClaudeContentBlock[] = [];
    const toolResultParts: ClaudeContentBlock[] = [];

    for (const block of m.content) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolUseParts.push(block);
      } else if (block.type === "tool_result") {
        toolResultParts.push(block);
      } else {
        textParts.push(JSON.stringify(block));
      }
    }

    if (textParts.length > 0 || toolUseParts.length > 0) {
      const combined = textParts.join("\n");
      if (toolUseParts.length > 0) {
        const toolCalls = toolUseParts.map((tu) => ({
          id: tu.id ?? "",
          type: "function" as const,
          function: {
            name: tu.name ?? "",
            arguments: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input ?? {})
          }
        }));
        out.push({
          role: "assistant",
          content: combined || undefined,
          tool_calls: toolCalls
        });
      } else {
        out.push({ role: m.role, content: combined });
      }
    }

    for (const tr of toolResultParts) {
      const baseResultContent = typeof tr.content === "string"
        ? tr.content
        : JSON.stringify(tr.content ?? "");
      const resultContent = reduceToolResult
        ? reduceToolResult(baseResultContent, tr.name)
        : baseResultContent;
      out.push({
        role: "tool",
        content: resultContent,
        tool_call_id: tr.tool_use_id ?? "",
        name: tr.name
      });
    }
  }
  return out;
}

export interface LegacyInlineToolCallParse {
  toolName: string;
  input: Record<string, unknown>;
  cleanText: string;
}

/**
 * Some models emit legacy inline tool-call markup in plain text, e.g.
 * <function=Glob>
 * <parameter=pattern>
 * ** / *   (without spaces)
 * Parse this format so callers can recover a structured tool call instead of
 * surfacing raw gibberish to the end user.
 */
export function parseLegacyInlineToolCall(text: string): LegacyInlineToolCallParse | null {
  const raw = String(text ?? "");
  const fnMatch = raw.match(/<function=([A-Za-z0-9_.-]+)>/i);
  if (!fnMatch) return null;

  const toolName = fnMatch[1]?.trim();
  if (!toolName) return null;

  const afterFn = raw.slice((fnMatch.index ?? 0) + fnMatch[0].length);
  const input: Record<string, unknown> = {};
  const paramRe = /<parameter=([A-Za-z0-9_.-]+)>\s*([\s\S]*?)(?=<parameter=[A-Za-z0-9_.-]+>|$)/gi;
  let m: RegExpExecArray | null = null;
  while ((m = paramRe.exec(afterFn)) !== null) {
    const key = String(m[1] ?? "").trim();
    let val = String(m[2] ?? "").trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) input[key] = val;
  }

  const cleanText = raw.replace(/<function=[A-Za-z0-9_.-]+>[\s\S]*$/i, "").trim();
  return { toolName, input, cleanText };
}
