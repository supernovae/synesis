import { describe, expect, it } from "vitest";
import { buildRouteGovernanceBlocks } from "../src/pipeline/route-governance-blocks.js";
import { MemoryGovernorTracker } from "../src/memory/governor-integration.js";
import type { ClientToolCapabilities } from "../src/adapters/client-tool-capabilities.js";

function capabilities(overrides: Partial<ClientToolCapabilities> = {}): ClientToolCapabilities {
  return {
    clientKind: "opencode",
    toolNames: ["todowrite", "question"],
    isOpenCode: true,
    isClaudeCode: false,
    planModeRequested: false,
    hasTodoTool: true,
    todoToolName: "todowrite",
    taskToolNames: [],
    hasQuestionTool: true,
    questionToolName: "question",
    hasApplyPatchTool: false,
    applyPatchToolName: null,
    hasAgentTool: false,
    hasMonitorTool: false,
    hasPlanModeTool: false,
    enterPlanModeToolName: null,
    exitPlanModeToolName: null,
    hasLspTool: false,
    hasSkillTool: false,
    hasWebFetchTool: false,
    hasWebSearchTool: false,
    ...overrides,
  };
}

describe("route governance block assembly", () => {
  it("assembles route governance blocks in stable order", () => {
    const memoryTracker = new MemoryGovernorTracker();

    const result = buildRouteGovernanceBlocks({
      memoryTracker,
      structuralIndex: { getStats: () => ({ fileCount: 2 }) },
      sessionMemoryCount: 4,
      clientToolCapabilities: capabilities(),
      relevantEvidenceBlock: "<EVIDENCE />",
      artifactBridgeBlock: "<ARTIFACT />",
      stateConfidenceBlock: "<STATE />",
      freshImplicitSessionNotice: "<SESSION />",
      governorPauseResumeBlock: "<PAUSE />",
      plannerTodoPacketBlock: "<TODO />",
    });

    expect(result.blocks).toEqual([
      "<EVIDENCE />",
      "<ARTIFACT />",
      "<STATE />",
      result.clientToolBlock,
      "<SESSION />",
      "<PAUSE />",
      "<TODO />",
    ]);
    expect(result.clientToolBlock).toContain("todowrite");
    expect(result.memoryBlocks).toEqual([]);
    expect(result.taskLedgerBlock).toBeNull();
    expect(memoryTracker.getSignals()).toMatchObject({
      structuralIndexAvailable: true,
      findingsStoreSize: 4,
    });
  });

  it("adds memory guidance blocks when memory rules fire", () => {
    const memoryTracker = new MemoryGovernorTracker();
    memoryTracker.trackSummaryGenerated("a.ts");
    memoryTracker.trackFileRead("a.ts");
    memoryTracker.trackFileRead("a.ts");
    memoryTracker.trackFileRead("a.ts");
    memoryTracker.trackUnstoreFinding();
    memoryTracker.trackUnstoreFinding();
    memoryTracker.trackUnstoreFinding();

    const result = buildRouteGovernanceBlocks({
      memoryTracker,
      sessionMemoryCount: 0,
      clientToolCapabilities: capabilities({ hasTodoTool: false, todoToolName: null, toolNames: [] }),
    });

    expect(result.memoryBlocks).toHaveLength(2);
    expect(result.memoryBlocks.join("\n")).toContain('rule="reread_with_summary"');
    expect(result.memoryBlocks.join("\n")).toContain('rule="findings_not_stored"');
    expect(result.blocks[0]).toContain("MEMORY_GUIDANCE");
  });

  it("carries plan implementation approval as route guidance for non-Claude harnesses", () => {
    const memoryTracker = new MemoryGovernorTracker();
    const result = buildRouteGovernanceBlocks({
      memoryTracker,
      sessionMemoryCount: 0,
      clientToolCapabilities: capabilities({
        clientKind: "opencode",
        planModeRequested: false,
        planImplementationApproved: true,
      }),
    });

    expect(result.clientToolBlock).toContain("plan_implementation_approved: true");
    expect(result.clientToolBlock).toContain("start or continue implementation");
    expect(result.clientToolBlock).toContain("do not ask whether to proceed again");
    expect(result.clientToolBlock).toContain("stale earlier plan-mode reminders");
  });
});
