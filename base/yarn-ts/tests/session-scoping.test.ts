import { describe, expect, it, vi, afterEach } from "vitest";
import crypto from "node:crypto";

vi.mock("ioredis", () => {
  const store = new Map<string, string>();
  class MockRedis {
    get = vi.fn((key: string) => Promise.resolve(store.get(key) ?? null));
    set = vi.fn((...args: unknown[]) => {
      const key = args[0] as string;
      const val = args[1] as string;
      store.set(key, val);
      return Promise.resolve("OK");
    });
    eval = vi.fn((...args: unknown[]) => {
      const key = args[2] as string;
      const data = args[4] as string;
      store.set(key, data);
      return Promise.resolve(1);
    });
    quit = vi.fn().mockResolvedValue(undefined);
  }
  return {
    Redis: MockRedis,
    __store: store,
  };
});

vi.mock("pg", () => {
  class MockPool {
    queries: Array<{ sql: string; params: unknown[] }> = [];
    query = vi.fn((sql: string, params?: unknown[]) => {
      this.queries.push({ sql, params: params ?? [] });
      return Promise.resolve({ rows: [] });
    });
    end = vi.fn().mockResolvedValue(undefined);
  }
  return { Pool: MockPool };
});

describe("Canonical session key", () => {
  it("produces synesis:{userId}:{clientKind}:{conversationId} format", async () => {
    const { buildSessionKey } = await import("../src/session/session-key.js");
    const key = buildSessionKey("alice", "claude-code", "conv-123");
    expect(key).toBe("synesis:alice:claude-code:conv-123");
  });

  it("uses _ in the base key for missing conversation ID", async () => {
    const { buildSessionKey } = await import("../src/session/session-key.js");
    const key = buildSessionKey("alice", "cursor", "");
    expect(key).toBe("synesis:alice:cursor:_");
  });

  it("uses anon for missing userId", async () => {
    const { buildSessionKey } = await import("../src/session/session-key.js");
    const key = buildSessionKey("", "unknown", "");
    expect(key).toBe("synesis:anon:unknown:_");
  });

  it("mints a rotated key for a new implicit conversation", async () => {
    const { resolveSessionKey } = await import("../src/session/session-key.js");
    const activeByBaseKey = new Map<string, string>();
    const saved: Array<[string, string]> = [];
    const decision = await resolveSessionKey({
      identity: {
        userId: "alice",
        orgId: "",
        clientKind: "opencode",
        conversationId: "",
      },
      nowMs: 12345,
      inactivityRotationMs: 30 * 60 * 1000,
      activeByBaseKey,
      loadRecord: vi.fn().mockResolvedValue(null),
      loadActiveSessionKey: vi.fn().mockResolvedValue(null),
      saveActiveSessionKey: vi.fn((baseKey: string, sessionKey: string) => {
        saved.push([baseKey, sessionKey]);
        return Promise.resolve();
      }),
    });

    expect(decision.sessionKey).toBe("synesis:alice:opencode:_:r12345");
    expect(decision.reason).toBe("new_implicit_conversation");
    expect(activeByBaseKey.get("synesis:alice:opencode:_")).toBe(decision.sessionKey);
    expect(saved).toEqual([["synesis:alice:opencode:_", decision.sessionKey]]);
  });

  it("reuses an active implicit alias", async () => {
    const { resolveSessionKey } = await import("../src/session/session-key.js");
    const activeByBaseKey = new Map([["synesis:alice:opencode:_", "synesis:alice:opencode:_:r1000"]]);
    const decision = await resolveSessionKey({
      identity: {
        userId: "alice",
        orgId: "",
        clientKind: "opencode",
        conversationId: "",
      },
      nowMs: 2000,
      inactivityRotationMs: 30 * 60 * 1000,
      activeByBaseKey,
      loadRecord: vi.fn().mockResolvedValue({ sessionKey: "synesis:alice:opencode:_:r1000", lastActiveAt: 1500 }),
      loadActiveSessionKey: vi.fn().mockResolvedValue(null),
      saveActiveSessionKey: vi.fn().mockResolvedValue(undefined),
    });

    expect(decision.sessionKey).toBe("synesis:alice:opencode:_:r1000");
    expect(decision.reason).toBe("active_alias");
  });

  it("rotates an active implicit alias when the incoming coder transcript is fresh", async () => {
    const { resolveSessionKey } = await import("../src/session/session-key.js");
    const activeByBaseKey = new Map([["synesis:alice:opencode:_", "synesis:alice:opencode:_:r1000"]]);
    const saved: Array<[string, string]> = [];

    const decision = await resolveSessionKey({
      identity: {
        userId: "alice",
        orgId: "",
        clientKind: "opencode",
        conversationId: "",
        forceFreshImplicitSession: true,
        freshImplicitSessionReason: "fresh_transcript",
      },
      nowMs: 4000,
      inactivityRotationMs: 30 * 60 * 1000,
      activeByBaseKey,
      loadRecord: vi.fn().mockResolvedValue({ sessionKey: "synesis:alice:opencode:_:r1000", lastActiveAt: 3500 }),
      loadActiveSessionKey: vi.fn().mockResolvedValue(null),
      saveActiveSessionKey: vi.fn((baseKey: string, sessionKey: string) => {
        saved.push([baseKey, sessionKey]);
        return Promise.resolve();
      }),
    });

    expect(decision.sessionKey).toBe("synesis:alice:opencode:_:r4000");
    expect(decision.previousSessionKey).toBe("synesis:alice:opencode:_:r1000");
    expect(decision.reason).toBe("fresh_implicit_rotation");
    expect(activeByBaseKey.get("synesis:alice:opencode:_")).toBe(decision.sessionKey);
    expect(saved).toEqual([["synesis:alice:opencode:_", decision.sessionKey]]);
  });

  it("does not rotate explicit conversations even when fresh implicit is requested", async () => {
    const { resolveSessionKey } = await import("../src/session/session-key.js");
    const decision = await resolveSessionKey({
      identity: {
        userId: "alice",
        orgId: "",
        clientKind: "opencode",
        conversationId: "oc-session-1",
        forceFreshImplicitSession: true,
      },
      nowMs: 5000,
      inactivityRotationMs: 30 * 60 * 1000,
      activeByBaseKey: new Map(),
      loadRecord: vi.fn().mockResolvedValue(null),
      loadActiveSessionKey: vi.fn().mockResolvedValue(null),
      saveActiveSessionKey: vi.fn().mockResolvedValue(undefined),
    });

    expect(decision.sessionKey).toBe("synesis:alice:opencode:oc-session-1");
    expect(decision.reason).toBe("explicit_conversation");
    expect(decision.rotated).toBe(false);
  });

  it("does not reuse the bare legacy key for implicit conversations", async () => {
    const { resolveSessionKey } = await import("../src/session/session-key.js");
    const decision = await resolveSessionKey({
      identity: {
        userId: "alice",
        orgId: "",
        clientKind: "opencode",
        conversationId: "",
      },
      nowMs: 3000,
      inactivityRotationMs: 30 * 60 * 1000,
      activeByBaseKey: new Map(),
      loadRecord: vi.fn().mockImplementation((sessionKey: string) => Promise.resolve(
        sessionKey === "synesis:alice:opencode:_"
          ? { sessionKey, lastActiveAt: 2999 }
          : null,
      )),
      loadActiveSessionKey: vi.fn().mockResolvedValue(null),
      saveActiveSessionKey: vi.fn().mockResolvedValue(undefined),
    });

    expect(decision.sessionKey).toBe("synesis:alice:opencode:_:r3000");
    expect(decision.reason).toBe("new_implicit_conversation");
  });

  it("detects fresh implicit starts for coder clients and ignores empty assistant placeholders", async () => {
    const { detectFreshImplicitSessionStart } = await import("../src/session/session-key.js");

    expect(detectFreshImplicitSessionStart({
      clientKind: "codex-cli",
      conversationId: "",
      messages: [
        { role: "system", content: "Working directory: /repo" },
        { role: "assistant", content: "" },
        { role: "user", content: "Build this project" },
      ],
    })).toEqual({ fresh: true, reason: "fresh_transcript" });
  });

  it("does not detect fresh implicit starts for non-coder clients", async () => {
    const { detectFreshImplicitSessionStart } = await import("../src/session/session-key.js");

    expect(detectFreshImplicitSessionStart({
      clientKind: "openwebui",
      conversationId: "",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
      ],
    })).toEqual({ fresh: false, reason: "non_coder_client" });
  });

  it("resets OpenCode implicit sessions when a fresh transcript arrives over persisted state", async () => {
    const { shouldResetImplicitSessionForFreshTranscript } = await import("../src/session/session-key.js");

    expect(shouldResetImplicitSessionForFreshTranscript({
      clientKind: "opencode",
      conversationId: "",
      hasPersistedState: true,
      messages: [
        { role: "system" },
        { role: "user" },
      ],
    })).toBe(true);
  });

  it("keeps OpenCode implicit sessions when transcript history is present", async () => {
    const { shouldResetImplicitSessionForFreshTranscript } = await import("../src/session/session-key.js");

    expect(shouldResetImplicitSessionForFreshTranscript({
      clientKind: "opencode",
      conversationId: "",
      hasPersistedState: true,
      messages: [
        { role: "system" },
        { role: "user" },
        { role: "assistant" },
        { role: "tool" },
        { role: "user" },
      ],
    })).toBe(false);
  });

  it("does not reset explicit conversation sessions on fresh-looking transcripts", async () => {
    const { shouldResetImplicitSessionForFreshTranscript } = await import("../src/session/session-key.js");

    expect(shouldResetImplicitSessionForFreshTranscript({
      clientKind: "opencode",
      conversationId: "oc-session-1",
      hasPersistedState: true,
      messages: [
        { role: "system" },
        { role: "user" },
      ],
    })).toBe(false);
  });
});

describe("Fresh implicit session bootstrap", () => {
  async function makeLifecycle(overrides: { forceFreshImplicitSession?: boolean } = {}) {
    const { createSessionLifecycleHelpers } = await import("../src/state/session-lifecycle.js");
    const { SessionContinuityService } = await import("../src/context/session-continuity.js");

    const continuity = {
      currentTask: "Build the complete TaskPulse app",
      keyFindings: ["Prior run looked for categorizer.py"],
      decisions: [],
      recentFiles: ["categorizer.py", "src/test/taskpulse/app/main.py"],
      updatedAt: Date.now(),
    };
    const loadContinuity = vi.fn().mockResolvedValue(continuity);
    const loadLatestContinuity = vi.fn().mockResolvedValue(continuity);
    const recordSessionEvent = vi.fn();

    const helpers = createSessionLifecycleHelpers({
      config: {
        SYNESIS_YARN_SESSION_CONTINUITY_ENABLED: true,
        SYNESIS_YARN_SESSION_CARRY_FORWARD_BOOTSTRAP_ENABLED: true,
        SYNESIS_YARN_CROSS_CONVERSATION_RECALL_ENABLED: true,
        SYNESIS_YARN_RECALL_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
        SYNESIS_YARN_SESSION_INACTIVITY_ROTATION_MS: 30 * 60 * 1000,
      } as never,
      logger: { info: vi.fn(), warn: vi.fn() },
      sessions: new Map(),
      rotatedSessionByBaseKey: new Map(),
      sessionStore: {
        load: vi.fn().mockResolvedValue(null),
        loadSessionState: vi.fn().mockResolvedValue(null),
        loadContinuity,
        loadActiveSessionKey: vi.fn().mockResolvedValue(null),
        saveActiveSessionKey: vi.fn().mockResolvedValue(undefined),
      } as never,
      sessionContinuity: new SessionContinuityService(),
      usageWriter: { loadLatestContinuity } as never,
      tierRegistry: { getTierConfig: vi.fn() },
      sawtooth: {} as never,
      metrics: {
        compactionTotal: { inc: vi.fn() },
        sessionCheckpointTotal: { inc: vi.fn() },
        compactionCharsSaved: { inc: vi.fn() },
      },
      createDiffStats: () => ({}) as never,
      resetRecoveryCounters: vi.fn(),
      clearImplicitSessionResources: vi.fn(),
      getFileSnapshotRegistry: () => ({ markCompaction: vi.fn() }),
      getContentDedup: () => ({ reset: vi.fn() }),
      recordSessionEvent,
    });

    const state = await helpers.getSessionState("synesis:alice:opencode:_:r1", {
      userId: "alice",
      orgId: "",
      clientKind: "opencode",
      conversationId: "",
      forceFreshImplicitSession: overrides.forceFreshImplicitSession,
      freshImplicitSessionReason: "fresh_transcript",
      sessionRequestId: "req-1",
    });

    return { state, loadContinuity, loadLatestContinuity, recordSessionEvent };
  }

  it("suppresses carry-forward continuity for fresh implicit coder starts", async () => {
    const { state, loadContinuity, loadLatestContinuity, recordSessionEvent } = await makeLifecycle({
      forceFreshImplicitSession: true,
    });

    expect(state.history).toEqual([]);
    expect(loadContinuity).not.toHaveBeenCalled();
    expect(loadLatestContinuity).not.toHaveBeenCalled();
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "synesis:alice:opencode:_:r1",
      "alice",
      "",
      "session_carry_forward_suppressed",
      "getSessionState",
      expect.stringContaining("suppressed prior continuity bootstrap"),
      "req-1",
      expect.objectContaining({ fresh_reason: "fresh_transcript" }),
    );
  });

  it("keeps configured carry-forward bootstrap for non-fresh implicit sessions", async () => {
    const { state, loadContinuity, loadLatestContinuity } = await makeLifecycle();

    expect(loadContinuity).toHaveBeenCalledWith("alice");
    expect(loadLatestContinuity).toHaveBeenCalledWith("alice", 7 * 24 * 60 * 60 * 1000);
    expect(state.history.map((m) => m.content).join("\n")).toContain("<SESSION_CONTINUITY>");
    expect(state.history.map((m) => m.content).join("\n")).toContain("<SESSION_RECALL");
    expect(state.history.map((m) => m.content).join("\n")).toContain("categorizer.py");
  });
});

describe("Session isolation — two clients, same user", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("different conversation_ids produce different Redis keys", async () => {
    const { SessionStore } = await import("../src/state/session-store.js");
    const store = new SessionStore({ SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3" } as never);

    const base = {
      userId: "alice",
      orgId: "",
      clientKind: "claude-code",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalTokensCached: 0,
      requestCount: 0,
      escalationCount: 0,
      metadata: {},
      version: 0,
    };

    const record1 = { ...base, sessionKey: "synesis:alice:claude-code:conv-1", conversationId: "conv-1" };
    const record2 = { ...base, sessionKey: "synesis:alice:claude-code:conv-2", conversationId: "conv-2" };

    await store.save(record1);
    await store.save(record2);

    const loaded1 = await store.load("synesis:alice:claude-code:conv-1");
    const loaded2 = await store.load("synesis:alice:claude-code:conv-2");

    expect(loaded1).not.toBeNull();
    expect(loaded2).not.toBeNull();
    expect(loaded1!.sessionKey).not.toBe(loaded2!.sessionKey);
    expect(loaded1!.conversationId).toBe("conv-1");
    expect(loaded2!.conversationId).toBe("conv-2");

    await store.close();
  });

  it("different client_kinds produce different Redis keys", async () => {
    const { SessionStore } = await import("../src/state/session-store.js");
    const store = new SessionStore({ SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3" } as never);

    const base = {
      userId: "alice",
      orgId: "",
      conversationId: "_",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalTokensCached: 0,
      requestCount: 0,
      escalationCount: 0,
      metadata: {},
      version: 0,
    };

    const record1 = { ...base, sessionKey: "synesis:alice:claude-code:_", clientKind: "claude-code" };
    const record2 = { ...base, sessionKey: "synesis:alice:cursor:_", clientKind: "cursor" };

    await store.save(record1);
    await store.save(record2);

    const redis = (store as unknown as { redis: { eval: ReturnType<typeof vi.fn> } }).redis;
    const calls = redis.eval.mock.calls;
    const keys = calls.map((c: unknown[]) => c[2]);
    expect(keys).toContain("yarn-ts:session:synesis:alice:claude-code:_");
    expect(keys).toContain("yarn-ts:session:synesis:alice:cursor:_");

    await store.close();
  });

  it("persists active implicit session aliases in Redis", async () => {
    const { SessionStore } = await import("../src/state/session-store.js");
    const store = new SessionStore({ SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3" } as never);

    await store.saveActiveSessionKey("synesis:alice:opencode:_", "synesis:alice:opencode:_:r123");

    await expect(store.loadActiveSessionKey("synesis:alice:opencode:_")).resolves.toBe(
      "synesis:alice:opencode:_:r123",
    );

    await store.close();
  });
});

describe("Usage writer — session event inserts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enqueueSessionEvent flushes to yarn_session_events table", async () => {
    const { UsageWriter } = await import("../src/state/usage-writer.js");
    const writer = new UsageWriter({
      SYNESIS_YARN_ADMIN_DB_URL: "postgres://localhost/test",
      SYNESIS_YARN_PERSIST_USAGE_TO_DB: true,
      SYNESIS_YARN_DB_POOL_MAX: 5,
      SYNESIS_YARN_DB_POOL_IDLE_MS: 10000,
      SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: 1000,
      SYNESIS_YARN_WRITE_QUEUE_MAX: 100,
      SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS: 999999,
    } as never);

    writer.enqueueSessionEvent({
      sessionKey: "synesis:alice:claude-code:conv-1",
      requestId: `req-${crypto.randomUUID()}`,
      userId: "alice",
      orgId: "org1",
      eventKind: "upstream_error",
      component: "generateText",
      detail: "502 Bad Gateway",
    });

    await writer.flush();

    const pool = (writer as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
    const sql = pool.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("yarn_session_events");
    expect(sql).toContain("event_kind");
    expect(sql).toContain("component");

    const params = pool.query.mock.calls[0]?.[1] as unknown[];
    expect(params[0]).toBe("synesis:alice:claude-code:conv-1");
    expect(params[4]).toBe("upstream_error");
    expect(params[5]).toBe("generateText");

    const stats = writer.getStats();
    expect(stats.totalFlushed).toBe(1);

    await writer.close();
  });

  it("session upsert includes client_kind column", async () => {
    const { UsageWriter } = await import("../src/state/usage-writer.js");
    const writer = new UsageWriter({
      SYNESIS_YARN_ADMIN_DB_URL: "postgres://localhost/test",
      SYNESIS_YARN_PERSIST_USAGE_TO_DB: true,
      SYNESIS_YARN_DB_POOL_MAX: 5,
      SYNESIS_YARN_DB_POOL_IDLE_MS: 10000,
      SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: 1000,
      SYNESIS_YARN_WRITE_QUEUE_MAX: 100,
      SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS: 999999,
    } as never);

    writer.enqueueSessionUpsert({
      sessionKey: "synesis:alice:claude-code:conv-1",
      userId: "alice",
      orgId: "org1",
      conversationId: "conv-1",
      clientKind: "claude-code",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      totalTokensIn: 100,
      totalTokensOut: 50,
      totalTokensCached: 10,
      requestCount: 3,
      escalationCount: 0,
      metadata: { total_cost_usd: 0.05 },
      version: 1,
    });

    await writer.flush();

    const pool = (writer as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
    const sql = pool.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("client_kind");
    expect(sql).toContain("ON CONFLICT (session_key) DO UPDATE");

    const params = pool.query.mock.calls[0]?.[1] as unknown[];
    expect(params).toContain("claude-code");

    await writer.close();
  });
});

describe("Claude conversation ID resolution", () => {
  function resolveClaudeConversationId(
    metadata: Record<string, unknown> | undefined,
    headers: Record<string, unknown>,
  ): string {
    if (metadata) {
      for (const key of ["synesis_conversation_id", "conversation_id", "session_id"]) {
        const val = metadata[key];
        if (typeof val === "string" && val.trim()) return val.trim();
      }
    }
    for (const hdr of ["x-synesis-conversation-id"]) {
      const val = headers[hdr];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
    return "";
  }

  it("resolves from metadata.synesis_conversation_id first", () => {
    const id = resolveClaudeConversationId(
      { synesis_conversation_id: "conv-abc", conversation_id: "fallback" },
      {},
    );
    expect(id).toBe("conv-abc");
  });

  it("falls back to metadata.conversation_id", () => {
    const id = resolveClaudeConversationId({ conversation_id: "conv-def" }, {});
    expect(id).toBe("conv-def");
  });

  it("falls back to metadata.session_id", () => {
    const id = resolveClaudeConversationId({ session_id: "sess-xyz" }, {});
    expect(id).toBe("sess-xyz");
  });

  it("falls back to x-synesis-conversation-id header", () => {
    const id = resolveClaudeConversationId(undefined, { "x-synesis-conversation-id": "hdr-123" });
    expect(id).toBe("hdr-123");
  });

  it("returns empty string when nothing available", () => {
    const id = resolveClaudeConversationId(undefined, {});
    expect(id).toBe("");
  });

  it("trims whitespace", () => {
    const id = resolveClaudeConversationId({ synesis_conversation_id: "  conv-trim  " }, {});
    expect(id).toBe("conv-trim");
  });

  it("skips empty string values in metadata", () => {
    const id = resolveClaudeConversationId({ synesis_conversation_id: "", conversation_id: "real" }, {});
    expect(id).toBe("real");
  });
});
