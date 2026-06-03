export interface PlannerSessionKeyInput {
  conversation_id?: string | null;
}

export function resolveSupportHandle(input: { authzTraceId?: string | null; runId?: string | null }): string | undefined {
  return optionalString(input.authzTraceId) ?? optionalString(input.runId);
}

export function withSupportHandleHint(
  message: string,
  input: { authzTraceId?: string | null; runId?: string | null },
): string {
  const supportHandle = resolveSupportHandle(input);
  if (!supportHandle || message.includes(supportHandle)) return message;
  return `${message} (support id: ${supportHandle})`;
}

export function resolvePlannerSessionKey(
  requestBody: PlannerSessionKeyInput,
  requestId: string,
): { sessionKey: string; source: "conversation_id" | "ephemeral_request" } {
  const conversationId = (requestBody.conversation_id ?? "").trim();
  if (conversationId.length > 0) {
    return { sessionKey: `conversation:${conversationId}`, source: "conversation_id" };
  }
  return { sessionKey: `ephemeral:${requestId}`, source: "ephemeral_request" };
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s.length > 0 ? s : undefined;
}
