import { jsonSchema } from "ai";
import type { ToolSet, Tool } from "ai";

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
  args: unknown;
}

export function sdkToolCallsToOpenAI(toolCalls: SDKToolCall[]): Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> {
  return toolCalls.map((tc) => ({
    id: tc.toolCallId,
    type: "function" as const,
    function: {
      name: tc.toolName,
      arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args)
    }
  }));
}

export function sdkToolCallsToClaude(toolCalls: SDKToolCall[]): ClaudeContentBlock[] {
  return toolCalls.map((tc) => ({
    type: "tool_use",
    id: tc.toolCallId,
    name: tc.toolName,
    input: tc.args
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
): Array<{ role: string; content: string; tool_call_id?: string; name?: string }> {
  const out: Array<{ role: string; content: string; tool_call_id?: string; name?: string }> = [];
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
        out.push({
          role: "assistant",
          content: combined || "",
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
        tool_call_id: tr.tool_use_id ?? ""
      });
    }
  }
  return out;
}
