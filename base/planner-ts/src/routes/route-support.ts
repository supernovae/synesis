import { createHash } from "node:crypto";

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
      sessionKey: `conversation:${identityScope(identity, requestId)}:${safeKeyPart(conversationId, "conversation")}`,
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
    return `anonymous:${safeKeyPart(requestId, "request")}`;
  }
  return [
    "principal",
    safeKeyPart(identity.orgId?.trim() ? identity.orgId : "_", "org"),
    safeKeyPart(identity.userId || "unknown", "user"),
  ].join(":");
}

function safeKeyPart(value: string, label: string): string {
  const trimmed = value.replace(/\0/g, "").trim();
  if (!trimmed) return label;
  if (!/^[A-Za-z0-9_.@-]+$/.test(trimmed)) {
    return `${label}-${createHash("sha256").update(trimmed).digest("hex").slice(0, 32)}`;
  }
  const encoded = encodeURIComponent(trimmed);
  if (encoded.length <= 160) return encoded;
  return `${label}-${createHash("sha256").update(trimmed).digest("hex").slice(0, 32)}`;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s.length > 0 ? s : undefined;
}
