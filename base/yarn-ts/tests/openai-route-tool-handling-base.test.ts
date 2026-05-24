import { describe, expect, it, vi } from "vitest";

import { createOpenAIChatRouteToolHandlingBase } from "../src/pipeline/openai-route-tool-handling-base.js";

describe("createOpenAIChatRouteToolHandlingBase", () => {
  it("keeps common OpenAI stream and non-stream tool handling fields together", () => {
    const session = {
      gitInspectionBlockCount: 0,
      blockBroadVerificationUntilEdit: false,
      blockFailingVerificationUntilEdit: false,
      artifactEditTurns: new Map<string, number>(),
      record: { metadata: {}, requestCount: 1 },
    };
    const isWriteCapableToolName = vi.fn(() => true);
    const shouldRestrictDiscoveryForPlanWork = vi.fn(() => false);
    const deserializePlanShadow = vi.fn(() => null);
    const buildPathSandboxPolicy = vi.fn(() => ({ root: "/repo" }) as never);

    const base = createOpenAIChatRouteToolHandlingBase({
      adapter: { family: "test" } as never,
      clientKind: "opencode",
      effectiveTools: [{ type: "function", function: { name: "Read" } }],
      strictGovernance: true,
      upperHarness: { surface: "openai", modelId: "model" },
      recentToolNames: ["Read"],
      taskCue: "fix it",
      planModeRequested: true,
      sensemakingRestrictDiscovery: false,
      pathContext: { projectRoot: "/repo", shellCwd: "/repo" },
      enforcePathRoot: true,
      blockBashPathDrift: true,
      pathSandboxEnabled: true,
      artifactShadows: new Map(),
      normalizedMessageCount: 12,
      session,
      stats: {} as never,
      logger: { warn: vi.fn(), info: vi.fn() },
      isWriteCapableToolName,
      shouldRestrictDiscoveryForPlanWork,
      deserializePlanShadow,
      buildPathSandboxPolicy,
    });

    expect(base).toMatchObject({
      clientKind: "opencode",
      strictGovernance: true,
      recentToolNames: ["Read"],
      planModeRequested: true,
      pathContext: { projectRoot: "/repo", shellCwd: "/repo" },
      enforcePathRoot: true,
      blockBashPathDrift: true,
      pathSandboxEnabled: true,
      normalizedMessageCount: 12,
      session,
    });
    expect(base.isWriteCapableToolName("Edit")).toBe(true);
    expect(base.shouldRestrictDiscoveryForPlanWork("fix")).toBe(false);
    expect(base.deserializePlanShadow({})).toBeNull();
    expect(base.buildPathSandboxPolicy("/repo")).toEqual({ root: "/repo" });
  });
});
