import { describe, expect, it, vi } from "vitest";
import {
  isGitInspectionChurnBlock,
  recordAdapterToolRepairObservations,
  recordGovernedToolHardeningStats,
  type ToolArgHardeningStats,
} from "../src/governance/tool-call-observability.js";
import type { AdapterToolHardeningResult } from "../src/governance/tool-call-governor-service.js";
import type { GovernedToolCall } from "../src/path-governance/tool-call-governance.js";

function stats(): ToolArgHardeningStats {
  return {
    normalizedPathCount: 0,
    projectRootConstrainedCount: 0,
    envelopeUnwrappedCount: 0,
    envelopeUnwrappedArgsObjectCount: 0,
    envelopeUnwrappedArgsJsonStringCount: 0,
    envelopeUnwrappedArgumentsObjectCount: 0,
    envelopeUnwrappedArgumentsJsonStringCount: 0,
    envelopeUnwrappedInputObjectCount: 0,
    envelopeUnwrappedInputJsonStringCount: 0,
    blockedBashPathDriftCount: 0,
    blockedUnsafeShellCount: 0,
    blockedWriteCapableToolCount: 0,
    remappedArgsCount: 0,
    repairedWriteContentCount: 0,
    repairedWriteCount: 0,
    repairedBashCount: 0,
    validationFailedCount: 0,
    qwenParserMismatchSuspectCount: 0,
  };
}

function hardening(overrides: Partial<AdapterToolHardeningResult>): AdapterToolHardeningResult {
  return {
    toolName: "Bash",
    input: {},
    remapped: false,
    repairedWriteContent: false,
    repairedWrite: false,
    repairedBash: false,
    upperHarnessRepaired: false,
    upperHarnessBlocked: false,
    ...overrides,
  };
}

function governed(overrides: Partial<GovernedToolCall>): GovernedToolCall {
  return {
    toolName: "Bash",
    input: {},
    normalizedPath: false,
    constrainedToRoot: false,
    envelopeUnwrapped: false,
    envelopeSource: null,
    blockedUnsafeShell: false,
    blockedWriteCapable: false,
    blockedBashDrift: false,
    validationMissing: [],
    ...overrides,
  };
}

describe("tool call observability", () => {
  it("records adapter repair counters and warning logs", () => {
    const s = stats();
    const logger = { warn: vi.fn() };

    const result = recordAdapterToolRepairObservations({
      stats: s,
      hardening: hardening({
        remapped: true,
        repairedWriteContent: true,
        repairedWrite: true,
        repairedBash: true,
        toolName: "Bash",
      }),
      logger,
      requestId: "req1",
      originalToolName: "Write",
      originalInput: { file_path: "README.md" },
    });

    expect(result.repairCountDelta).toBe(3);
    expect(s).toMatchObject({
      remappedArgsCount: 1,
      repairedWriteContentCount: 1,
      repairedWriteCount: 1,
      repairedBashCount: 1,
    });
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reqId: "req1", originalTool: "Write", filePath: "README.md" }),
      "write_tool_content_array_repaired",
    );
  });

  it("records governed hardening counters by envelope source", () => {
    const s = stats();

    recordGovernedToolHardeningStats(s, governed({
      normalizedPath: true,
      constrainedToRoot: true,
      envelopeUnwrapped: true,
      envelopeSource: "arguments_json_string",
      blockedUnsafeShell: true,
      blockedWriteCapable: true,
      blockedBashDrift: true,
      validationMissing: ["command"],
    }));

    expect(s).toMatchObject({
      normalizedPathCount: 1,
      projectRootConstrainedCount: 1,
      envelopeUnwrappedCount: 1,
      envelopeUnwrappedArgumentsJsonStringCount: 1,
      blockedUnsafeShellCount: 1,
      blockedWriteCapableToolCount: 1,
      blockedBashPathDriftCount: 1,
      validationFailedCount: 1,
    });
  });

  it("detects git inspection churn blocks", () => {
    expect(isGitInspectionChurnBlock(governed({
      blockedUnsafeShell: true,
      input: { command: "printf git_inspection_churn" },
    }))).toBe(true);
    expect(isGitInspectionChurnBlock(governed({
      blockedUnsafeShell: false,
      input: { command: "printf git_inspection_churn" },
    }))).toBe(false);
  });
});
