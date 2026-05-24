import { describe, expect, it, vi } from "vitest";

import {
  createOpenAINonStreamCollapseRouteInput,
  createOpenAINonStreamDiscoveryRouteInput,
} from "../src/pipeline/openai-nonstream-route-postprocess-inputs.js";

describe("createOpenAINonStreamDiscoveryRouteInput", () => {
  it("packages route discovery recovery dependencies without runtime scope fields", async () => {
    const buildBlockedDiscoveryRecovery = vi.fn(async () => ({
      text: "recover",
      entryCount: 2,
      recoveryMode: "read_first",
    }));
    const recordBlockedDiscovery = vi.fn(() => 3);
    const getBlockedDiscoveryCount = vi.fn(() => 3);

    const input = createOpenAINonStreamDiscoveryRouteInput({
      projectRoot: "/repo",
      buildBlockedDiscoveryRecovery,
      recordBlockedDiscovery,
      getBlockedDiscoveryCount,
    });

    expect(input.projectRoot).toBe("/repo");
    await expect(input.buildBlockedDiscoveryRecovery("model", [], "/repo")).resolves.toEqual({
      text: "recover",
      entryCount: 2,
      recoveryMode: "read_first",
    });
    expect(input.recordBlockedDiscovery("session", 1)).toBe(3);
    expect(input.getBlockedDiscoveryCount("session")).toBe(3);
    expect("sessionKey" in input).toBe(false);
    expect("requestId" in input).toBe(false);
  });
});

describe("createOpenAINonStreamCollapseRouteInput", () => {
  it("resolves workspace root from route headers and preserves collapse settings", () => {
    const logger = { info: vi.fn() };

    const input = createOpenAINonStreamCollapseRouteInput({
      enabled: true,
      rewriteNonStream: true,
      collapseHeader: "apply",
      headers: { "x-synesis-project-root": "/repo" },
      bodyMetadata: null,
      shellAllowlistEnv: "ls,pwd",
      dedupeLayer: null,
      toolPrefixCache: null,
      logger,
      requestId: "req_1",
    });

    expect(input).toMatchObject({
      enabled: true,
      rewriteNonStream: true,
      collapseHeader: "apply",
      workspaceRoot: "/repo",
      shellAllowlistEnv: "ls,pwd",
      requestId: "req_1",
    });
    expect(input.logger).toBe(logger);
  });
});
