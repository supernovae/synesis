import { describe, expect, it, vi } from "vitest";
import {
  createClaudeStreamComponents,
  createClaudeStreamRouteComponents,
} from "../src/streaming/claude-stream-components.js";

describe("createClaudeStreamComponents", () => {
  it("creates stream state, cache metadata, local endpoint marker, and prefix fingerprint", () => {
    const sendSse = vi.fn(() => true);
    const computePrefixFingerprint = vi.fn(() => "pfx_test");

    const components = createClaudeStreamComponents({
      modelMessages: [{ role: "user", content: "hello" }],
      tierConfig: {
        baseUrl: "http://localhost:8000/v1",
        backendModel: "deepseek-chat",
      },
      resolvedModelId: "model-a",
      computePrefixFingerprint,
      sendSse,
      recordSessionEvent: vi.fn(),
    });

    expect(components.streamState.rawStopReason()).toBe("end_turn");
    expect(components.gate).toEqual({
      applied: false,
      missingMust: 0,
      missingShould: 0,
      blockedVerification: false,
      criticBlocked: false,
    });
    expect(components.guardrailAccepted).toEqual([]);
    expect(components.blockedDetails).toEqual([]);
    expect(components.discovery).toEqual({
      recoveryPreviewEntries: 0,
      recoveryMode: null,
      blockedBroadDiscovery: 0,
      collapsedBroadDiscovery: 0,
    });
    expect(components.toolSequence).toEqual([]);
    expect(components.localLikeBaseUrl).toBe(true);
    expect(components.cacheStrategy).toBe("deepseek_auto");
    expect(components.prefixFingerprint).toBe("pfx_test");
    expect(computePrefixFingerprint).toHaveBeenCalledWith([{ role: "user", content: "hello" }]);
  });

  it("flushes a text block using Claude SSE content block events", () => {
    const sendSse = vi.fn(() => true);
    const components = createClaudeStreamComponents({
      modelMessages: [],
      resolvedModelId: "model-a",
      computePrefixFingerprint: () => undefined,
      sendSse,
      recordSessionEvent: vi.fn(),
    });

    components.flushTextBlock("hello");

    expect(sendSse).toHaveBeenNthCalledWith(1, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    expect(sendSse).toHaveBeenNthCalledWith(2, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    });
    expect(sendSse).toHaveBeenNthCalledWith(3, "content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });
    expect(components.streamState.currentBlockIndex()).toBe(1);
  });

  it("scrubs task-ledger governance text before flushing stream output", () => {
    const sendSse = vi.fn(() => true);
    const recordSessionEvent = vi.fn();
    const components = createClaudeStreamComponents({
      modelMessages: [],
      resolvedModelId: "model-a",
      computePrefixFingerprint: () => undefined,
      sendSse,
      recordSessionEvent,
    });

    components.scrubAndFlushTextBlock("ok\n\n<synesis_task_ledger>{\"tasks\":[]}</synesis_task_ledger>");

    expect(sendSse).toHaveBeenCalledWith("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    });
    expect(recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "task_ledger_output_scrubbed",
      component: "task-ledger",
      detail: "Removed internal task-ledger governance from streamed Claude output",
    });
  });

  it("closes an open text block and skips when no text block is open", () => {
    const sendSse = vi.fn(() => true);
    const components = createClaudeStreamComponents({
      modelMessages: [],
      resolvedModelId: "model-a",
      computePrefixFingerprint: () => undefined,
      sendSse,
      recordSessionEvent: vi.fn(),
    });

    components.closeTextBlock();
    expect(sendSse).not.toHaveBeenCalled();

    components.streamState.markTextBlockOpen();
    components.closeTextBlock();

    expect(sendSse).toHaveBeenCalledWith("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });
    expect(components.streamState.currentBlockIndex()).toBe(1);
  });

  it("creates route components with session-scoped task-ledger scrub event recording", () => {
    const sendSse = vi.fn(() => true);
    const recordSessionEvent = vi.fn();
    const components = createClaudeStreamRouteComponents({
      modelMessages: [{ role: "user", content: "hello" }],
      tierConfig: { baseUrl: "http://localhost:8000/v1" },
      resolvedModelId: "model-a",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      requestId: "req_1",
      computePrefixFingerprint: () => "pfx_1",
      sendSse,
      recordSessionEvent,
    });

    components.scrubAndFlushTextBlock("ok\n\n<synesis_task_ledger>{\"tasks\":[]}</synesis_task_ledger>");

    expect(components.prefixFingerprint).toBe("pfx_1");
    expect(sendSse).toHaveBeenCalledWith("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    });
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "task_ledger_output_scrubbed",
      "task-ledger",
      "Removed internal task-ledger governance from streamed Claude output",
      "req_1",
    );
  });
});
