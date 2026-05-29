export interface SessionIdentity {
  userId: string;
  orgId: string;
  conversationId: string;
  clientKind: string;
  displayName?: string;
  forceFreshImplicitSession?: boolean;
  freshImplicitSessionReason?: string;
  freshImplicitMessageCount?: number;
  sessionRequestId?: string;
}

export interface SessionKeyRecord {
  sessionKey: string;
  lastActiveAt: number;
}

export interface ResolveSessionKeyOptions {
  identity: SessionIdentity;
  nowMs: number;
  inactivityRotationMs: number;
  activeByBaseKey: Map<string, string>;
  loadRecord: (sessionKey: string) => Promise<SessionKeyRecord | null>;
  loadActiveSessionKey: (baseKey: string) => Promise<string | null>;
  saveActiveSessionKey: (baseKey: string, sessionKey: string) => Promise<void>;
}

export interface SessionKeyDecision {
  baseKey: string;
  sessionKey: string;
  reason: "explicit_conversation" | "active_alias" | "new_implicit_conversation" | "fresh_implicit_rotation";
  rotated: boolean;
  previousSessionKey?: string | null;
}

export function buildSessionKey(userId: string, clientKind: string, conversationId: string): string {
  const user = userId || "anon";
  const client = clientKind || "unknown";
  const convo = conversationId || "_";
  return `synesis:${user}:${client}:${convo}`;
}

export function hasExplicitConversationId(conversationId: string): boolean {
  return conversationId.trim().length > 0;
}

function messageText(message: { content?: unknown }): string {
  const visit = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(visit).filter(Boolean).join("\n");
    if (!value || typeof value !== "object") return "";
    const row = value as Record<string, unknown>;
    return visit(row.text ?? row.content ?? "");
  };
  return visit(message.content).trim();
}

function assistantMessageHasPayload(message: { content?: unknown; tool_calls?: unknown }): boolean {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  return messageText(message).length > 0;
}

function isFreshClientTranscript(messages: Array<{ role?: unknown; content?: unknown; tool_calls?: unknown }>): boolean {
  if (messages.length === 0) return false;
  let hasUser = false;
  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role.trim().toLowerCase() : "";
    if (role === "user") hasUser = true;
    if (role === "assistant" && assistantMessageHasPayload(message)) return false;
    if (role === "tool" || role === "tool_result" || role === "function") return false;
  }
  return hasUser;
}

export function isCoderClientKind(clientKind: string): boolean {
  const c = clientKind.trim().toLowerCase();
  if (!c) return false;
  return [
    "opencode",
    "claude-code",
    "codex",
    "cursor",
    "goose",
    "aider",
    "continue",
    "cline",
    "roo",
    "windsurf",
    "zed",
    "jetbrains",
    "gemini-cli",
    "synesis-acp",
  ].some((needle) => c.includes(needle));
}

export interface FreshImplicitSessionStart {
  fresh: boolean;
  reason: "fresh_transcript" | "fresh_command" | "not_fresh" | "explicit_conversation" | "non_coder_client";
}

export function detectFreshImplicitSessionStart(options: {
  clientKind: string;
  conversationId: string;
  messages: Array<{ role?: unknown; content?: unknown; tool_calls?: unknown }>;
}): FreshImplicitSessionStart {
  if (hasExplicitConversationId(options.conversationId)) return { fresh: false, reason: "explicit_conversation" };
  if (!isCoderClientKind(options.clientKind)) return { fresh: false, reason: "non_coder_client" };
  const latestUser = [...options.messages]
    .reverse()
    .find((message) => String(message.role ?? "").trim().toLowerCase() === "user");
  if (latestUser && /^\/new(?:\s|$)/i.test(messageText(latestUser))) {
    return { fresh: true, reason: "fresh_command" };
  }
  if (isFreshClientTranscript(options.messages)) return { fresh: true, reason: "fresh_transcript" };
  return { fresh: false, reason: "not_fresh" };
}

export function shouldResetImplicitSessionForFreshTranscript(options: {
  clientKind: string;
  conversationId: string;
  messages: Array<{ role?: unknown; content?: unknown; tool_calls?: unknown }>;
  hasPersistedState: boolean;
}): boolean {
  if (!options.hasPersistedState) return false;
  return detectFreshImplicitSessionStart(options).fresh;
}

export function buildRotatedSessionKey(baseKey: string, nowMs: number): string {
  return `${baseKey}:r${nowMs}`;
}

export async function resolveSessionKey(options: ResolveSessionKeyOptions): Promise<SessionKeyDecision> {
  const baseKey = buildSessionKey(
    options.identity.userId,
    options.identity.clientKind,
    options.identity.conversationId,
  );
  if (hasExplicitConversationId(options.identity.conversationId)) {
    return { baseKey, sessionKey: baseKey, reason: "explicit_conversation", rotated: false };
  }

  const isActive = async (sessionKey: string): Promise<boolean> => {
    const record = await options.loadRecord(sessionKey);
    if (!record) return false;
    return options.nowMs - record.lastActiveAt <= options.inactivityRotationMs;
  };

  const remember = async (sessionKey: string): Promise<void> => {
    options.activeByBaseKey.set(baseKey, sessionKey);
    try {
      await options.saveActiveSessionKey(baseKey, sessionKey);
    } catch {
      // Best-effort durability only. The in-process alias still keeps the
      // current turn family isolated, and session writes will surface Redis
      // failures through the existing persistence path.
    }
  };

  if (options.identity.forceFreshImplicitSession) {
    const previousSessionKey = options.activeByBaseKey.get(baseKey) ?? await options.loadActiveSessionKey(baseKey);
    const rotated = buildRotatedSessionKey(baseKey, options.nowMs);
    await remember(rotated);
    return {
      baseKey,
      sessionKey: rotated,
      reason: previousSessionKey ? "fresh_implicit_rotation" : "new_implicit_conversation",
      rotated: true,
      previousSessionKey: previousSessionKey ?? null,
    };
  }

  const inMemoryAlias = options.activeByBaseKey.get(baseKey);
  if (inMemoryAlias && await isActive(inMemoryAlias)) {
    await remember(inMemoryAlias);
    return { baseKey, sessionKey: inMemoryAlias, reason: "active_alias", rotated: inMemoryAlias !== baseKey };
  }
  if (inMemoryAlias) {
    options.activeByBaseKey.delete(baseKey);
  }

  const persistedAlias = await options.loadActiveSessionKey(baseKey);
  if (persistedAlias && await isActive(persistedAlias)) {
    await remember(persistedAlias);
    return { baseKey, sessionKey: persistedAlias, reason: "active_alias", rotated: persistedAlias !== baseKey };
  }

  const rotated = buildRotatedSessionKey(baseKey, options.nowMs);
  await remember(rotated);
  return { baseKey, sessionKey: rotated, reason: "new_implicit_conversation", rotated: true };
}
