export interface SessionIdentity {
  userId: string;
  orgId: string;
  conversationId: string;
  clientKind: string;
  displayName?: string;
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
  reason: "explicit_conversation" | "active_alias" | "new_implicit_conversation";
  rotated: boolean;
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

function isFreshClientTranscript(messages: Array<{ role?: unknown }>): boolean {
  if (messages.length === 0) return false;
  let hasUser = false;
  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role.trim().toLowerCase() : "";
    if (role === "user") hasUser = true;
    if (role === "assistant" || role === "tool") return false;
  }
  return hasUser;
}

export function shouldResetImplicitSessionForFreshTranscript(options: {
  clientKind: string;
  conversationId: string;
  messages: Array<{ role?: unknown }>;
  hasPersistedState: boolean;
}): boolean {
  if (hasExplicitConversationId(options.conversationId)) return false;
  if (!options.hasPersistedState) return false;
  const client = options.clientKind.trim().toLowerCase();
  if (!client.includes("opencode")) return false;
  return isFreshClientTranscript(options.messages);
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
