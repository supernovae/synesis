import type { AuthUser } from "../auth.js";
import type { ClientTaskCapabilities } from "../task-ledger/types.js";
import type { SessionIdentity } from "./session-key.js";

export interface BuildProtocolSessionIdentityInput {
  authUser: Pick<AuthUser, "userId" | "orgId" | "displayName">;
  conversationId: string;
  clientKind: string;
  userId?: string;
  displayName?: string;
  forceFreshImplicitSession?: boolean;
  freshImplicitSessionReason?: string;
  freshImplicitMessageCount?: number;
  sessionRequestId?: string;
}

export interface SessionTaskCapabilityState {
  taskCapabilities: ClientTaskCapabilities | null;
}

export interface ProtocolSessionBootstrapInput<TSession, TPreferences> {
  identity: SessionIdentity;
  authUser: Pick<AuthUser, "authMethod" | "authKeyId" | "authKeyName" | "authKeyPrefix">;
  getSessionKey: (identity: SessionIdentity) => Promise<string>;
  getSessionState: (sessionKey: string, identity: SessionIdentity) => Promise<TSession>;
  applyAuthKeyAttribution: (
    session: TSession,
    authUser: Pick<AuthUser, "authMethod" | "authKeyId" | "authKeyName" | "authKeyPrefix">,
  ) => void;
  loadRuntimePreferences: (userId: string) => Promise<TPreferences>;
  afterSessionLoaded?: (params: {
    sessionKey: string;
    session: TSession;
    identity: SessionIdentity;
  }) => void | Promise<void>;
  debugEnabled?: boolean;
  debugConversationSource: string;
  debugFallbackSource: string;
  debugLog?: (record: {
    sessionKey: string;
    source: string;
    conversationId: string;
    clientKind: string;
  }) => void;
}

export interface ProtocolSessionBootstrapResult<TSession, TPreferences> {
  sessionKey: string;
  session: TSession;
  runtimePreferences: TPreferences;
}

export function buildProtocolSessionIdentity(input: BuildProtocolSessionIdentityInput): SessionIdentity {
  return {
    userId: input.userId ?? input.authUser.userId,
    orgId: input.authUser.orgId,
    conversationId: input.conversationId,
    clientKind: input.clientKind,
    displayName: input.displayName ?? input.authUser.displayName,
    forceFreshImplicitSession: input.forceFreshImplicitSession,
    freshImplicitSessionReason: input.freshImplicitSessionReason,
    freshImplicitMessageCount: input.freshImplicitMessageCount,
    sessionRequestId: input.sessionRequestId,
  };
}

export function shouldReplaceSessionTaskCapabilities(
  current: ClientTaskCapabilities | null,
  detected: ClientTaskCapabilities,
): boolean {
  return (
    !current
    || detected.hasExplicitTodoTool
    || detected.hasExplicitPlanMode
    || (!current.hasExplicitTodoTool && !current.hasExplicitPlanMode)
  );
}

export function applySessionTaskCapabilities(
  state: SessionTaskCapabilityState,
  detected: ClientTaskCapabilities,
): boolean {
  if (!shouldReplaceSessionTaskCapabilities(state.taskCapabilities, detected)) {
    return false;
  }
  state.taskCapabilities = detected;
  return true;
}

export async function runProtocolSessionBootstrap<TSession, TPreferences>(
  input: ProtocolSessionBootstrapInput<TSession, TPreferences>,
): Promise<ProtocolSessionBootstrapResult<TSession, TPreferences>> {
  const sessionKey = await input.getSessionKey(input.identity);
  if (input.debugEnabled) {
    input.debugLog?.({
      sessionKey,
      source: input.identity.conversationId ? input.debugConversationSource : input.debugFallbackSource,
      conversationId: input.identity.conversationId,
      clientKind: input.identity.clientKind,
    });
  }

  const session = await input.getSessionState(sessionKey, input.identity);
  input.applyAuthKeyAttribution(session, input.authUser);
  await input.afterSessionLoaded?.({ sessionKey, session, identity: input.identity });
  const runtimePreferences = await input.loadRuntimePreferences(input.identity.userId);
  return { sessionKey, session, runtimePreferences };
}
