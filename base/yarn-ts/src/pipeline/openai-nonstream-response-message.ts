import { sdkToolCallsToOpenAI } from "../tool-mapping.js";
import { restoreGuardrailCallForClient, type GuardrailToolCall } from "../tools/tool-call-availability.js";

export interface OpenAINonStreamAssistantMessageInput {
  finalText: string;
  reasoning?: unknown;
  toolCalls: GuardrailToolCall[];
  effectiveTools: unknown[];
  clientKind: string;
}

export function buildOpenAINonStreamAssistantMessage(
  input: OpenAINonStreamAssistantMessageInput,
): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: input.finalText };
  const reasoning = typeof input.reasoning === "string" ? input.reasoning
    : Array.isArray(input.reasoning) ? input.reasoning.filter(part => part?.type === "reasoning" && typeof part.text === "string").map(part => part.text).join("") : "";
  if (reasoning.length > 0) message.reasoning_content = reasoning;
  if (input.toolCalls.length > 0) {
    const clientToolCalls = input.toolCalls.map((call) =>
      restoreGuardrailCallForClient(call, input.effectiveTools, input.clientKind),
    );
    message.tool_calls = sdkToolCallsToOpenAI(clientToolCalls);
  }
  return message;
}
