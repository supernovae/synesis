import { describe, expect, it } from "vitest";
import {
  applySessionTaskCapabilities,
  buildProtocolSessionIdentity,
  runProtocolSessionBootstrap,
  shouldReplaceSessionTaskCapabilities,
} from "../src/session/protocol-session.js";
import type { ClientTaskCapabilities } from "../src/task-ledger/types.js";

function caps(overrides: Partial<ClientTaskCapabilities> = {}): ClientTaskCapabilities {
  return {
    hasExplicitTodoTool: false,
    hasExplicitPlanMode: false,
    todoToolName: null,
    detectedSource: "unknown",
    ...overrides,
  };
}

describe("protocol session utilities", () => {
  it("builds the shared protocol session identity from authenticated user context", () => {
    expect(buildProtocolSessionIdentity({
      authUser: {
        userId: "auth-user",
        orgId: "org-1",
        displayName: "Auth User",
      },
      userId: "session-user",
      conversationId: "conversation-1",
      clientKind: "claude-code",
      displayName: "Display User",
    })).toEqual({
      userId: "session-user",
      orgId: "org-1",
      conversationId: "conversation-1",
      clientKind: "claude-code",
      displayName: "Display User",
    });
  });

  it("preserves existing explicit task capabilities unless new explicit support is detected", () => {
    const current = caps({
      hasExplicitTodoTool: true,
      todoToolName: "TodoWrite",
      detectedSource: "opencode_todowrite",
    });

    expect(shouldReplaceSessionTaskCapabilities(current, caps())).toBe(false);
    expect(shouldReplaceSessionTaskCapabilities(current, caps({
      hasExplicitPlanMode: true,
      detectedSource: "claude_todowrite",
    }))).toBe(true);
  });

  it("applies task capabilities only when the shared replacement policy allows it", () => {
    const state = {
      taskCapabilities: caps(),
    };
    const explicit = caps({
      hasExplicitTodoTool: true,
      todoToolName: "task_update",
      detectedSource: "claude_todowrite",
    });

    expect(applySessionTaskCapabilities(state, explicit)).toBe(true);
    expect(state.taskCapabilities).toBe(explicit);
    expect(applySessionTaskCapabilities(state, caps())).toBe(false);
    expect(state.taskCapabilities).toBe(explicit);
  });

  it("bootstraps session state, attribution, hook, and runtime preferences in route order", async () => {
    const calls: string[] = [];
    const session = { attributed: false };
    const identity = buildProtocolSessionIdentity({
      authUser: { userId: "user-1", orgId: "org-1" },
      conversationId: "conversation-1",
      clientKind: "opencode",
    });

    const result = await runProtocolSessionBootstrap({
      identity,
      authUser: {
        authMethod: "pat",
        authKeyId: "key-1",
        authKeyName: "Key",
        authKeyPrefix: "syn",
      },
      getSessionKey: async (receivedIdentity) => {
        calls.push(`key:${receivedIdentity.clientKind}`);
        return "session-key-1";
      },
      getSessionState: async (sessionKey, receivedIdentity) => {
        calls.push(`state:${sessionKey}:${receivedIdentity.conversationId}`);
        return session;
      },
      applyAuthKeyAttribution: (receivedSession, authUser) => {
        calls.push(`auth:${authUser.authMethod}`);
        receivedSession.attributed = true;
      },
      afterSessionLoaded: async ({ sessionKey, session: loadedSession }) => {
        calls.push(`hook:${sessionKey}:${loadedSession.attributed}`);
      },
      loadRuntimePreferences: async (orgId, userId) => {
        calls.push(`prefs:${orgId}:${userId}`);
        return { mode: "test" };
      },
      debugEnabled: true,
      debugConversationSource: "conversation_resolved",
      debugFallbackSource: "conversation_fallback",
      debugLog: (record) => {
        calls.push(`debug:${record.source}:${record.sessionKey}`);
      },
    });

    expect(result).toEqual({
      sessionKey: "session-key-1",
      session,
      runtimePreferences: { mode: "test" },
    });
    expect(calls).toEqual([
      "key:opencode",
      "debug:conversation_resolved:session-key-1",
      "state:session-key-1:conversation-1",
      "auth:pat",
      "hook:session-key-1:true",
      "prefs:org-1:user-1",
    ]);
  });

  it("uses the fallback debug source when conversation id is implicit", async () => {
    const debugRecords: Array<{ source: string; conversationId: string }> = [];

    await runProtocolSessionBootstrap({
      identity: buildProtocolSessionIdentity({
        authUser: { userId: "user-1", orgId: "org-1" },
        conversationId: "",
        clientKind: "claude-code",
      }),
      authUser: { authMethod: "bearer" },
      getSessionKey: async () => "session-key-implicit",
      getSessionState: async () => ({}),
      applyAuthKeyAttribution: () => undefined,
      loadRuntimePreferences: async () => null,
      debugEnabled: true,
      debugConversationSource: "metadata",
      debugFallbackSource: "fallback",
      debugLog: (record) => {
        debugRecords.push({
          source: record.source,
          conversationId: record.conversationId,
        });
      },
    });

    expect(debugRecords).toEqual([{ source: "fallback", conversationId: "" }]);
  });
});
