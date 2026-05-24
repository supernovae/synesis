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
  if (typeof input.reasoning === "string" && input.reasoning.length > 0) {
    message.reasoning_content = input.reasoning;
  }
  if (input.toolCalls.length > 0) {
    const clientToolCalls = input.toolCalls.map((call) =>
      restoreGuardrailCallForClient(call, input.effectiveTools, input.clientKind),
    );
    message.tool_calls = sdkToolCallsToOpenAI(clientToolCalls);
  }
  return message;
}
