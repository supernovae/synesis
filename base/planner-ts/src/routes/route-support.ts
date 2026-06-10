import { cacheKeyPart } from "@synesis/auth-contracts";

export interface PlannerSessionKeyInput {
  conversation_id?: string | null;
}

export interface PlannerSessionIdentity {
  userId: string;
  orgId?: string | null;
  authMethod: "anonymous" | "bearer" | "pat" | "internal_service";
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
  identity: PlannerSessionIdentity,
): { sessionKey: string; source: "conversation_id" | "ephemeral_request" } {
  const conversationId = (requestBody.conversation_id ?? "").trim();
  if (conversationId.length > 0) {
    return {
      sessionKey: `conversation:${identityScope(identity, requestId)}:${cacheKeyPart(conversationId, "conversation")}`,
      source: "conversation_id",
    };
  }
  return { sessionKey: `ephemeral:${requestId}`, source: "ephemeral_request" };
}

export function legacyPlannerConversationSessionKeys(conversationId: string): string[] {
  const normalized = conversationId.trim();
  if (!normalized) return [];
  return [`conversation:${normalized}`, normalized];
}

function identityScope(identity: PlannerSessionIdentity, requestId: string): string {
  if (identity.authMethod === "anonymous") {
    return `anonymous:${cacheKeyPart(requestId, "request")}`;
  }
  return [
    "principal",
    cacheKeyPart(identity.orgId?.trim() ? identity.orgId : "_", "org"),
    cacheKeyPart(identity.userId || "unknown", "user"),
  ].join(":");
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s.length > 0 ? s : undefined;
}
