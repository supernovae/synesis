import { describe, expect, it, vi } from "vitest";
import { stabilizeOpenAITranscript } from "../src/pipeline/openai-route-transcript-stabilization.js";
import { FileSnapshotRegistry } from "../src/reduction/file-snapshot-registry.js";
import { OptimizationLedger } from "../src/telemetry/optimization-ledger.js";

function baseInput(overrides: Partial<Parameters<typeof stabilizeOpenAITranscript>[0]> = {}) {
  return {
    messages: [{ role: "user", content: "hello" }],
    originalMessageCount: 1,
    session: {
      lastIncomingMessageCount: 0,
      skipToolIdStabilization: false,
    },
    sessionKey: "session_1",
    identity: {
      userId: "user_1",
      orgId: "org_1",
    },
    requestId: "req_1",
    pathContext: {
      projectRoot: "/repo",
      shellCwd: "/repo",
    },
    governanceDisabled: false,
    debugProtocol: false,
    contentDedupeEnabled: false,
    responseDedupeEnabled: false,
    historicalNormalizeEnabled: false,
    compactionBackendModelHint: "model",
    yarnDedupeLayer: null,
    transcriptPruning: {
      computeKeepFromIndex: vi.fn(() => 0),
    },
    optimizationLedger: new OptimizationLedger(),
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    getFileSnapshotRegistry: vi.fn(() => new FileSnapshotRegistry()) as never,
    getContentDedup: vi.fn(() => ({
      reset: vi.fn(),
      processMessages: vi.fn((messages) => ({ messages, dedupCount: 0, dedupPaths: [] })),
      getStructuralIndex: vi.fn(() => null),
    })) as never,
    getMemoryGovernor: vi.fn(() => ({
      trackFileRead: vi.fn(),
      trackSummaryGenerated: vi.fn(),
    })),
    recordSessionEvent: vi.fn(),
    ...overrides,
  };
}

describe("stabilizeOpenAITranscript", () => {
  it("skips cache stabilization when governance is disabled but still normalizes snapshots", async () => {
    const contentDedup = {
      reset: vi.fn(),
      processMessages: vi.fn((messages) => ({ messages, dedupCount: 1, dedupPaths: ["/repo/a.ts"] })),
      getStructuralIndex: vi.fn(() => null),
    };
    const input = baseInput({
      governanceDisabled: true,
      contentDedupeEnabled: true,
      getContentDedup: vi.fn(() => contentDedup) as never,
    });

    const result = await stabilizeOpenAITranscript(input);

    expect(result.messages).toEqual(input.messages);
    expect(contentDedup.processMessages).not.toHaveBeenCalled();
  });

  it("wraps repeated tool responses through response dedupe and records ledger hits", async () => {
    const ledger = new OptimizationLedger();
    const responseDedupe = {
      wrapToolResult: vi.fn(() => "[deduped]"),
    };
    const input = baseInput({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", function: { name: "Read", arguments: "{\"file_path\":\"a.ts\"}" } }],
        },
        {
          role: "tool",
          name: "Read",
          tool_call_id: "call_1",
          content: "file content",
        },
      ],
      responseDedupeEnabled: true,
      yarnDedupeLayer: { responseDedupe } as never,
      optimizationLedger: ledger,
    });

    const result = await stabilizeOpenAITranscript(input);

    expect(result.responseDedupHits).toBe(1);
    expect(result.messages[1]).toMatchObject({ content: "[deduped]" });
    expect(responseDedupe.wrapToolResult).toHaveBeenCalledWith(
      "Read",
      { file_path: "a.ts" },
      expect.stringContaining("\"content\":\"file content\""),
    );
    expect(ledger.finalize().responseDedupHits).toBe(1);
  });

  it("resets stale dedupe state after external compaction", async () => {
    const dedup = {
      reset: vi.fn(),
      processMessages: vi.fn((messages) => ({ messages, dedupCount: 0, dedupPaths: [] })),
      getStructuralIndex: vi.fn(() => null),
    };
    const registry = {
      markCompaction: vi.fn(),
      canonicalizePath: (path: string) => path,
    };
    const recordSessionEvent = vi.fn();
    const session = {
      lastIncomingMessageCount: 10,
      skipToolIdStabilization: false,
    };
    await stabilizeOpenAITranscript(baseInput({
      originalMessageCount: 5,
      session,
      contentDedupeEnabled: true,
      getContentDedup: vi.fn(() => dedup) as never,
      getFileSnapshotRegistry: vi.fn(() => registry) as never,
      recordSessionEvent,
    }));

    expect(dedup.reset).toHaveBeenCalledOnce();
    expect(registry.markCompaction).toHaveBeenCalledWith("SUMMARY_ONLY");
    expect(session.lastIncomingMessageCount).toBe(5);
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "external_compaction_detected",
      "dedup_reset",
      "msgs 10 -> 5",
    );
  });
});
