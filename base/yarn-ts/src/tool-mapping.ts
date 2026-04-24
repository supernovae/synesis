import { jsonSchema } from "ai";
import type { ToolSet, Tool, ModelMessage } from "ai";
import { sortObjectKeys, stableJsonStringify } from "./compat/sorted-tools.js";

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

type SDKTextPart = { type: "text"; text: string };

function normalizeContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  return stableJsonStringify(content);
}

function contentBlocksToTextParts(content: unknown): SDKTextPart[] {
  if (!Array.isArray(content)) return [];
  const parts: SDKTextPart[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      const text = block.trim();
      if (text) parts.push({ type: "text", text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const row = block as Record<string, unknown>;
    const type = typeof row.type === "string" ? row.type : "";
    const blockText =
      typeof row.text === "string"
        ? row.text
        : (typeof row.content === "string" ? row.content : "");
    if (
      blockText
      && (type === "" || type === "text" || type === "input_text")
    ) {
      parts.push({ type: "text", text: blockText });
      continue;
    }
    // Keep unknown multimodal blocks visible to the model instead of lossy
    // [object Object] coercion.
    parts.push({ type: "text", text: stableJsonStringify(row) });
  }
  return parts;
}

function normalizeUserContent(content: unknown): string | SDKTextPart[] {
  if (typeof content === "string") return content;
  const parts = contentBlocksToTextParts(content);
  if (parts.length > 0) return parts;
  if (content === undefined || content === null) return "";
  return stableJsonStringify(content);
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  const parts = contentBlocksToTextParts(content);
  if (parts.length > 0) {
    return parts.map((p) => p.text).join("\n");
  }
  return "";
}

/**
 * Ensure all system messages are grouped at the beginning of the transcript.
 *
 * Some OpenAI-compatible gateways (including LiteLLM-backed providers) reject
 * requests when a system message appears after user/assistant/tool messages.
 * We preserve relative order within both groups:
 *   - system messages keep their original order
 *   - non-system messages keep their original order
 */
export function ensureSystemMessagesAtBeginning(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  if (messages.length < 2) return messages;

  let sawNonSystem = false;
  let hasLateSystem = false;
  for (const msg of messages) {
    if (msg.role === "system") {
      if (sawNonSystem) {
        hasLateSystem = true;
        break;
      }
    } else {
      sawNonSystem = true;
    }
  }

  if (!hasLateSystem) return messages;

  const systemMessages: OpenAIChatMessage[] = [];
  const nonSystemMessages: OpenAIChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") systemMessages.push(msg);
    else nonSystemMessages.push(msg);
  }
  return [...systemMessages, ...nonSystemMessages];
}

/**
 * Some strict gateways tolerate exactly one leading system message.
 * Merge contiguous leading system messages into a single equivalent block.
 */
export function coalesceLeadingSystemMessages(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  if (messages.length < 2) return messages;
  const out: OpenAIChatMessage[] = [];
  const leadingSystem: OpenAIChatMessage[] = [];
  let idx = 0;
  while (idx < messages.length && messages[idx]?.role === "system") {
    leadingSystem.push(messages[idx]!);
    idx++;
  }
  if (leadingSystem.length <= 1) return messages;
  const merged = leadingSystem
    .map((m) => normalizeContentToText(m.content))
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
  out.push({ role: "system", content: merged });
  for (let i = idx; i < messages.length; i++) out.push(messages[i]!);
  return out;
}

/**
 * Normalize system messages for providers that restrict where/how many
 * system-role messages may appear (e.g. MiniMax: exactly one, at the top).
 *
 * 1. Coalesces all leading system messages into a single system message.
 * 2. Converts any remaining mid-conversation system messages to user messages.
 *
 * Operates on ModelMessage[] (Vercel AI SDK format).
 */
export function demoteInlineSystemMessages<T extends { role: string; content: unknown }>(messages: T[]): T[] {
  if (messages.length < 2) return messages;

  function extractText(m: T): string {
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return (m.content as Array<{ type?: string; text?: string }>)
        .filter((b) => b?.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n");
    }
    return String(m.content ?? "");
  }

  const leadingSystem: T[] = [];
  let firstNonSystemIdx = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") {
      leadingSystem.push(messages[i]);
      firstNonSystemIdx = i + 1;
    } else {
      break;
    }
  }

  let needsWork = leadingSystem.length > 1;
  if (!needsWork) {
    for (let i = firstNonSystemIdx; i < messages.length; i++) {
      if (messages[i].role === "system") { needsWork = true; break; }
    }
  }
  if (!needsWork) return messages;

  const out: T[] = [];
  if (leadingSystem.length === 1) {
    out.push(leadingSystem[0]);
  } else if (leadingSystem.length > 1) {
    const merged = leadingSystem.map(extractText).filter((s) => s.trim()).join("\n\n");
    out.push({ ...leadingSystem[0], content: merged } as T);
  }
  for (let i = firstNonSystemIdx; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "system") {
      out.push(m);
    } else {
      out.push({
        ...m,
        role: "user",
        content: [{ type: "text", text: `[System note]\n${extractText(m)}` }],
      } as unknown as T);
    }
  }
  return out;
}

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
  const assistantToolCallIds = new Set<string>();
  let availableEmptyToolMessages = 0;

  for (const m of messages) {
    if (m.role === "tool") {
      if (m.tool_call_id) {
        validToolCallIds.add(m.tool_call_id);
      } else {
        availableEmptyToolMessages++;
      }
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        if (tc.id) {
          assistantToolCallIds.add(tc.id);
        }
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
            id = `call_synth_${++synthCounter}`;
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

    if (m.role === "tool") {
      if (!m.tool_call_id) {
        if (pendingEmptyIdQueue.length > 0) {
          out.push({ ...m, tool_call_id: pendingEmptyIdQueue.shift()! });
        }
        continue;
      }
      if (!assistantToolCallIds.has(m.tool_call_id)) {
        // Drop orphaned tool message
        continue;
      }
    }

    out.push(m);
  }

  const reorderedOut: OpenAIChatMessage[] = [];
  const toolMessagesById = new Map<string, OpenAIChatMessage>();

  for (const m of out) {
    if (m.role === "tool" && m.tool_call_id) {
      toolMessagesById.set(m.tool_call_id, m);
    }
  }

  for (const m of out) {
    if (m.role === "tool") {
      continue;
    }
    
    reorderedOut.push(m);
    
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        if (tc.id && toolMessagesById.has(tc.id)) {
          let toolMsg = toolMessagesById.get(tc.id)!;
          if (!toolMsg.name && tc.function?.name) {
            toolMsg = { ...toolMsg, name: tc.function.name };
          }
          reorderedOut.push(toolMsg);
          toolMessagesById.delete(tc.id);
        }
      }
    }
  }

  for (const m of toolMessagesById.values()) {
    reorderedOut.push(m);
  }

  return reorderedOut;
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
        out.push({ role: "system", content: normalizeContentToText(m.content) });
        break;
      case "user":
        out.push({ role: "user", content: normalizeUserContent(m.content) } as ModelMessage);
        break;
      case "assistant": {
        const parts: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }> = [];
        const text = extractAssistantText(m.content);
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
        if (parts.length === 0) {
          // Skip truly empty assistant messages — strict providers reject them.
          break;
        }
        out.push({ role: "assistant", content: parts } as ModelMessage);
        break;
      }
      case "tool": {
        const resultContent = typeof m.content === "string" ? m.content : stableJsonStringify(m.content ?? "");
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
        out.push({ role: "user", content: normalizeUserContent(m.content) } as ModelMessage);
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
  const ordered = [...tools].sort((a, b) => String(a.function?.name ?? "").localeCompare(String(b.function?.name ?? "")));
  for (const t of ordered) {
    const fn = t.function;
    if (!fn?.name) continue;
    out[fn.name] = {
      description: fn.description ?? "",
      inputSchema: jsonSchema(sortObjectKeys(fn.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>)
    } as Tool;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function claudeToolsToSDK(tools: ClaudeTool[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const out: ToolSet = {};
  const ordered = [...tools].sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
  for (const t of ordered) {
    if (!t.name) continue;
    out[t.name] = {
      description: t.description ?? "",
      inputSchema: jsonSchema(sortObjectKeys(t.input_schema ?? { type: "object", properties: {} }) as Record<string, unknown>)
    } as Tool;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mapToolChoice(choice: unknown): "auto" | "none" | "required" | { type: "tool"; toolName: string } | undefined {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === "string") {
    if (choice === "auto" || choice === "none" || choice === "required") return choice;
    if (choice === "any") return "required";
    return undefined;
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
  return undefined;
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

type ReduceToolResultFn = (content: unknown, toolName?: string, toolUseId?: string) => string;

interface ToolUseMeta {
  toolName: string;
  filePath?: string;
}

function extractToolUseFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const row = input as Record<string, unknown>;
  const p = typeof row.file_path === "string"
    ? row.file_path
    : (typeof row.path === "string" ? row.path : "");
  const v = p.trim();
  return v.length > 0 ? v : undefined;
}

export function claudeMessagesToOpenAI(
  messages: ClaudeMessage[],
  reduceToolResult?: ReduceToolResultFn
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  const toolUseById = new Map<string, ToolUseMeta>();
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
        const id = typeof block.id === "string" ? block.id.trim() : "";
        const toolName = typeof block.name === "string" ? block.name : "";
        if (id) {
          toolUseById.set(id, {
            toolName,
            filePath: extractToolUseFilePath(block.input),
          });
        }
        toolUseParts.push(block);
      } else if (block.type === "tool_result") {
        toolResultParts.push(block);
      } else {
        textParts.push(JSON.stringify(block));
      }
    }

    for (const tr of toolResultParts) {
      const toolUseId = typeof tr.tool_use_id === "string" ? tr.tool_use_id : "";
      const toolMeta = toolUseById.get(toolUseId);
      const toolName = tr.name ?? toolMeta?.toolName;
      const baseResultContent = typeof tr.content === "string"
        ? tr.content
        : JSON.stringify(tr.content ?? "");
      const effectiveResultContent = baseResultContent;
      const resultContent = reduceToolResult
        ? reduceToolResult(effectiveResultContent, toolName, toolUseId)
        : effectiveResultContent;
      out.push({
        role: "tool",
        content: resultContent,
        tool_call_id: toolUseId,
        name: toolName
      });
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
  }
  return out;
}

