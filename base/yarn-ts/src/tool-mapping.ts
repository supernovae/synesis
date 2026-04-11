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

function isReadLikeToolName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower === "read" || lower === "read_file" || lower === "readfile";
}

function isUnchangedReadStub(content: string): boolean {
  const lower = content.trim().toLowerCase();
  return lower.includes("unchanged since last read")
    || lower === "file unchanged"
    || lower === "unchanged";
}

export function claudeMessagesToOpenAI(
  messages: ClaudeMessage[],
  reduceToolResult?: ReduceToolResultFn
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  const toolUseById = new Map<string, ToolUseMeta>();
  const readContentByPath = new Map<string, string>();
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
      let effectiveResultContent = baseResultContent;
      if (isReadLikeToolName(String(toolName ?? ""))) {
        const filePath = toolMeta?.filePath;
        if (isUnchangedReadStub(baseResultContent) && filePath) {
          const cached = readContentByPath.get(filePath);
          if (cached) effectiveResultContent = cached;
        } else if (filePath && !isUnchangedReadStub(baseResultContent)) {
          readContentByPath.set(filePath, baseResultContent);
        }
      }
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

